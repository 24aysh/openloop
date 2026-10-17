import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type pg from "pg";
import { timestampSchema, uuidSchema, versionSchema, type Commitment, type UUID } from "../../src/contracts";
import { MindWriter } from "../../src/mind";
import { commitmentFromRow, COMMITMENT_COLUMNS } from "../../src/mind/rows";
import { CommitmentLogEmitter, CommitmentScheduler, startSchedulingLoop, type TerminalEvent, type TerminalSink } from "../../src/scheduling";
import { clearTestDatabase, createTestPool, prepareTestDatabase } from "../helpers/database";
import { otherUserId, seedCommitment, seedUser, userId } from "../helpers/factories";
import { NotificationFeed } from "../../src/notifications/feed";

let pool: pg.Pool;
let scheduler: CommitmentScheduler;
let writer: MindWriter;
beforeAll(async () => { pool = createTestPool(); await prepareTestDatabase(pool); scheduler = new CommitmentScheduler(pool); writer = new MindWriter(pool); });
beforeEach(async () => { await clearTestDatabase(pool); });
afterAll(async () => { await pool?.end(); });

async function databaseTime(): Promise<Date> {
  const result = await pool.query<{ current_time: Date }>("SELECT clock_timestamp() AS current_time");
  const value = result.rows[0]?.current_time;
  if (!(value instanceof Date)) throw new Error("Database clock unavailable");
  return value;
}

async function createCommitment(input: { owner?: UUID; id?: UUID; title?: string; status?: "open" | "completed" | "dismissed";
  priority?: 1 | 2 | 3; dueAt?: Date | null; createdAt?: Date | string }): Promise<Commitment> {
  const id = input.id ?? uuidSchema.parse(crypto.randomUUID());
  const owner = input.owner ?? userId;
  const dueAt = input.dueAt ?? null;
  const status = input.status ?? "open";
  const clock = await databaseTime();
  const row = await pool.query(`INSERT INTO commitments(id,user_id,title,subject,status,priority,due_at,due_timezone,due_text,due_precision,
    created_at,updated_at,completed_at,dismissed_at)
    VALUES($1,$2,$3,'Ananya',$4,$5,$6,$7,$8,$9,$10,$10,$11,$12) RETURNING ${COMMITMENT_COLUMNS}`,
  [id, owner, input.title ?? "Send presentation", status, input.priority ?? 2, dueAt,
    dueAt ? "Asia/Kolkata" : null, dueAt ? "explicit due time" : null, dueAt ? "instant" : "none",
    input.createdAt ?? clock, status === "completed" ? clock : null, status === "dismissed" ? clock : null]);
  const record = commitmentFromRow(row.rows[0] ?? {});
  await pool.query(`INSERT INTO mind_changes(id,user_id,commitment_id,entity_version,operation,actor,after_state)
    VALUES($1,$2,$3,1,'create','user',$4::jsonb)`, [crypto.randomUUID(), owner, id, JSON.stringify(record)]);
  return record;
}

type TestLogRow = { id: string; user_id: string; commitment_id: string; commitment_version: string; schedule_version: string;
  due_at: Date; eligible_at: Date; priority: number; title_snapshot: string; batch_id: string; batch_position: number;
  emitted_at: Date | null; emit_attempts: number; emit_available_at: Date; last_error_code: string | null };

async function readLogs(): Promise<TestLogRow[]> {
  const result = await pool.query<TestLogRow>(`SELECT id,user_id,commitment_id,commitment_version,schedule_version,due_at,eligible_at,priority,
    title_snapshot,batch_id,batch_position,emitted_at,emit_attempts,emit_available_at,last_error_code
    FROM commitment_logs ORDER BY eligible_at,batch_id,batch_position,id`);
  return result.rows;
}

describe("durable scheduling decision", () => {
  test("logs only open, resolved commitments at or after their due instant", async () => {
    await seedUser(pool);
    const now = await databaseTime();
    const past = await createCommitment({ dueAt: new Date(now.getTime() - 60_000) });
    await createCommitment({ dueAt: new Date(now.getTime() + 60_000) });
    await createCommitment({ dueAt: null });
    await createCommitment({ dueAt: new Date(now.getTime() - 60_000), status: "completed" });
    await createCommitment({ dueAt: new Date(now.getTime() - 60_000), status: "dismissed" });
    expect((await scheduler.tick()).createdLogIds).toHaveLength(1);
    const rows = await readLogs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.commitment_id).toBe(past.id);
    expect(rows[0]?.eligible_at.getTime()).toBeGreaterThanOrEqual(new Date(past.dueAt ?? "").getTime());
    expect((await scheduler.tick()).createdLogIds).toHaveLength(0);
    expect((await pool.query("SELECT revision FROM mind_state WHERE user_id=$1", [userId])).rows[0]?.revision).toBe("0");
    expect((await pool.query("SELECT status FROM commitments WHERE id=$1", [past.id])).rows[0]?.status).toBe("open");
  });

  test("orders all eligible work by priority, due time, creation time, and ID", async () => {
    await seedUser(pool);
    await seedUser(pool, otherUserId);
    const now = await databaseTime();
    const early = new Date(now.getTime() - 120_000);
    const later = new Date(now.getTime() - 60_000);
    const created = new Date(now.getTime() - 300_000);
    const low = await createCommitment({ priority: 3, dueAt: early });
    const normal = await createCommitment({ priority: 2, dueAt: early });
    const highLater = await createCommitment({ priority: 1, dueAt: later });
    const highEarlyA = await createCommitment({ owner: otherUserId, id: uuidSchema.parse("00000000-0000-4000-8000-0000000000a1"), priority: 1, dueAt: early, createdAt: created });
    const highEarlyB = await createCommitment({ id: uuidSchema.parse("00000000-0000-4000-8000-0000000000a2"), priority: 1, dueAt: early, createdAt: created });
    await createCommitment({ priority: 1, dueAt: new Date(now.getTime() + 120_000) });
    expect((await scheduler.tick()).createdLogIds).toHaveLength(5);
    const rows = await readLogs();
    expect(rows.map(row => row.commitment_id)).toEqual([highEarlyA.id, highEarlyB.id, highLater.id, normal.id, low.id]);
    expect(rows.map(row => row.batch_position)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(rows.map(row => row.batch_id)).size).toBe(1);
  });

  test("uses PostgreSQL timestamp precision to break creation-time ties", async () => {
    await seedUser(pool);
    const due = new Date((await databaseTime()).getTime() - 60_000);
    const earlier = await createCommitment({ id: uuidSchema.parse("00000000-0000-4000-8000-0000000000a2"), dueAt: due,
      createdAt: "2026-01-01T00:00:00.000100Z" });
    const later = await createCommitment({ id: uuidSchema.parse("00000000-0000-4000-8000-0000000000a1"), dueAt: due,
      createdAt: "2026-01-01T00:00:00.000900Z" });
    await scheduler.tick();
    expect((await readLogs()).map(row => row.commitment_id)).toEqual([earlier.id, later.id]);
  });

  test("concurrent ticks decide once and revisions follow due edits and reopening", async () => {
    await seedUser(pool);
    const past = new Date((await databaseTime()).getTime() - 60_000);
    const initial = await seedCommitment(pool, undefined, userId, past.toISOString());
    const outcomes = await Promise.all([scheduler.tick(), new CommitmentScheduler(pool).tick()]);
    expect(outcomes.flatMap(value => value.createdLogIds)).toHaveLength(1);
    const renamed = await writer.editCommitment({ userId }, initial.id, { expectedVersion: initial.version, title: "Send revised presentation", priority: 1 });
    expect(renamed.scheduleVersion).toBe(initial.scheduleVersion);
    expect((await scheduler.tick()).createdLogIds).toHaveLength(0);
    const completed = await writer.editCommitment({ userId }, initial.id, { expectedVersion: renamed.version, status: "completed" });
    expect((await scheduler.tick()).createdLogIds).toHaveLength(0);
    const reopened = await writer.editCommitment({ userId }, initial.id, { expectedVersion: completed.version, status: "open" });
    expect(reopened.scheduleVersion).toBe(versionSchema.parse("2"));
    expect((await scheduler.tick()).createdLogIds).toHaveLength(1);
    const moved = await writer.editCommitment({ userId }, initial.id, { expectedVersion: reopened.version,
      dueAt: timestampSchema.parse(new Date(past.getTime() - 30_000).toISOString()) });
    expect(moved.scheduleVersion).toBe(versionSchema.parse("3"));
    expect((await scheduler.tick()).createdLogIds).toHaveLength(1);
    const rows = await readLogs();
    expect(rows.map(row => row.schedule_version)).toEqual(["1", "2", "3"]);
    expect(rows.map(row => row.commitment_version)).toEqual(["1", reopened.version, moved.version]);
    expect(rows[0]?.title_snapshot).toBe("Send presentation");
    expect(rows[1]?.title_snapshot).toBe("Send revised presentation");
    expect((await pool.query("SELECT count(*)::integer AS count FROM mind_changes WHERE commitment_id=$1", [initial.id])).rows[0]?.count).toBe(5);
  });

  test("a committed completion prevents a waiting scheduler decision; a later completion preserves history", async () => {
    await seedUser(pool);
    const due = new Date((await databaseTime()).getTime() - 60_000);
    const commitment = await seedCommitment(pool, undefined, userId, due.toISOString());
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT revision FROM mind_state WHERE user_id=$1 FOR UPDATE", [userId]);
      const pending = scheduler.tick();
      const changed = await blocker.query(`UPDATE commitments SET status='completed',completed_at=clock_timestamp(),version=version+1
        WHERE user_id=$1 AND id=$2 RETURNING ${COMMITMENT_COLUMNS}`, [userId, commitment.id]);
      const record = commitmentFromRow(changed.rows[0] ?? {});
      await blocker.query(`INSERT INTO mind_changes(id,user_id,commitment_id,entity_version,operation,actor,after_state)
        VALUES($1,$2,$3,$4,'complete','user',$5::jsonb)`, [crypto.randomUUID(), userId, commitment.id, record.version, JSON.stringify(record)]);
      await blocker.query("UPDATE mind_state SET revision=revision+1 WHERE user_id=$1", [userId]);
      await blocker.query("COMMIT");
      expect((await pending).createdLogIds).toHaveLength(0);
      expect(await readLogs()).toHaveLength(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
    const reopened = await writer.editCommitment({ userId }, commitment.id, { expectedVersion: versionSchema.parse("2"), status: "open" });
    expect((await scheduler.tick()).createdLogIds).toHaveLength(1);
    await writer.editCommitment({ userId }, commitment.id, { expectedVersion: reopened.version, status: "completed" });
    expect(await readLogs()).toHaveLength(1);
  });

  test("a future due edit waits, and clearing and resolving due time create only the final log", async () => {
    await seedUser(pool);
    const now = await databaseTime();
    const initial = await seedCommitment(pool, undefined, userId, new Date(now.getTime() - 60_000).toISOString());
    await scheduler.tick();
    const future = await writer.editCommitment({ userId }, initial.id, { expectedVersion: initial.version,
      dueAt: timestampSchema.parse(new Date(now.getTime() + 60_000).toISOString()) });
    expect((await scheduler.tick()).createdLogIds).toHaveLength(0);
    const cleared = await writer.editCommitment({ userId }, initial.id, { expectedVersion: future.version,
      dueAt: null, dueTimezone: null, dueText: null, duePrecision: "none" });
    expect((await scheduler.tick()).createdLogIds).toHaveLength(0);
    const resolved = await writer.editCommitment({ userId }, initial.id, { expectedVersion: cleared.version,
      dueAt: timestampSchema.parse(new Date(now.getTime() - 30_000).toISOString()), dueTimezone: "Asia/Kolkata", dueText: "today", duePrecision: "instant" });
    expect(resolved.scheduleVersion).toBe(versionSchema.parse("4"));
    expect((await scheduler.tick()).createdLogIds).toHaveLength(1);
    expect((await readLogs()).map(row => row.schedule_version)).toEqual(["1", "4"]);
  });

  test("a reschedule committed while the scheduler waits suppresses the old due decision", async () => {
    await seedUser(pool);
    const now = await databaseTime();
    const initial = await seedCommitment(pool, undefined, userId, new Date(now.getTime() - 60_000).toISOString());
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT revision FROM mind_state WHERE user_id=$1 FOR UPDATE", [userId]);
      const pending = scheduler.tick();
      const changed = await blocker.query(`UPDATE commitments SET due_at=$3,version=version+1,schedule_version=schedule_version+1,
        updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 RETURNING ${COMMITMENT_COLUMNS}`,
      [userId, initial.id, new Date(now.getTime() + 60_000)]);
      const record = commitmentFromRow(changed.rows[0] ?? {});
      await blocker.query(`INSERT INTO mind_changes(id,user_id,commitment_id,entity_version,operation,actor,after_state)
        VALUES($1,$2,$3,$4,'update','user',$5::jsonb)`, [crypto.randomUUID(), userId, initial.id, record.version, JSON.stringify(record)]);
      await blocker.query("UPDATE mind_state SET revision=revision+1 WHERE user_id=$1", [userId]);
      await blocker.query("COMMIT");
      expect((await pending).createdLogIds).toHaveLength(0);
      expect(await readLogs()).toHaveLength(0);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
  });
});

describe("ordered terminal emission", () => {
  test("failed terminal output cannot block durable notifications or later commitments", async () => {
    await seedUser(pool);
    const due = new Date((await databaseTime()).getTime() - 60_000);
    await createCommitment({ priority: 1, dueAt: due, title: "Private first task" });
    await createCommitment({ priority: 2, dueAt: due, title: "Private second task" });
    await scheduler.tick();
    const events: TerminalEvent[] = [];
    let fail = true;
    const sink: TerminalSink = { emit: async event => { if (fail) { fail = false; throw new Error("private failure text"); } events.push(event); } };
    const emitter = new CommitmentLogEmitter(pool, sink);
    expect(await emitter.flush()).toEqual({ emitted: 2, remaining: 0 });
    const rows = await readLogs();
    expect(events.map(event => event.logId)).toEqual([uuidSchema.parse(rows[1]!.id)]);
    expect(events.every(event => event.lateByMs >= 0 && !JSON.stringify(event).includes("Private"))).toBe(true);
    expect(rows.every(row => row.emitted_at !== null)).toBe(true);
    expect(rows.every(row => row.emit_attempts===0 && row.last_error_code===null)).toBe(true);
    expect(await new NotificationFeed(pool).after({userId},"0")).toHaveLength(2);
    expect(await emitter.flush()).toEqual({ emitted: 0, remaining: 0 });
  });

  test("an uncertain terminal write cannot duplicate the durable event", async () => {
    await seedUser(pool);
    await createCommitment({ dueAt: new Date((await databaseTime()).getTime() - 60_000) });
    await scheduler.tick();
    const seen: UUID[] = [];
    let uncertain = true;
    const emitter = new CommitmentLogEmitter(pool, { emit: async event => {
      seen.push(event.logId);
      if (uncertain) { uncertain = false; throw new Error("acknowledgment lost after output"); }
    } });
    expect(await emitter.flush()).toEqual({emitted:1,remaining:0});
    const rows = await readLogs();
    expect(rows).toHaveLength(1);
    expect(await emitter.flush()).toEqual({ emitted: 0, remaining: 0 });
    expect(seen).toEqual([uuidSchema.parse(rows[0]!.id)]);
    expect(await new NotificationFeed(pool).after({userId},"0")).toHaveLength(1);
    expect(await readLogs()).toHaveLength(1);
  });

  test("emission creates one replayable user-scoped event and deletion cancels pending logs",async()=>{
    await seedUser(pool);await seedUser(pool,otherUserId);
    const due=new Date((await databaseTime()).getTime()-60_000);
    const first=await createCommitment({dueAt:due});
    const second=await createCommitment({dueAt:due});
    await scheduler.tick();
    await writer.deleteCommitment({userId},second.id,{expectedVersion:second.version});
    const emitted:TerminalEvent[]=[];
    expect(await new CommitmentLogEmitter(pool,{emit:async event=>{emitted.push(event);}}).flush()).toEqual({emitted:1,remaining:0});
    expect(emitted).toHaveLength(1);
    const feed=new NotificationFeed(pool);
    const items=await feed.after({userId},"0");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({commitmentId:first.id,title:first.title,active:true});
    expect(await feed.after({userId},items[0]!.id)).toEqual([]);
    expect(await feed.after({userId:otherUserId},"0")).toEqual([]);
    const logs=await readLogs();
    expect(logs.find(row=>row.commitment_id===second.id)?.emitted_at).toBeNull();
    expect((await pool.query("SELECT canceled_at FROM commitment_logs WHERE commitment_id=$1",[second.id])).rows[0]?.canceled_at).not.toBeNull();
    const completed=await writer.editCommitment({userId},first.id,{expectedVersion:first.version,status:"completed"});
    expect(completed.status).toBe("completed");
    expect((await feed.after({userId},"0"))[0]?.active).toBe(false);
  });

  test("repeated terminal failures leave all durable notification events available", async () => {
    await seedUser(pool);
    const due=new Date((await databaseTime()).getTime()-60_000);
    await createCommitment({dueAt:due,priority:1});
    await createCommitment({dueAt:due,priority:2});
    await createCommitment({dueAt:due,priority:3});
    await scheduler.tick();
    const emitter = new CommitmentLogEmitter(pool, { emit: async () => { throw new Error("private output failure"); } });
    expect(await emitter.flush()).toEqual({emitted:3,remaining:0});
    expect((await readLogs()).every(row=>row.emitted_at!==null && row.emit_attempts===0 && row.last_error_code===null)).toBe(true);
    expect(await new NotificationFeed(pool).after({userId},"0")).toHaveLength(3);
  });

  test("two emitters serialize on the advisory session lock", async () => {
    await seedUser(pool);
    await createCommitment({ dueAt: new Date((await databaseTime()).getTime() - 60_000) });
    await scheduler.tick();
    const events: TerminalEvent[] = [];
    const sink: TerminalSink = { emit: async event => { events.push(event); await new Promise(resolve => setTimeout(resolve, 30)); } };
    await Promise.all([new CommitmentLogEmitter(pool, sink).flush(), new CommitmentLogEmitter(pool, sink).flush()]);
    expect(events).toHaveLength(1);
    expect((await readLogs())[0]?.emitted_at).not.toBeNull();
  });
});

describe("scheduler lifecycle", () => {
  test("runs immediately, orders tick before flush, and stops cleanly", async () => {
    const calls: string[] = [];
    let completed: (() => void) | undefined;
    const finished = new Promise<void>(resolve => { completed = resolve; });
    const loop = startSchedulingLoop(
      { tick: async () => { calls.push("tick"); return { createdLogIds: [] }; } },
      { flush: async () => { calls.push("flush"); completed?.(); return { emitted: 0, remaining: 0 }; } },
      () => { throw new Error("Unexpected loop error"); },
    );
    await finished;
    await loop.stop();
    expect(calls).toEqual(["tick", "flush"]);
  });

  test("runs the database decision and terminal sink together without voice or OpenAI", async () => {
    await seedUser(pool);
    await createCommitment({ dueAt: new Date((await databaseTime()).getTime() - 60_000) });
    let received: ((event: TerminalEvent) => void) | undefined;
    const event = new Promise<TerminalEvent>(resolve => { received = resolve; });
    const loop = startSchedulingLoop(new CommitmentScheduler(pool),
      new CommitmentLogEmitter(pool, { emit: async value => { received?.(value); } }),
      () => { throw new Error("Unexpected loop error"); });
    const output = await event;
    await loop.stop();
    expect(output.event).toBe("commitment_due");
    expect((await readLogs())[0]?.emitted_at).not.toBeNull();
  });
});
