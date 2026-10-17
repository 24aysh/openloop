import type pg from "pg";
import { databaseTimestampSchema, prioritySchema, uuidSchema, versionSchema, type Timestamp, type UUID } from "../contracts";
import { lockMindState } from "../mind/writer";
import { logOperational, safeErrorCode } from "../operational-log";

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

async function emitOne(client: pg.PoolClient, row: LogRow, sink:TerminalSink, at:Date): Promise<"emitted"|"canceled"> {
  let event:TerminalEvent|null=null;
  await client.query("BEGIN");
  try {
    await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await lockMindState(client, uuidSchema.parse(row.user_id));
    const current = await client.query<{ emitted_at: Date | null; canceled_at: Date | null; status:string; current_schedule_version:string }>(
      `SELECT l.emitted_at,l.canceled_at,c.status,c.schedule_version AS current_schedule_version
        FROM commitment_logs l JOIN commitments c ON c.user_id=l.user_id AND c.id=l.commitment_id
        WHERE l.user_id=$1 AND l.id=$2 FOR UPDATE OF l,c`,
      [row.user_id, row.id],
    );
    const found = current.rows[0];
    if (!found || found.emitted_at !== null || found.canceled_at !== null) {await client.query("COMMIT");return "canceled";}
    if(found.status!=="open" || found.current_schedule_version!==row.schedule_version){
      await client.query("UPDATE commitment_logs SET canceled_at=clock_timestamp() WHERE user_id=$1 AND id=$2",[row.user_id,row.id]);
      await client.query("COMMIT");return "canceled";
    }
    event=terminalEvent(row,at);
    await client.query("UPDATE commitment_logs SET emitted_at=clock_timestamp(),last_error_code=NULL WHERE user_id=$1 AND id=$2", [row.user_id, row.id]);
    await client.query("INSERT INTO notification_events(user_id,commitment_log_id) VALUES($1,$2) ON CONFLICT (commitment_log_id) DO NOTHING",[row.user_id,row.id]);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
    throw error;
  }
  if(event===null)throw new Error("Durable commitment event was not created");
  try{await sink.emit(event);}
  catch(error){logOperational("scheduling","terminal_write_failed",{logId:event.logId,code:safeErrorCode(error)});}
  return "emitted";
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
            emit_available_at,batch_id,batch_position FROM commitment_logs WHERE emitted_at IS NULL AND canceled_at IS NULL
            ORDER BY eligible_at,batch_id,batch_position,id LIMIT 1`);
          const row = pending.rows[0];
          if (!row) break;
          const clock = await client.query<{ attempted_at: Date }>("SELECT clock_timestamp() AS attempted_at");
          const attemptedAt = clock.rows[0]?.attempted_at;
          if (!(attemptedAt instanceof Date)) throw new Error("Database clock unavailable");
          if (row.emit_available_at > attemptedAt) break;
          const outcome=await emitOne(client,row,this.sink,attemptedAt);
          if(outcome==="emitted")emitted++;
        }
      }
      const count = await client.query<{ remaining: string }>("SELECT count(*)::text AS remaining FROM commitment_logs WHERE emitted_at IS NULL AND canceled_at IS NULL");
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
