import type pg from "pg";
import { uuidSchema, type UUID } from "../contracts";
import { withTransaction } from "../db/transaction";
import { lockMindState } from "../mind/writer";

type DueRow = {
  id: string;
  user_id: string;
  title: string;
  priority: number;
  due_at: Date;
  created_at: Date;
  version: string;
  schedule_version: string;
};

const schedulerLock = [776501, 5];

export class CommitmentScheduler {
  constructor(private readonly pool: pg.Pool) {}

  async tick(): Promise<{ createdLogIds: UUID[] }> {
    return withTransaction(this.pool, { isolation: "read committed" }, async client => {
      const acquired = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock($1,$2) AS locked", schedulerLock,
      );
      if (!acquired.rows[0]?.locked) return { createdLogIds: [] };

      const candidates = await client.query<{ user_id: string }>(`
        SELECT DISTINCT c.user_id FROM commitments c
        WHERE c.status='open' AND c.due_at IS NOT NULL AND c.due_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM commitment_logs l WHERE l.commitment_id=c.id AND l.schedule_version=c.schedule_version)
        ORDER BY c.user_id`);
      const userIds = candidates.rows.map(row => uuidSchema.parse(row.user_id));
      if (userIds.length === 0) return { createdLogIds: [] };
      for (const userId of userIds) await lockMindState(client, userId);

      const locked = await client.query<DueRow>(`
        SELECT c.id,c.user_id,c.title,c.priority,c.due_at,c.created_at,c.version,c.schedule_version
        FROM commitments c
        WHERE c.user_id=ANY($1::uuid[]) AND c.status='open' AND c.due_at IS NOT NULL
          AND c.due_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM commitment_logs l WHERE l.commitment_id=c.id AND l.schedule_version=c.schedule_version)
        ORDER BY c.id FOR UPDATE OF c`, [userIds]);
      const clock = await client.query<{ tick_time: Date }>("SELECT clock_timestamp() AS tick_time");
      const tickTime = clock.rows[0]?.tick_time;
      if (!(tickTime instanceof Date)) throw new Error("Database clock unavailable");
      if (locked.rows.length === 0) return { createdLogIds: [] };
      const due = await client.query<DueRow>(`
        SELECT id,user_id,title,priority,due_at,created_at,version,schedule_version FROM commitments
        WHERE id=ANY($1::uuid[]) AND due_at <= $2
        ORDER BY priority,due_at,created_at,id`, [locked.rows.map(row => row.id), tickTime]);
      if (due.rows.length === 0) return { createdLogIds: [] };

      const batchId = uuidSchema.parse(crypto.randomUUID());
      const createdLogIds: UUID[] = [];
      for (const [index, row] of due.rows.entries()) {
        const id = uuidSchema.parse(crypto.randomUUID());
        await client.query(`
          INSERT INTO commitment_logs(id,user_id,commitment_id,schedule_version,commitment_version,due_at,eligible_at,
            priority,title_snapshot,batch_id,batch_position,emit_available_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$7)`,
        [id, row.user_id, row.id, row.schedule_version, row.version, row.due_at, tickTime,
          row.priority, row.title, batchId, index + 1]);
        createdLogIds.push(id);
      }
      return { createdLogIds };
    });
  }
}
