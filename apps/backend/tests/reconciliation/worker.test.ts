import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type pg from "pg";
import { counterSchema, uuidSchema, type UUID } from "../../src/contracts";
import { MindReader, MindWriter, hashTranscriptInput } from "../../src/mind";
import { ReconciliationRepository, ReconciliationWorker, type ClaimedExtraction, type ExtractionOutcome, type TextExtractor } from "../../src/reconciliation";
import { clearTestDatabase, createTestPool, prepareTestDatabase } from "../helpers/database";
import { itemId, jobId, otherUserId, partId, seedMemory, seedRunningJob, seedUser, sessionId, userId } from "../helpers/factories";

let pool: pg.Pool;
let repository: ReconciliationRepository;
let writer: MindWriter;
let reader: MindReader;
beforeAll(async () => { pool = createTestPool(); await prepareTestDatabase(pool); repository = new ReconciliationRepository(pool); writer = new MindWriter(pool); reader = new MindReader(pool); });
beforeEach(async () => { await clearTestDatabase(pool); });
afterAll(async () => { await pool?.end(); });

async function firstJob(text: string): Promise<void> {
  await seedUser(pool);
  await seedRunningJob(pool, text);
  await pool.query("UPDATE reconciliation_jobs SET state='pending',attempts=0,claim_token=NULL,lease_until=NULL,base_mind_revision=NULL WHERE id=$1", [jobId]);
}

async function secondJob(firstText: string, secondText: string): Promise<{ job: UUID; part: UUID }> {
  const nextItem = uuidSchema.parse(crypto.randomUUID());
  const nextPart = uuidSchema.parse(crypto.randomUUID());
  const nextJob = uuidSchema.parse(crypto.randomUUID());
  const secondHash = createHash("sha256").update(secondText).digest("hex");
  await pool.query("UPDATE voice_sessions SET ordered_through=2,sealed_through=2 WHERE id=$1", [sessionId]);
  await pool.query(`INSERT INTO transcript_items(id,user_id,session_id,provider_item_id,predecessor_known,ordinal,role,item_type,state,expected_parts,terminal_at)
    VALUES($1,$2,$3,'item_2',true,2,'user','message','complete',1,now())`, [nextItem, userId, sessionId]);
  await pool.query(`INSERT INTO transcript_parts(id,user_id,item_id,content_index,kind,final_text,state,final_event_id,text_hash,completed_at)
    VALUES($1,$2,$3,0,'user_audio',$4,'complete','event_2',$5,now())`, [nextPart, userId, nextItem, secondText, secondHash]);
  const hash = hashTranscriptInput("Asia/Kolkata", [
    { ordinal: 1, itemId, partId, contentIndex: 0, textHash: createHash("sha256").update(firstText).digest("hex"), timeAnchorAt: null },
    { ordinal: 2, itemId: nextItem, partId: nextPart, contentIndex: 0, textHash: secondHash, timeAnchorAt: null },
  ]);
  await pool.query(`INSERT INTO reconciliation_jobs(id,user_id,session_id,from_ordinal,through_ordinal,input_hash,model,prompt_version,schema_version)
    VALUES($1,$2,$3,2,2,$4,'test-model','v1','1')`, [nextJob, userId, sessionId, hash]);
  return { job: nextJob, part: nextPart };
}

class FakeExtractor implements TextExtractor {
  constructor(readonly next: (input: ClaimedExtraction) => ExtractionOutcome | Promise<ExtractionOutcome>) {}
  async extract(input: ClaimedExtraction): Promise<ExtractionOutcome> { return this.next(input); }
}

describe("durable claim and worker", () => {
  test("claims consistent input and prevents a second active claim", async () => {
    await firstJob("Ananya likes science fiction");
    const first = await repository.claimNext();
    expect(first?.newParts[0]?.text).toBe("Ananya likes science fiction");
    expect(first?.mind.revision).toBe(counterSchema.parse("0"));
    expect(await new ReconciliationRepository(pool).claimNext()).toBeNull();
    const row = await pool.query("SELECT state,attempts,claim_token FROM reconciliation_jobs WHERE id=$1", [jobId]);
    expect(row.rows[0]).toMatchObject({ state: "running", attempts: 1, claim_token: first?.claim.claimToken });
  });

  test("extracts a memory, then corrects the same record in a later batch", async () => {
    const firstText = "Ananya likes science fiction";
    await firstJob(firstText);
    const fake = new FakeExtractor(input => {
      const correcting = input.claim.fromOrdinal === 2;
      const existing = input.mind.memories[0];
      return { kind: "success", proposals: [{
        entity: "memory", action: correcting ? "update" : "create", target_id: correcting ? existing?.id ?? null : null,
        expected_version: correcting ? existing?.version ?? null : null, commitment: null,
        memory: { kind: "semantic", subject: "Ananya", predicate: "movie_preference", content: correcting ? "Ananya likes documentaries" : "Ananya likes science fiction", occurred_at: null, time_text: null },
        sources: [{ part_id: input.newParts[0]?.partId ?? partId, evidence_text: input.newParts[0]?.text ?? "" }],
      }] };
    });
    const worker = new ReconciliationWorker(repository, fake, writer);
    expect(await worker.tick()).toBe("applied");
    const second = await secondJob(firstText, "Actually Ananya likes documentaries");
    expect(await worker.tick()).toBe("applied");
    const snapshot = await reader.getSnapshot({ userId });
    expect(snapshot.memories).toHaveLength(1);
    expect(snapshot.memories[0]).toMatchObject({ content: "Ananya likes documentaries", version: counterSchema.parse("2") });
    expect((await reader.getProvenance({ userId }, { type: "memory", id: snapshot.memories[0]!.id })).map(change => change.jobId)).toEqual([jobId, second.job]);
    expect((await pool.query("SELECT applied_through FROM voice_sessions WHERE id=$1", [sessionId])).rows[0]?.applied_through).toBe(2);
  });

  test("creates one commitment and closes it from a later completed turn", async () => {
    const firstText = "I promised to send Ananya the presentation";
    await firstJob(firstText);
    const worker = new ReconciliationWorker(repository, new FakeExtractor(input => {
      const existing = input.mind.commitments[0];
      const completing = input.claim.fromOrdinal === 2;
      return { kind: "success", proposals: [{ entity: "commitment", action: completing ? "complete" : "create",
        target_id: completing ? existing?.id ?? null : null, expected_version: completing ? existing?.version ?? null : null,
        memory: null, commitment: { title: "Send Ananya the presentation", subject: "Ananya", status: completing ? "completed" : "open", priority: 2,
          due_text: null, due_precision: "none", temporal_kind: "none", offset_datetime: null, local_date: null, local_time: null, timezone: null, relative_seconds: null },
        sources: [{ part_id: input.newParts[0]?.partId ?? partId, evidence_text: input.newParts[0]?.text ?? "" }] }] };
    }), writer);
    expect(await worker.tick()).toBe("applied");
    await secondJob(firstText, "I sent Ananya the presentation");
    expect(await worker.tick()).toBe("applied");
    const snapshot = await reader.getSnapshot({ userId });
    expect(snapshot.commitments).toHaveLength(1);
    expect(snapshot.commitments[0]).toMatchObject({ status: "completed", version: counterSchema.parse("2") });
    expect(snapshot.commitments[0]?.completedAt).not.toBeNull();
    expect((await reader.getProvenance({ userId }, { type: "commitment", id: snapshot.commitments[0]!.id })).map(change => change.operation)).toEqual(["create", "complete"]);
  });

  test("an identical repeat advances the cursor without another Mind change", async () => {
    await firstJob("Ananya likes science fiction");
    const existing = await seedMemory(pool);
    const worker = new ReconciliationWorker(repository, new FakeExtractor(input => ({ kind: "success", proposals: [{
      entity: "memory", action: "update", target_id: existing.id, expected_version: existing.version, commitment: null,
      memory: { kind: "semantic", subject: existing.subject, predicate: existing.predicate, content: existing.content, occurred_at: null, time_text: null },
      sources: [{ part_id: input.newParts[0]?.partId ?? partId, evidence_text: "Ananya likes science fiction" }],
    }] })), writer);
    expect(await worker.tick()).toBe("applied");
    expect((await pool.query("SELECT applied_through FROM voice_sessions WHERE id=$1", [sessionId])).rows[0]?.applied_through).toBe(1);
    expect((await pool.query("SELECT count(*)::integer AS count FROM mind_changes WHERE user_id=$1 AND job_id=$2", [userId, jobId])).rows[0]?.count).toBe(0);
  });

  test("a cross-user target cannot be changed by extraction", async () => {
    await firstJob("Ananya likes science fiction");
    await seedUser(pool, otherUserId);
    const foreign = await seedMemory(pool, undefined, otherUserId);
    const worker = new ReconciliationWorker(repository, new FakeExtractor(input => ({ kind: "success", proposals: [{
      entity: "memory", action: "update", target_id: foreign.id, expected_version: foreign.version, commitment: null,
      memory: { kind: "semantic", subject: foreign.subject, predicate: foreign.predicate, content: "Ananya likes documentaries", occurred_at: null, time_text: null },
      sources: [{ part_id: input.newParts[0]?.partId ?? partId, evidence_text: "Ananya likes science fiction" }],
    }] })), writer);
    expect(await worker.tick()).toBe("deferred");
    expect((await pool.query("SELECT state FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]?.state).toBe("retry_wait");
    expect((await pool.query("SELECT content FROM memories WHERE id=$1", [foreign.id])).rows[0]?.content).toBe(foreign.content);
  });

  test("a deleted manual memory is not recreated from a repeated statement", async () => {
    await firstJob("Ananya likes science fiction");
    const memory = await seedMemory(pool);
    await writer.deleteMemory({ userId }, memory.id, { expectedVersion: memory.version });
    const worker = new ReconciliationWorker(repository, new FakeExtractor(input => ({ kind: "success", proposals: [{
      entity: "memory", action: "create", target_id: null, expected_version: null, commitment: null,
      memory: { kind: "semantic", subject: "Ananya", predicate: "movie_preference", content: "Ananya likes science fiction", occurred_at: null, time_text: null },
      sources: [{ part_id: input.newParts[0]?.partId ?? partId, evidence_text: "Ananya likes science fiction" }],
    }] })), writer);
    expect(await worker.tick()).toBe("applied");
    const snapshot = await reader.getSnapshot({ userId });
    expect(snapshot.memories).toHaveLength(1);
    expect(snapshot.memories[0]?.state).toBe("deleted");
  });

  test("refusal blocks FIFO, explicit retry succeeds, explicit skip advances without changes", async () => {
    const text = "I promised to send the presentation";
    await firstJob(text);
    const second = await secondJob(text, "The weather is nice");
    let refuse = true;
    const worker = new ReconciliationWorker(repository, new FakeExtractor(() => refuse ? { kind: "refusal" } : { kind: "success", proposals: [] }), writer);
    await worker.tick();
    expect((await pool.query("SELECT state FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]?.state).toBe("blocked");
    expect(await worker.tick()).toBe("idle");
    expect((await pool.query("SELECT state FROM reconciliation_jobs WHERE id=$1", [second.job])).rows[0]?.state).toBe("pending");
    await repository.retryBlocked(jobId, "Model policy reviewed");
    refuse = false;
    expect(await worker.tick()).toBe("applied");
    expect(await worker.tick()).toBe("applied");
    expect((await pool.query("SELECT applied_through FROM voice_sessions WHERE id=$1", [sessionId])).rows[0]?.applied_through).toBe(2);

    await pool.query("UPDATE reconciliation_jobs SET state='blocked',finished_at=now(),last_error_code='operator_test' WHERE id=$1", [second.job]);
    await expect(repository.skipBlocked(second.job, "No longer needed")).rejects.toThrow();
  });

  test("explicit skip preserves transcript and unlocks the next range", async () => {
    const text = "I promised to send the presentation";
    await firstJob(text);
    const later = await secondJob(text, "Ananya likes science fiction");
    const worker = new ReconciliationWorker(repository, new FakeExtractor(input => input.claim.fromOrdinal === 1 ? { kind: "refusal" } : { kind: "success", proposals: [] }), writer);
    expect(await worker.tick()).toBe("blocked");
    await repository.skipBlocked(jobId, "Operator accepted missing extraction");
    expect((await pool.query("SELECT state,resolution_note FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "skipped", resolution_note: "Operator accepted missing extraction" });
    expect((await pool.query("SELECT revision FROM mind_state WHERE user_id=$1", [userId])).rows[0]?.revision).toBe("1");
    expect(await worker.tick()).toBe("applied");
    expect((await pool.query("SELECT state FROM reconciliation_jobs WHERE id=$1", [later.job])).rows[0]?.state).toBe("succeeded");
    expect((await pool.query("SELECT final_text FROM transcript_parts WHERE id=$1", [partId])).rows[0]?.final_text).toBe(text);
  });

  test("two claimers race safely; retry budget and invalid feedback survive restart", async () => {
    await firstJob("Ananya likes science fiction");
    const [a, b] = await Promise.all([repository.claimNext(), new ReconciliationRepository(pool).claimNext()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const first = a ?? b;
    if (!first) throw new Error("Missing winner");
    expect(await repository.recordFailure(first.claim, { code: "invalid_schema", policy: "invalid" })).toBe("updated");
    await pool.query("UPDATE reconciliation_jobs SET available_at=now() WHERE id=$1", [jobId]);
    const second = await new ReconciliationRepository(pool).claimNext();
    expect(second?.validationFeedback).toBe("invalid_schema");
    if (!second) throw new Error("Missing retry");
    await repository.recordFailure(second.claim, { code: "invalid_schema", policy: "invalid" });
    expect((await pool.query("SELECT state,attempts FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "blocked", attempts: 2 });
  });

  test("network retry uses five and thirty seconds, honors longer Retry-After, then blocks", async () => {
    await firstJob("Ananya likes science fiction");
    const first = await repository.claimNext();
    if (!first) throw new Error("Missing first claim");
    await repository.recordFailure(first.claim, { code: "model_network", policy: "retry" });
    const waitOne = await pool.query<{ seconds: string }>("SELECT extract(epoch FROM available_at-now())::text AS seconds FROM reconciliation_jobs WHERE id=$1", [jobId]);
    expect(Number(waitOne.rows[0]?.seconds)).toBeGreaterThan(4);
    await pool.query("UPDATE reconciliation_jobs SET available_at=now() WHERE id=$1", [jobId]);
    const second = await repository.claimNext();
    if (!second) throw new Error("Missing second claim");
    await repository.recordFailure(second.claim, { code: "model_http_429", policy: "retry", retryAfterSeconds: 120 });
    const waitTwo = await pool.query<{ seconds: string }>("SELECT extract(epoch FROM available_at-now())::text AS seconds FROM reconciliation_jobs WHERE id=$1", [jobId]);
    expect(Number(waitTwo.rows[0]?.seconds)).toBeGreaterThan(119);
    await pool.query("UPDATE reconciliation_jobs SET available_at=now() WHERE id=$1", [jobId]);
    const third = await repository.claimNext();
    if (!third) throw new Error("Missing third claim");
    await repository.recordFailure(third.claim, { code: "model_http_503", policy: "retry" });
    expect((await pool.query("SELECT state,attempts FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "blocked", attempts: 3 });
  });

  test("expired worker cannot apply or change the replacement claim", async () => {
    await firstJob("Ananya likes science fiction");
    const a = await repository.claimNext();
    if (!a) throw new Error("Missing claim");
    await pool.query("UPDATE reconciliation_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId]);
    const b = await repository.claimNext();
    if (!b) throw new Error("Missing replacement claim");
    expect(b.claim.claimToken).not.toBe(a.claim.claimToken);
    await writer.applyExtraction(b.claim, { changes: [] });
    await expect(writer.applyExtraction(a.claim, { changes: [] })).rejects.toMatchObject({ code: "stale_claim" });
    expect(await repository.recordFailure(a.claim, { code: "model_timeout", policy: "retry" })).toBe("stale");
    expect((await pool.query("SELECT state,attempts FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "succeeded", attempts: 2 });
  });

  test("three expired leases exhaust the attempt budget and block", async () => {
    await firstJob("Ananya likes science fiction");
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await repository.claimNext()).not.toBeNull();
      await pool.query("UPDATE reconciliation_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [jobId]);
    }
    expect(await repository.claimNext()).toBeNull();
    expect((await pool.query("SELECT state,attempts,last_error_code FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "blocked", attempts: 3, last_error_code: "lease_expired" });
  });

  test("oversized transcript blocks before contacting the text model", async () => {
    await firstJob("A".repeat(66_000));
    let called = false;
    const worker = new ReconciliationWorker(repository, new FakeExtractor(() => { called = true; return { kind: "success", proposals: [] }; }), writer);
    expect(await worker.tick()).toBe("blocked");
    expect(called).toBe(false);
    expect((await pool.query("SELECT state,last_error_code FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "blocked", last_error_code: "context_limit" });
  });

  test("manual edit during extraction fences the stale proposal", async () => {
    await firstJob("Actually Ananya likes documentaries");
    const memory = await seedMemory(pool);
    const fake = new FakeExtractor(async input => {
      await writer.editMemory({ userId }, memory.id, { expectedVersion: memory.version, content: "Manually corrected" });
      return { kind: "success", proposals: [{ entity: "memory", action: "update", target_id: memory.id, expected_version: memory.version,
        memory: { kind: "semantic", subject: "Ananya", predicate: "movie_preference", content: "Ananya likes documentaries", occurred_at: null, time_text: null }, commitment: null,
        sources: [{ part_id: input.newParts[0]?.partId ?? partId, evidence_text: "Actually Ananya likes documentaries" }] }] };
    });
    const worker = new ReconciliationWorker(repository, fake, writer);
    expect(await worker.tick()).toBe("deferred");
    const snapshot = await reader.getSnapshot({ userId });
    expect(snapshot.memories[0]?.content).toBe("Manually corrected");
    expect((await pool.query("SELECT state,last_error_code FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "retry_wait", last_error_code: "stale_snapshot" });
  });

  test("corrupt sealed text blocks without sending it to the model", async () => {
    await firstJob("Ananya likes science fiction");
    await pool.query("UPDATE transcript_parts SET final_text='tampered' WHERE id=$1", [partId]);
    expect(await repository.claimNext()).toBeNull();
    expect((await pool.query("SELECT state,last_error_code FROM reconciliation_jobs WHERE id=$1", [jobId])).rows[0]).toMatchObject({ state: "blocked", last_error_code: "transcript_integrity" });
  });
});
