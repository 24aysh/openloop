import type pg from "pg";
import { databaseTimestampSchema, prioritySchema, uuidSchema, versionSchema, type Timestamp, type UUID } from "../contracts";
import { lockMindState } from "../mind/writer";

type LogRow = {
  id: string;
  user_id: string;
  commitment_id: string;
  commitment_version: string;
  schedule_version: string;
  priority: number;
  due_at: Date;
  eligible_at: Date;
  emit_available_at: Date;
  batch_id: string;
  batch_position: number;
};

export type TerminalEvent = Readonly<{
  event: "commitment_due";
  logId: UUID;
  commitmentId: UUID;
  commitmentVersion: ReturnType<typeof versionSchema.parse>;
  scheduleVersion: ReturnType<typeof versionSchema.parse>;
  priority: 1 | 2 | 3;
  dueAt: Timestamp;
  lateByMs: number;
  batchId: UUID;
  batchPosition: number;
}>;

export interface TerminalSink {
  emit(event: TerminalEvent): Promise<void>;
}

export class StdoutTerminalSink implements TerminalSink {
  async emit(event: TerminalEvent): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(event)}\n`, error => error ? reject(error) : resolve());
    });
  }
}

const emitterLock = [776501, 6];

function terminalEvent(row: LogRow, at: Date): TerminalEvent {
  return {
    event: "commitment_due",
    logId: uuidSchema.parse(row.id), commitmentId: uuidSchema.parse(row.commitment_id),
    commitmentVersion: versionSchema.parse(row.commitment_version), scheduleVersion: versionSchema.parse(row.schedule_version),
    priority: prioritySchema.parse(row.priority), dueAt: databaseTimestampSchema.parse(row.due_at),
    lateByMs: Math.max(0, at.getTime() - row.due_at.getTime()),
    batchId: uuidSchema.parse(row.batch_id), batchPosition: row.batch_position,
  };
}

async function updateAfterAttempt(client: pg.PoolClient, row: LogRow, success: boolean): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await lockMindState(client, uuidSchema.parse(row.user_id));
    const current = await client.query<{ emitted_at: Date | null; emit_attempts: number }>(
      "SELECT emitted_at,emit_attempts FROM commitment_logs WHERE user_id=$1 AND id=$2 FOR UPDATE",
      [row.user_id, row.id],
    );
    const found = current.rows[0];
    if (!found || found.emitted_at !== null) throw new Error("Commitment log changed during emission");
    if (success) {
      await client.query("UPDATE commitment_logs SET emitted_at=clock_timestamp(),last_error_code=NULL WHERE user_id=$1 AND id=$2", [row.user_id, row.id]);
    } else {
      const attempts = found.emit_attempts + 1;
      const delay = Math.min(60, 5 * 2 ** Math.min(attempts - 1, 4));
      await client.query(`UPDATE commitment_logs SET emit_attempts=$3,last_error_code='terminal_write_failed',
        emit_available_at=clock_timestamp()+($4::integer * interval '1 second') WHERE user_id=$1 AND id=$2`,
      [row.user_id, row.id, attempts, delay]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
}

export class CommitmentLogEmitter {
  constructor(private readonly pool: pg.Pool, private readonly sink: TerminalSink) {}

  async flush(): Promise<{ emitted: number; remaining: number }> {
    const client = await this.pool.connect();
    let acquired = false;
    let emitted = 0;
    let outcome: { emitted: number; remaining: number } | null = null;
    let operationError: unknown = null;
    try {
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1,$2) AS locked", emitterLock);
      acquired = lock.rows[0]?.locked === true;
      if (acquired) {
        while (true) {
          const pending = await client.query<LogRow>(`SELECT id,user_id,commitment_id,commitment_version,schedule_version,priority,due_at,eligible_at,
            emit_available_at,batch_id,batch_position FROM commitment_logs WHERE emitted_at IS NULL
            ORDER BY eligible_at,batch_id,batch_position,id LIMIT 1`);
          const row = pending.rows[0];
          if (!row) break;
          const clock = await client.query<{ attempted_at: Date }>("SELECT clock_timestamp() AS attempted_at");
          const attemptedAt = clock.rows[0]?.attempted_at;
          if (!(attemptedAt instanceof Date)) throw new Error("Database clock unavailable");
          if (row.emit_available_at > attemptedAt) break;
          let success = false;
          try { await this.sink.emit(terminalEvent(row, attemptedAt)); success = true; }
          catch { /* the durable row records this attempt without private exception text */ }
          await updateAfterAttempt(client, row, success);
          if (!success) break;
          emitted++;
        }
      }
      const count = await client.query<{ remaining: string }>("SELECT count(*)::text AS remaining FROM commitment_logs WHERE emitted_at IS NULL");
      outcome = { emitted, remaining: Number(count.rows[0]?.remaining ?? "0") };
    } catch (error) {
      operationError = error;
    }
    let unlockError: unknown = null;
    try {
      if (acquired) await client.query("SELECT pg_advisory_unlock($1,$2)", emitterLock);
    } catch (error) { unlockError = error; }
    client.release(unlockError !== null);
    if (operationError !== null) throw operationError;
    if (unlockError !== null) throw unlockError;
    if (outcome === null) throw new Error("Commitment emission did not produce a result");
    return outcome;
  }
}
