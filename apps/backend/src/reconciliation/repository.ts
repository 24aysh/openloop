import { createHash } from "node:crypto";
import type pg from "pg";
import { counterSchema, jobClaimSchema, uuidSchema, type UUID } from "../contracts";
import { withTransaction } from "../db/transaction";
import { hashTranscriptInput, type HashInputPart } from "../mind";
import { commitmentFromRow, COMMITMENT_COLUMNS, memoryFromRow, MEMORY_COLUMNS } from "../mind/rows";
import { databaseNow, lockMindState } from "../mind/writer";
import type { ClaimedExtraction, CompletedUserPart, JobFailure } from "./types";
import { logReconciliation } from "./log";

type JobRow = {
  id: string; user_id: string; session_id: string; from_ordinal: number; through_ordinal: number; input_hash: string;
  state: string; attempts: number; available_at: Date; lease_until: Date | null; claim_token: string | null;
  model: string; prompt_version: string; schema_version: string; last_error_code: string | null;
};
type SessionRow = { id: string; timezone: string; created_at: Date; applied_through: number; sealed_through: number };
type ItemRow = { id: string; ordinal: number; role: string; state: string; expected_parts: number | null; time_anchor_at: Date | null };
type PartRow = { part_id: string; item_id: string; ordinal: number; content_index: number; final_text: string | null; text_hash: string | null; state: string; time_anchor_at: Date | null };
type ClaimResult = ClaimedExtraction | null;
export type FailureResult = Readonly<{ kind: "stale" }> | Readonly<{
  kind: "updated"; state: "retry_wait" | "blocked"; code: string; nextAttemptAt: string | null;
}>;

async function earliest(client: pg.PoolClient, userId: UUID): Promise<string | null> {
  const result = await client.query<{ id: string }>(`SELECT j.id FROM reconciliation_jobs j JOIN voice_sessions s ON s.user_id=j.user_id AND s.id=j.session_id
    WHERE j.user_id=$1 AND j.state NOT IN ('succeeded','skipped') ORDER BY s.session_seq,j.from_ordinal,j.id LIMIT 1`, [userId]);
  return result.rows[0]?.id ?? null;
}

async function blockIntegrity(client: pg.PoolClient, jobId: string): Promise<void> {
  await client.query(`UPDATE reconciliation_jobs SET state='blocked',claim_token=NULL,lease_until=NULL,base_mind_revision=NULL,
    last_error_code='transcript_integrity',finished_at=now(),updated_at=now() WHERE id=$1`, [jobId]);
}

async function readParts(client: pg.PoolClient, userId: UUID, session: SessionRow, job: JobRow): Promise<CompletedUserPart[] | null> {
  const items = await client.query<ItemRow>(`SELECT id,ordinal,role,state,expected_parts,time_anchor_at FROM transcript_items
    WHERE user_id=$1 AND session_id=$2 AND ordinal BETWEEN 1 AND $3 ORDER BY ordinal`, [userId, session.id, job.through_ordinal]);
  if (items.rows.length !== job.through_ordinal || items.rows.some((item, index) => item.ordinal !== index + 1)) return null;
  const userItems = items.rows.filter(item => item.role === "user");
  if (userItems.length === 0 || userItems.some(item => item.state !== "complete" || item.expected_parts === null || item.expected_parts < 1)) return null;
  const result = await client.query<PartRow>(`SELECT p.id AS part_id,p.item_id,i.ordinal,p.content_index,p.final_text,p.text_hash,p.state,i.time_anchor_at
    FROM transcript_parts p JOIN transcript_items i ON i.user_id=p.user_id AND i.id=p.item_id
    WHERE p.user_id=$1 AND i.session_id=$2 AND i.ordinal BETWEEN 1 AND $3 AND i.role='user'
    ORDER BY i.ordinal,p.content_index`, [userId, session.id, job.through_ordinal]);
  const byItem = new Map<string, PartRow[]>();
  for (const part of result.rows) byItem.set(part.item_id, [...(byItem.get(part.item_id) ?? []), part]);
  for (const item of userItems) {
    const rows = byItem.get(item.id) ?? [];
    if (rows.length !== item.expected_parts || rows.some((part, index) => part.content_index !== index || part.state !== "complete" || part.final_text === null || part.text_hash === null)) return null;
  }
  if (result.rows.some(part => createHash("sha256").update(part.final_text ?? "").digest("hex") !== part.text_hash)) return null;
  const hashParts: HashInputPart[] = result.rows.map(part => ({ ordinal: part.ordinal, itemId: uuidSchema.parse(part.item_id), partId: uuidSchema.parse(part.part_id), contentIndex: part.content_index, textHash: part.text_hash ?? "", timeAnchorAt: part.time_anchor_at?.toISOString() ?? null }));
  if (hashTranscriptInput(session.timezone, hashParts) !== job.input_hash) return null;
  return result.rows.map(part => ({ partId: uuidSchema.parse(part.part_id), itemId: uuidSchema.parse(part.item_id), ordinal: part.ordinal, contentIndex: part.content_index, text: part.final_text ?? "", timeAnchorAt: part.time_anchor_at?.toISOString() ?? null }));
}

export class ReconciliationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async claimNext(): Promise<ClaimResult> {
    const heads = await this.pool.query<{ id: string; user_id: string }>(`SELECT DISTINCT ON (j.user_id) j.id,j.user_id FROM reconciliation_jobs j
      JOIN voice_sessions s ON s.user_id=j.user_id AND s.id=j.session_id
      WHERE j.state NOT IN ('succeeded','skipped')
      ORDER BY j.user_id,s.session_seq,j.from_ordinal,j.id`);
    for (const head of heads.rows) {
      const claim = await this.claimOne(uuidSchema.parse(head.user_id), uuidSchema.parse(head.id));
      if (claim) return claim;
    }
    return null;
  }

  private async claimOne(userId: UUID, jobId: UUID): Promise<ClaimResult> {
    return withTransaction(this.pool, { isolation: "read committed" }, async client => {
      const state = await client.query<{ revision: string }>("SELECT revision FROM mind_state WHERE user_id=$1 FOR UPDATE SKIP LOCKED", [userId]);
      if (!state.rows[0]) return null;
      const initial = await client.query<{ session_id: string }>("SELECT session_id FROM reconciliation_jobs WHERE user_id=$1 AND id=$2", [userId, jobId]);
      if (!initial.rows[0]) return null;
      const sessionResult = await client.query<SessionRow>("SELECT id,timezone,created_at,applied_through,sealed_through FROM voice_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE", [userId, initial.rows[0].session_id]);
      const session = sessionResult.rows[0];
      if (!session) return null;
      const jobResult = await client.query<JobRow>("SELECT * FROM reconciliation_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE", [userId, jobId]);
      const job = jobResult.rows[0];
      if (!job || await earliest(client, userId) !== job.id) return null;
      const now = await databaseNow(client);
      if (job.state === "blocked" || job.state === "succeeded" || job.state === "skipped") return null;
      if (job.state === "running") {
        if (!job.lease_until || job.lease_until > now) return null;
        if (job.attempts >= 3) {
          await client.query(`UPDATE reconciliation_jobs SET state='blocked',claim_token=NULL,lease_until=NULL,base_mind_revision=NULL,
            last_error_code='lease_expired',finished_at=now(),updated_at=now() WHERE id=$1`, [job.id]);
          return null;
        }
        await client.query(`UPDATE reconciliation_jobs SET state='retry_wait',claim_token=NULL,lease_until=NULL,base_mind_revision=NULL,
          available_at=now(),last_error_code='lease_expired',updated_at=now() WHERE id=$1`, [job.id]);
      } else if (!(["pending", "retry_wait"].includes(job.state)) || job.available_at > now) return null;
      if (session.applied_through !== job.from_ordinal - 1 || session.sealed_through < job.through_ordinal) return null;
      const parts = await readParts(client, userId, session, job);
      if (!parts) { await blockIntegrity(client, job.id); return null; }
      const memories = await client.query(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE user_id=$1 ORDER BY id`, [userId]);
      const commitments = await client.query(`SELECT ${COMMITMENT_COLUMNS} FROM commitments WHERE user_id=$1 ORDER BY id`, [userId]);
      const revision = counterSchema.parse(state.rows[0].revision);
      const claimToken = uuidSchema.parse(crypto.randomUUID());
      await client.query(`UPDATE reconciliation_jobs SET state='running',attempts=attempts+1,claim_token=$2,
        lease_until=now()+interval '90 seconds',base_mind_revision=$3,finished_at=NULL,updated_at=now()
        WHERE id=$1`, [job.id, claimToken, revision]);
      const claim = jobClaimSchema.parse({ userId, jobId, sessionId: uuidSchema.parse(session.id), claimToken, baseMindRevision: revision,
        fromOrdinal: job.from_ordinal, throughOrdinal: job.through_ordinal, inputHash: job.input_hash });
      return { claim, attempt: job.attempts + 1, model: job.model, promptVersion: job.prompt_version, schemaVersion: job.schema_version,
        sessionTimezone: session.timezone, sessionStartedAt: session.created_at.toISOString(),
        earlierParts: parts.filter(part => part.ordinal < job.from_ordinal), newParts: parts.filter(part => part.ordinal >= job.from_ordinal),
        mind: { revision, memories: memories.rows.map(memoryFromRow), commitments: commitments.rows.map(commitmentFromRow) },
        validationFeedback: job.last_error_code && /^(invalid_|incomplete_output)/.test(job.last_error_code) ? job.last_error_code : null };
    });
  }

  async jobState(jobId: UUID): Promise<string | null> {
    const result = await this.pool.query<{ state: string }>("SELECT state FROM reconciliation_jobs WHERE id=$1", [jobId]);
    return result.rows[0]?.state ?? null;
  }

  async recordFailure(claim: ClaimedExtraction["claim"], failure: JobFailure): Promise<FailureResult> {
    if (!/^[a-z0-9_]{1,80}$/.test(failure.code)) throw new Error("Unsafe failure code");
    return withTransaction(this.pool, { isolation: "read committed" }, async client => {
      await lockMindState(client, claim.userId);
      await client.query("SELECT id FROM voice_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE", [claim.userId, claim.sessionId]);
      const result = await client.query<JobRow>("SELECT * FROM reconciliation_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE", [claim.userId, claim.jobId]);
      const job = result.rows[0];
      const now = await databaseNow(client);
      if (!job || job.state !== "running" || job.claim_token !== claim.claimToken || !job.lease_until || job.lease_until <= now) return { kind: "stale" };
      const priorInvalid = job.last_error_code !== null && /^(invalid_|incomplete_output)/.test(job.last_error_code);
      const storedCode = failure.policy === "invalid" && !/^(invalid_|incomplete_output)/.test(failure.code) ? `invalid_${failure.code}` : failure.code;
      const blocked = failure.policy === "block" || job.attempts >= 3 || (failure.policy === "invalid" && priorInvalid);
      const baseDelay = failure.policy === "conflict" || failure.policy === "invalid" ? 1 : job.attempts === 1 ? 5 : 30;
      const delay = Math.min(300, Math.max(baseDelay, failure.retryAfterSeconds ?? 0));
      const updated = await client.query<{state:"retry_wait"|"blocked";last_error_code:string;available_at:Date}>(`UPDATE reconciliation_jobs SET state=$2,claim_token=NULL,lease_until=NULL,base_mind_revision=NULL,
        last_error_code=$3,available_at=now()+($4::integer * interval '1 second'),finished_at=CASE WHEN $2='blocked' THEN now() ELSE NULL END,updated_at=now()
        WHERE id=$1 RETURNING state,last_error_code,available_at`, [job.id, blocked ? "blocked" : "retry_wait", storedCode, blocked ? 0 : delay]);
      const failureRow=updated.rows[0];
      if(!failureRow) throw new Error("Failure update returned no row");
      return {kind:"updated",state:failureRow.state,code:failureRow.last_error_code,
        nextAttemptAt:failureRow.state==="blocked"?null:failureRow.available_at.toISOString()};
    });
  }

  async retryBlocked(jobId: UUID, reason: string): Promise<void> { await this.resolveBlocked(jobId, reason, "retry"); }
  async skipBlocked(jobId: UUID, reason: string): Promise<void> { await this.resolveBlocked(jobId, reason, "skip"); }

  private async resolveBlocked(jobId: UUID, reason: string, action: "retry" | "skip"): Promise<void> {
    const note = reason.trim();
    if (note.length < 1 || note.length > 500) throw new Error("Operator reason must be 1–500 characters");
    const owner = await this.pool.query<{ user_id: string; session_id: string }>("SELECT user_id,session_id FROM reconciliation_jobs WHERE id=$1", [jobId]);
    const identity = owner.rows[0];
    if (!identity) throw new Error("Job not found");
    const userId = uuidSchema.parse(identity.user_id);
    await withTransaction(this.pool, { isolation: "read committed" }, async client => {
      await lockMindState(client, userId);
      const session = await client.query<SessionRow>("SELECT id,timezone,created_at,applied_through,sealed_through FROM voice_sessions WHERE user_id=$1 AND id=$2 FOR UPDATE", [userId, identity.session_id]);
      const job = await client.query<JobRow>("SELECT * FROM reconciliation_jobs WHERE user_id=$1 AND id=$2 FOR UPDATE", [userId, jobId]);
      if (!session.rows[0] || job.rows[0]?.state !== "blocked" || await earliest(client, userId) !== jobId) throw new Error("Job is no longer the earliest blocked job");
      if (session.rows[0].applied_through !== job.rows[0].from_ordinal - 1) throw new Error("Job cursor changed");
      if (action === "retry") {
        await client.query(`UPDATE reconciliation_jobs SET state='pending',attempts=0,available_at=now(),claim_token=NULL,lease_until=NULL,
          base_mind_revision=NULL,last_error_code=NULL,resolution_note=$2,finished_at=NULL,updated_at=now() WHERE id=$1`, [jobId, note]);
      } else {
        await client.query("UPDATE voice_sessions SET applied_through=$3,updated_at=now() WHERE user_id=$1 AND id=$2", [userId, identity.session_id, job.rows[0].through_ordinal]);
        await client.query(`UPDATE reconciliation_jobs SET state='skipped',claim_token=NULL,lease_until=NULL,base_mind_revision=NULL,
          resolution_note=$2,finished_at=now(),updated_at=now() WHERE id=$1`, [jobId, note]);
        await client.query("UPDATE mind_state SET revision=revision+1,updated_at=now() WHERE user_id=$1", [userId]);
      }
    });
    logReconciliation(action, jobId);
  }
}
