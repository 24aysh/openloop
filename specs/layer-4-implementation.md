# Layer 4 implementation plan: Mind reconciliation

Status: implemented; deterministic acceptance passed, manual OpenAI fixture pending
Architecture source: [Openloop MVP architecture](../docs/mvp-architecture.md), section 6; time interpretation follows section 7.1
Prerequisites: [layer 1](layer-1-implementation.md) and [layer 2](layer-2-implementation.md); [layer 3](layer-3-implementation.md) is optional for development and end-to-end voice acceptance
Scope: consume durable reconciliation jobs, extract proposed memories and commitments with a text model, validate them, and apply them atomically to Mind

## 1. Outcome and boundary

A completed, correctly ordered transcript batch from layer 2 creates a durable `reconciliation_jobs` row. Layer 4 polls those rows, claims the earliest eligible work for a user, reads a consistent Mind snapshot and immutable transcript prefix, asks a configured OpenAI text model for proposed changes, and applies valid changes through the existing Mind writer. A successful empty result still advances the session's applied cursor. A blocked job remains visible and prevents later work for that user until an operator explicitly retries or skips it.

This layer does not ingest Realtime events, read Mind back into an active Realtime conversation, expose an admin UI, send notifications, or run the commitment scheduler. Layer 5 consumes the persisted commitments independently. Do not add a queue, another service, or another database.

## 2. Reuse and expected changes

Reuse `reconciliation_jobs`, `mind_state`, `voice_sessions`, `transcript_items`, `transcript_parts`, `memories`, `commitments`, `mind_changes`, and `change_sources` from migration `0001_layer_1.sql`. No migration is required. Reuse `hashTranscriptInput`, the row mappers and columns in `mind/rows.ts`, `withTransaction`, `JobClaim`, `ValidatedChangeSet`, and `MindWriter.applyExtraction`. That writer already checks claim token, lease, Mind revision, cursor, transcript hash, source ownership/evidence, target version, and manual override, then writes changes, provenance, cursor, revision, and job success in one transaction. Do not duplicate that application logic in a new `apply.ts`.

Expected backend files:

```text
apps/backend/src/reconciliation/{types,repository,extractor,prompt,validate,time,worker,index}.ts
apps/backend/src/reconciliation/operator.ts
apps/backend/src/server.ts
apps/backend/tests/reconciliation/*.test.ts
```

Extend `apps/backend/src/contracts/reconciliation.ts` only for shared public types that the new module needs. Add a `test:reconciliation` package script and include it in `make test`; document the local operator commands and the model setting in `.env.example`/README if setup changes. Keep the existing `RECONCILIATION_MODEL`, `RECONCILIATION_PROMPT_VERSION`, and `RECONCILIATION_SCHEMA_VERSION` values pinned on each job. Require a configured model that supports Responses strict structured output and the bounded context; verify that model with a manual fixture before relying on it. Use native `fetch`, existing Zod, and the already installed Temporal polyfill. No new dependency is expected.

## 3. Interfaces and execution stages

```ts
interface ReconciliationRepository {
  claimNext(): Promise<ClaimedExtraction | null>;
  recordFailure(claim: JobClaim, failure: JobFailure): Promise<"updated" | "stale">;
  retryBlocked(jobId: UUID, reason: string): Promise<void>;
  skipBlocked(jobId: UUID, reason: string): Promise<void>;
}

type ClaimedExtraction = Readonly<{
  claim: JobClaim;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  sessionTimezone: string;
  sessionStartedAt: string;
  newParts: readonly CompletedUserPart[];
  earlierParts: readonly CompletedUserPart[];
  mind: MindSnapshot;
  validationFeedback: string | null;
}>;

interface TextExtractor {
  extract(input: ExtractionInput, signal: AbortSignal): Promise<ExtractionOutcome>;
}

type ExtractionOutcome =
  | { kind: "success"; proposals: readonly ProposedChange[] }
  | { kind: "refusal" }
  | { kind: "incomplete" }
  | { kind: "invalid_output"; code: string };

interface ReconciliationWorker {
  tick(): Promise<"idle" | "applied" | "deferred" | "blocked">;
}
```

`CompletedUserPart` includes its transcript part ID, item ID, item ordinal, content index, final text, and frozen `time_anchor_at`. `sessionStartedAt` comes from `voice_sessions.created_at`. The complete Mind snapshot retains deleted records for history; the reconciliation claim projects active memories and non-deleted commitments with IDs, entity versions, and manual override flags. A fresh user statement may create a new record after deletion without mutating the tombstone. Include only completed **user** parts in model context; assistant items only establish ordering. The new range is `[fromOrdinal, throughOrdinal]`; earlier parts in the same sealed prefix are context, not fresh evidence by themselves. Every proposed change needs at least one source in the new range. `validationFeedback` is synthesized from the prior attempt's persisted safe `last_error_code`, so a retry after process restart behaves the same way without another table.

Implement in stages. Each stage is independently testable with seeded PostgreSQL state; no stage depends on a later one:

| Stage | Depends on | Deliverable | Independent check |
| --- | --- | --- | --- |
| 4A: claim/read | Layers 1–2 | Repository claims jobs and returns a consistent immutable input | Seed jobs and snapshots; test FIFO, leases, hash/gap rejection, two connections |
| 4B: extract/validate | 4A's input type; model can be stubbed | Strict Responses adapter, prompt, semantic and time validation | Pure fixtures and mocked HTTP; one optional live model fixture |
| 4C: worker/recovery | 4A–4B and existing Mind writer | Poll, apply, retry/block, operator commands, lifecycle | Database integration tests with fake extractor; restart and stale worker races |

The database-backed 4A tests can run without layer 3 by seeding complete transcript rows and jobs through layer 2's existing ingestion/sealing helpers or minimal SQL fixtures that respect its invariants. The 4B validator tests need no database. The 4C integration suite uses a fake `TextExtractor`; a real OpenAI call is a separate manual smoke test.

## 4. Job selection, claim, and consistent input

The durable job row is the trigger. On startup, immediately scan pending jobs and expired claims; then poll once per second with a non-overlapping in-process loop. An ingestion wakeup may be added only as a latency optimization. Run at most one model extraction at a time in this backend process. The database lease and fencing still protect against an accidental second process or a late worker.

For each user, sort unfinished jobs by `(voice_sessions.session_seq, reconciliation_jobs.from_ordinal, reconciliation_jobs.id)`. An earlier `pending`, `running`, `retry_wait`, or `blocked` job prevents later jobs for that user. A `retry_wait` job is eligible only when `available_at <= database now`; a blocked job is never automatically eligible. Selection may skip a blocked user and process an eligible user. Never claim a batch whose session `applied_through` is not `from_ordinal - 1`.

Claim in one `READ COMMITTED` transaction using the existing lock order: lock the candidate user's `mind_state`, then the session, then the job, and recheck eligibility after locking. Keep locks while reading Mind and the transcript prefix, since all Mind writes first lock `mind_state` and sealing/ingestion respects the session lock. Use deterministic user ordering and `SKIP LOCKED` or an equivalent nonblocking candidate scan so one busy user does not hold up another. Reclaim an expired `running` job as retry-wait, or block it if its attempt budget is exhausted, under the same locks. The old token is invalid immediately. For a new claim, increment `attempts`, generate a new UUID `claim_token`, set `lease_until` to database now plus 90 seconds, and store the current `mind_state.revision` in `base_mind_revision`. The existing partial unique index permits only one running job per user.

Read the current Mind projection and ordered completed user transcript prefix `1..throughOrdinal` in that claim transaction. Confirm no ordinal gaps, every user item/part is complete, part count and `content_index` are contiguous, text hashes match final text, and the recomputed `hashTranscriptInput(timezone, parts)` equals the job's `input_hash`. Return exact transcript text and frozen anchors; no network request occurs while the transaction is open. Use the same row mappers as `MindReader`, but do not call `MindReader.getSnapshot()` in a separate transaction after claiming: a manual edit could then produce a snapshot different from the claim's base revision. Treat a hash/order failure as a safe blocked integrity error; never send a partial prefix to the model.

Before the provider call, bound serialized UTF-8 user transcript context to 64 KiB and serialized Mind projection to 128 KiB. Include active memories and non-deleted commitments, including manual overrides and completed/dismissed commitments; retain tombstones in the database for provenance but omit them from model context. Do not silently truncate. If a bound is exceeded, block the job with `context_limit` for explicit resolution. Do not add retrieval or summarization for this MVP.

## 5. Extraction request and proposal format

`OpenAITextExtractor` sends one `POST /v1/responses` request with the job's configured model, `store:false`, no tools, a 4,000 `max_output_tokens` ceiling, and strict `text.format` JSON Schema. Use a 45-second request timeout and no hidden client retries. The official [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create) describes the request and response fields; [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) documents strict JSON Schema, required fields, nullable optional values, and refusals. Parse the REST response's output items and completion status; do not assume an SDK-only convenience `output_text` field is present. Treat refusal and incomplete status as distinct outcomes, and never parse a refusal as a change set.

System/developer instructions and transcript data are separate inputs. The prompt states that speech is evidence to classify, never an instruction to the extractor. It asks for only facts/preferences as semantic memories, occurred events as episodic memories, and explicit user promises/tasks as commitments. Assistant suggestions alone create nothing. It must reuse a clear existing target for a repeat, correction, rescheduling, completion, or dismissal; collapse multiple mentions of one target to the final supported state; avoid manual-override targets; and return an empty list when no supported change exists. Priority 1 or 3 needs explicit user evidence; otherwise priority 2. Do not infer priority from a near due time.

Schema version `1` returns `{schema_version:"1", changes:[...]}` with at most 50 changes. Every object has `additionalProperties:false`; all fields are required in the strict wire schema, using `null` where inapplicable. Each proposal carries `entity`, `action`, nullable `target_id`/`expected_version`, a full nullable memory value, a full nullable commitment semantic value, and a nonempty `sources` array of `{part_id,evidence_text}`. Create uses null target/version; mutations use an existing ID and snapshot version. Memory fields are `kind`, `subject`, `predicate`, `content`, nullable `occurred_at`, and nullable `time_text`. Commitment semantic fields are `title`, nullable `subject`, `status`, `priority`, nullable `due_text`, and `due_precision`, plus **proposed** local date/time, timezone, explicit offset, or relative duration fields. The model does not assign entity IDs, versions, audit timestamps, `schedule_version`, or authoritative UTC `due_at`.

Represent exactly one supported resolved temporal form: explicit offset date-time, local date-time, local date, or relative seconds. Use nulls for unused fields; a `none` or `unresolved` due precision has no resolved form. The server maps the proposal to the existing `CommitmentValue` with authoritative `dueAt` and `dueTimezone`. Unsupported or ambiguous temporal language stays unresolved; never trust a model-provided UTC instant as authoritative. Keep the prompt and schema implementation versioned and reject an unknown job prompt/schema version instead of silently using a newer prompt. The job's pinned model/version values remain unchanged across retries. Validation feedback on one invalid-output retry contains safe error codes and field paths, not raw private transcript text.

## 6. Server-side validation and time resolution

Parse the provider JSON with strict Zod schemas, then validate semantics against the claimed snapshot and prefix before calling `MindWriter.applyExtraction`. Convert wire snake_case to the existing `ValidatedChangeSet` shape. Check entity/action combinations, full values, nullable target rules, target ownership and version, manual override, unique target mutation, unique source part per proposal, verbatim evidence substring, and at least one new-range source. Enforce status transitions and memory kind invariants. Reject a proposed destructive update when the target is doubtful; do not guess from a pronoun. Compare proposed values with existing values and remove identical repeats. A no-op or empty batch still goes to `applyExtraction` to mark the job succeeded and advance the cursor. The writer remains the final authority and repeats transactional checks after model latency.

Resolve dates with the installed Temporal polyfill using explicit IANA timezone validation and `disambiguation:"reject"`. Use the frozen source turn's `time_anchor_at` for relative language; if no anchor exists, leave it unresolved. Explicit offset timestamps retain that instant. Local date/time uses the spoken zone if present, else the session's saved zone. “Tomorrow at 9 AM” advances a local calendar day. Date-only “on/by Friday” becomes 09:00 on that date; “before Friday” becomes 09:00 on the prior local day. The next named weekday includes today, even if the default time has passed. Ambiguous AM/PM, vague or conditional deadlines, and nonexistent/ambiguous DST times are unresolved. Do not approximate a calendar day with 24 hours. Preserve the user's `due_text` and resolved precision. A past resolved due time remains past, making it eligible when later-layer scheduling starts. Tests must compare the proposed date/zone with the quoted evidence so a schema-valid but unsupported model guess cannot silently schedule a task.

For a new commitment, a promise and its completion within the same batch can yield one `completed` record with both evidence sources. For an existing commitment, `update` preserves status, `complete` and `dismiss` close an open record, and `reopen` requires explicit fresh user intent. Keep provenance for every applied change. After validation, `MindWriter.applyExtraction` orders memory writes before commitments and orders commitment writes by `(priority, due_at NULLS LAST, source ordinal, target ID)`; readers and the later scheduler still sort explicitly instead of relying on insertion order.

## 7. Failure, retry, and operator policy

Classify failures without logging raw transcript text, model output, memory content, API keys, or provider request bodies. Persist bounded safe `last_error_code` values and structured metadata containing job ID, attempt, state, and duration. Every failure transition locks `mind_state`, session, and job in the standard order and checks the current token; a late worker may neither apply nor change the replacement claim's state. Set `claim_token`, `lease_until`, and `base_mind_revision` to null when leaving `running`. Use database time for `available_at` and lease comparisons.

| Failure | Durable transition |
| --- | --- |
| Network error, 45-second timeout, retryable HTTP 429/5xx | `retry_wait` for 5 seconds after attempt 1, 30 seconds after attempt 2; block after attempt 3. Honor a longer `Retry-After` up to 5 minutes. A non-rate billing/quota 429 is configuration-blocked. |
| Invalid JSON/schema/domain proposal or incomplete model output | One feedback retry, then `blocked`, also subject to the 3-attempt total ceiling. |
| Refusal, context bound, unsupported prompt/schema/model, HTTP 400/401/403 | `blocked` immediately with a safe code. |
| Mind revision/version conflict during apply | Discard the proposal; `retry_wait` after 1 second with a fresh claim/snapshot next time, within the 3-attempt ceiling. |
| Expired 90-second lease | Reclaim with a new token or block if all attempts were consumed. A late result is a `stale_claim` no-op. |
| Database failure before commit | Let the transaction roll back and surface a background error; durable job state/lease drives recovery. |
| Lost commit acknowledgment | Reload job state by ID before retrying: `succeeded` means do not apply again; otherwise use normal fenced recovery. |

Distinguish provider errors using its status/body codes, never the text of an arbitrary error message. The official [API error guide](https://developers.openai.com/api/docs/guides/error-codes) and [rate-limit guide](https://developers.openai.com/api/docs/guides/rate-limits) inform status and `Retry-After` handling. Parse both delta-seconds and HTTP-date `Retry-After`, clamp to five minutes, and ignore invalid values. No automatic skip. A blocked job holds subsequent jobs for that user, and its range, safe code, and attempt count remain queryable in PostgreSQL.

Provide local `bun` operator commands, using the existing database connection and no new service, for `retry <job-id> --reason ...` and `skip <job-id> --reason ...`. Require a bounded nonempty reason and log the operation without private content. Retry is valid only for `blocked`: reset attempts, clear error/finish/claim fields, set pending/available now, retain the original range/hash/model/prompt/schema, and store `resolution_note`. Skip is valid only for the earliest blocked job with `applied_through = from_ordinal - 1`; under one transaction, mark it skipped, preserve source rows, set `finished_at`, advance `applied_through` to `through_ordinal`, and increment Mind revision without semantic writes. Both operations must be safe against concurrent claims and reject a stale operator view. A succeeded or skipped older range is never automatically reprocessed after newer work.

The server starts the worker beside the transcript scan and session supervisor. `startReconciliationLoop` runs one immediate tick, then one-second non-overlapping polls. Integrate its failure callback with existing readiness/shutdown handling; abort an in-flight model request on shutdown, stop polling, and leave a claimed job for lease recovery rather than recording a misleading success. Do not swallow database errors or leave untracked background promises.

## 8. Acceptance and verification

Use the existing PostgreSQL-in-Docker test setup. Add focused repository tests for claim ordering across sessions/users, blocked and retry-wait FIFO, cursor checks, complete-prefix/hash verification, 90-second expiry, attempt ceiling, and two-connection claim races. Use a fake model for worker tests: two batches where a repeat is a no-op, a correction updates the same memory, a promise creates one commitment, and a later completion closes it with provenance. Assert empty batches advance the cursor and that malformed evidence, cross-user IDs, invalid transitions, and a failed apply leave no partial writes.

Test a stale-result race with two database connections: worker A claims, expires, B reclaims and applies, then A returns; A changes zero rows. Test a manual memory edit during model latency; the old patch is discarded and retried from a fresh snapshot. Test retry delays and attempt limits with a controlled clock/provider stub, refusal/incomplete/invalid output, HTTP error classifications, process restart lease recovery, operator retry/skip, and `Retry-After` parsing. Pure time tests cover timezone fallback, relative anchor, date-only defaults, past deadlines, DST gaps/overlaps, and unresolved language. Mock Responses HTTP to verify `store:false`, strict schema, no tools, token limit, refusal/incomplete parsing, and no hidden retry. Logs must omit private transcript/Mind text.

Run `bun run check-types`, `bun run lint`, `bun run test:reconciliation`, then `make test` with Docker PostgreSQL. Run one small **manual** fixture against the configured OpenAI model to verify current strict-schema support and inspect extraction quality; keep it outside deterministic CI and never treat it as proof that the model is infallible. Layer 4 is accepted when the fake-model integration path passes, blocked work remains visible and ordered, and an expired or stale worker cannot overwrite newer Mind state. The later scheduler remains a separate layer.
