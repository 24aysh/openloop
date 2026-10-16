# Layer 1 implementation specification: contracts, PostgreSQL, and Mind

Status: ready for implementation
Architecture source: [Openloop MVP architecture](../docs/mvp-architecture.md)
Scope: layer 1 only

## 1. Goal

Layer 1 establishes the durable and typed foundation for Openloop. When this layer is complete, the application can create and query users, sessions, transcripts, memories, commitments, provenance, reconciliation jobs, and commitment log records in PostgreSQL. It can also apply manual Mind edits and validated extraction results with concurrency protection.

This layer must run and pass its tests without a browser, OpenAI connection, transcript worker, reconciler worker, or scheduler. Later layers depend on these contracts; layer 1 does not import them.

## 2. Deliverables

Implement the following artifacts under a new root application workspace. The local `intervue.ai` directory remains a read-only reference and is not modified or imported.

```text
openloop/
├── package.json
├── tsconfig.json
├── apps/
│   └── backend/
│       ├── package.json
│       ├── tsconfig.json
│       ├── src/
│       │   ├── config.ts
│       │   ├── db/
│       │   │   ├── pool.ts
│       │   │   ├── transaction.ts
│       │   │   └── types.ts
│       │   ├── contracts/
│       │   │   ├── common.ts
│       │   │   ├── errors.ts
│       │   │   ├── sessions.ts
│       │   │   ├── transcripts.ts
│       │   │   ├── reconciliation.ts
│       │   │   ├── memories.ts
│       │   │   ├── commitments.ts
│       │   │   └── index.ts
│       │   ├── mind/
│       │   │   ├── reader.ts
│       │   │   ├── writer.ts
│       │   │   ├── extraction-apply.ts
│       │   │   ├── pagination.ts
│       │   │   ├── snapshots.ts
│       │   │   └── index.ts
│       │   └── http/
│       │       ├── mind-routes.ts
│       │       └── error-response.ts
│       ├── migrations/
│       │   └── 0001_layer_1.sql
│       ├── scripts/
│       │   └── migrate.ts
│       └── tests/
│           ├── helpers/
│           │   ├── database.ts
│           │   ├── factories.ts
│           │   └── assertions.ts
│           └── mind/
│               ├── migration.test.ts
│               ├── constraints.test.ts
│               ├── reader.test.ts
│               ├── manual-writes.test.ts
│               ├── extraction-apply.test.ts
│               ├── provenance.test.ts
│               ├── pagination.test.ts
│               └── isolation.test.ts
└── specs/
    └── layer-1-implementation.md
```

The exact file split may be adjusted if implementation reveals a clearer small-module boundary. The public exports, database behavior, and tests in this specification remain required.

## 3. Technology and dependency decisions

Use Bun and strict TypeScript. Use these direct runtime dependencies:

- `express` for the HTTP adapter.
- `pg` for PostgreSQL access, explicit transactions, and row locks.
- `zod` for environment, query, route, cursor, and domain validation.
- `@js-temporal/polyfill` for IANA timezone validation and later date resolution. In layer 1, use it to validate user, session, and commitment timezone values.

Use Bun's built-in test runner. Do not add an ORM, migration framework, dependency-injection framework, test framework, queue, cache, UUID package, or logging framework for this layer. Generate UUIDs with `crypto.randomUUID()`.

Pin exact dependency versions in the lockfile. Configuration contains no defaults for secrets or database URLs. Tests receive a separate `TEST_DATABASE_URL` and refuse to run when it equals `DATABASE_URL`.

## 4. Public contracts

All public contracts live in `src/contracts`. Repository implementations may use internal database row types, but row shapes cannot escape the `mind` module.

### 4.1 Primitive types and validation

```ts
export type UUID = string & { readonly __brand: "UUID" };
export type Counter = string & { readonly __brand: "Counter" };
export type Timestamp = string & { readonly __brand: "Timestamp" };
export type Cursor = string & { readonly __brand: "Cursor" };

export type UserScope = Readonly<{ userId: UUID }>;
export type Versioned = Readonly<{ expectedVersion: Counter }>;
export type PageRequest = Readonly<{ limit: number; cursor: Cursor | null }>;
```

Parse these types at boundaries with Zod:

- `UUID`: canonical UUID string.
- `Counter`: base-10 digits only, no sign, no leading zeros except `"0"`; versions must additionally be at least `"1"`.
- `Timestamp`: ISO-8601 timestamp with an explicit UTC offset. Normalize output to UTC with millisecond precision.
- `PageRequest.limit`: integer 1–100, default 50 at the HTTP boundary.
- `Cursor`: URL-safe base64 encoding of versioned JSON. Reject unknown cursor versions, invalid shapes, values inconsistent with the endpoint, and payloads over 2 KiB.

Never convert PostgreSQL `bigint` values to JavaScript `number`. Configure the `pg` type parser for `int8` to return strings or map each field explicitly. Integer ordinals, priorities, attempts, positions, and limits fit PostgreSQL `integer`/`smallint` and may be numbers.

Use explicit field selection when mapping rows. Do not expose `SELECT *` results as domain objects.

### 4.2 Domain enums

Define Zod schemas and inferred TypeScript unions for every database enum-like check:

```ts
type VoiceSessionState =
  | "initializing" | "connecting" | "active" | "draining"
  | "closed" | "incomplete" | "failed";

type TranscriptRole = "unknown" | "user" | "assistant" | "other";
type TranscriptState = "pending" | "complete" | "failed" | "interrupted" | "excluded";
type TranscriptPartKind = "user_audio" | "assistant_audio" | "assistant_text";
type ReconciliationJobState = "pending" | "running" | "retry_wait" | "succeeded" | "blocked" | "skipped";
type MemoryKind = "semantic" | "episodic";
type MemoryState = "active" | "deleted";
type CommitmentStatus = "open" | "completed" | "dismissed";
type DuePrecision = "instant" | "date" | "unresolved" | "none";
type MindChangeOperation = "create" | "update" | "delete" | "complete" | "dismiss" | "reopen" | "release_override";
type MindChangeActor = "reconciler" | "user";
type Priority = 1 | 2 | 3;
```

The TypeScript and SQL value sets must match exactly. A test reads the constraints or attempts every valid/invalid value to prevent drift.

### 4.3 Read models

Define immutable return types for:

- `Memory`
- `Commitment`
- `TranscriptItem`
- `TranscriptPart`
- `TranscriptTurn`
- `TranscriptGap`
- `MindChange`
- `ChangeSource`
- `ChangeWithSources`
- `MindSnapshot`
- paginated memory, commitment, and transcript responses

Required object rules:

- IDs and counters use the branded string types.
- Timestamps are normalized strings; nullable database timestamps are `Timestamp | null`.
- `Memory` contains every semantic column in `memories` and no internal SQL metadata.
- `Commitment` contains every semantic column in `commitments`; `priority` is the numeric union.
- `TranscriptTurn` groups one placed transcript item with parts ordered by `contentIndex`.
- `TranscriptPage` contains `items`, `gaps`, and `nextCursor`. Unplaced items appear only in `gaps`, never fabricated into conversation order.
- `MindSnapshot` contains `revision`, all memories including deleted records, and all commitments including completed/dismissed records. Sort snapshot arrays by ID so model input serialization is deterministic in layer 4.
- `ChangeWithSources` contains the validated `afterState` plus source session/item/part identity and evidence text.

### 4.4 Write DTOs

Use strict Zod objects with `additionalProperties` rejected.

```ts
type MemoryEdit = {
  expectedVersion: Counter;
  content?: string;
  subject?: string;
  predicate?: string;
  occurredAt?: Timestamp | null;
  timeText?: string | null;
  releaseManualOverride?: true;
};

type CommitmentEdit = {
  expectedVersion: Counter;
  title?: string;
  subject?: string | null;
  status?: CommitmentStatus;
  priority?: Priority;
  dueAt?: Timestamp | null;
  dueTimezone?: string | null;
  dueText?: string | null;
  duePrecision?: DuePrecision;
  releaseManualOverride?: true;
};
```

Rules:

- Require at least one edit field in addition to `expectedVersion`.
- Trim human-readable strings. Reject empty subject, predicate, content, title, timezone, and non-null time text.
- Set conservative maximum lengths: subject/predicate 200 characters, title 500, content 4,000, time text 500, error/resolution text as defined by the schema.
- Memory kind and all ownership/identity fields are immutable.
- Manual memory edits always set `manual_override=true`, except an edit containing only `releaseManualOverride:true`, which clears it.
- Manual commitment edits likewise set `manual_override=true`, except a release-only edit.
- Releasing an override is an explicit `release_override` change. It does not alter semantic fields or schedule version.
- `status=open` clears terminal timestamps; `completed` sets `completed_at` and clears `dismissed_at`; `dismissed` does the inverse. The database transaction supplies the timestamp.
- Validate due fields as one coherent tuple. `instant`/`date` require `dueAt`, `dueTimezone`, and `dueText`. `unresolved` requires null `dueAt`, a non-empty `dueText`, and permits a timezone. `none` requires null `dueAt`, `dueTimezone`, and `dueText`.
- Validate IANA timezones through Temporal, not a regular expression.
- Changing `dueAt`, including null↔non-null, increments `schedule_version`. Reopening a terminal commitment increments it. Other edits do not.

`deleteMemory` takes only `expectedVersion`; it produces a tombstone with `state=deleted`, increments the entity version, sets manual override, appends a change, and increments the Mind revision. Repeating deletion against the old version is a version conflict. Deleting an already deleted record with its current version is invalid input rather than a new version.

### 4.5 Validated extraction input

Layer 1 does not call a model. It accepts only a `ValidatedChangeSet` created by layer 4's validator. Define the contract now so its transactional guarantees can be tested.

```ts
type JobClaim = Readonly<{
  userId: UUID;
  jobId: UUID;
  sessionId: UUID;
  claimToken: UUID;
  baseMindRevision: Counter;
  fromOrdinal: number;
  throughOrdinal: number;
  inputHash: string;
}>;

type EvidenceRef = Readonly<{
  transcriptPartId: UUID;
  evidenceText: string;
}>;

type ValidatedMemoryChange = Readonly<{
  entity: "memory";
  action: "create" | "update" | "delete";
  targetId: UUID | null;
  expectedVersion: Counter | null;
  value: MemoryCreateValue | MemoryReplacementValue | null;
  sources: readonly EvidenceRef[];
}>;

type ValidatedCommitmentChange = Readonly<{
  entity: "commitment";
  action: "create" | "update" | "complete" | "dismiss" | "reopen";
  targetId: UUID | null;
  expectedVersion: Counter | null;
  value: CommitmentCreateValue | CommitmentReplacementValue;
  sources: readonly EvidenceRef[];
}>;

type ValidatedChangeSet = Readonly<{
  changes: readonly (ValidatedMemoryChange | ValidatedCommitmentChange)[];
}>;
```

Even though the input is named validated, `applyExtraction` treats it as untrusted at the repository boundary. It repeats ownership, job-state, version, evidence, substring, action/value, duplicate-target, range, override, and due-tuple checks inside the transaction. The contract contains no database-generated timestamps, versions, schedule versions, audit actor, or ownership fields.

Return:

```ts
type ApplyResult = Readonly<{
  mindRevision: Counter;
  appliedThrough: number;
  createdMemoryIds: readonly UUID[];
  updatedMemoryIds: readonly UUID[];
  createdCommitmentIds: readonly UUID[];
  updatedCommitmentIds: readonly UUID[];
}>;
```

An empty change set is valid: it advances the applied cursor, increments Mind revision once, and succeeds the job atomically.

### 4.6 Errors

Expose a single typed error class with a closed code union:

```ts
type DomainErrorCode =
  | "not_found"
  | "invalid_input"
  | "version_conflict"
  | "capture_closed"
  | "ordering_gap"
  | "stale_claim"
  | "stale_snapshot"
  | "dependency_blocked";

class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}
```

Errors may include safe IDs, field names, and current version. They must not include transcript text, memory content, SQL strings, credentials, or raw database errors. Preserve database errors as `cause` for server diagnostics.

Map domain codes at the HTTP boundary:

| Code | HTTP |
| --- | --- |
| `invalid_input` | 400 |
| `not_found` | 404 |
| `version_conflict`, `capture_closed`, `ordering_gap`, `stale_claim`, `stale_snapshot`, `dependency_blocked` | 409 |
| unknown/infrastructure failure | 503 with `service_unavailable` |

## 5. PostgreSQL migration

Create one initial, forward-only migration at `apps/backend/migrations/0001_layer_1.sql`. Keep it understandable in dependency order. Do not modify the reference Prisma schema.

### 5.1 Migration order

Create objects in this order:

1. `users`
2. `mind_state`
3. `voice_sessions`
4. `transcript_items`
5. `transcript_parts`
6. `reconciliation_jobs`
7. `memories`
8. `commitments`
9. `mind_changes`
10. `change_sources`
11. `commitment_logs`
12. indexes and comments not already declared with their tables

Use text plus named `CHECK` constraints for domain states rather than PostgreSQL enums. This keeps later enum evolution migration-friendly while retaining database enforcement.

Use `CREATE TABLE`, not `IF NOT EXISTS`: applying a migration twice must fail or be prevented by the migration ledger, never silently accept a partially different schema.

### 5.2 Migration ledger and runner

The migration runner owns a small `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

Runner behavior:

1. Acquire a PostgreSQL advisory lock dedicated to Openloop migrations.
2. Discover `*.sql` files, sort lexicographically, and calculate SHA-256 checksums.
3. Refuse to continue if an applied version has a different checksum.
4. Apply each pending file and insert its ledger row in one transaction.
5. Release the connection, which releases the advisory lock.

`bun run db:migrate` runs the script. It accepts only `DATABASE_URL`; tests call the same runner with `TEST_DATABASE_URL` passed explicitly through the test helper.

### 5.3 Common SQL requirements

- Enable no PostgreSQL extensions. UUIDs are generated by application code.
- Every `created_at`/`updated_at` that should default locally uses `DEFAULT now()`. Repository updates set `updated_at=now()` explicitly.
- All FKs use `ON DELETE RESTRICT`.
- For each parent referenced by a composite user-scoped FK, declare `UNIQUE (user_id, id)`.
- Child tables carrying `user_id` use composite FKs so a valid child ID cannot be paired with another user's parent.
- Use named constraints so errors are diagnosable and tests can target them.
- Use `integer` for ordinals and bounded counters, `smallint` for priority, and `bigint` for revisions, versions, session sequences, and capture epochs.
- Use `CHECK (btrim(field) <> '')` for required text and length checks matching Zod.
- Store hashes as lowercase 64-character hexadecimal text with a format check.
- `after_state` is `jsonb` and must be a JSON object. Runtime code validates its domain schema before write and after read.

### 5.4 Table-specific constraints

Implement every column and index in architecture section 3.1, plus the following exact invariants.

#### Users and state

- `users.timezone` is not empty. Runtime validation provides IANA correctness.
- `mind_state.revision >= 0`, `next_session_seq >= 1`.
- Creating a user and its `mind_state` row is one transaction.

#### Voice sessions

- `session_seq >= 1`, `capture_epoch >= 1`.
- Cursors are non-negative and `applied_through <= sealed_through <= ordered_through`.
- Terminal states `closed`, `incomplete`, and `failed` require `closed_at`; non-terminal states require it null.
- `activated_at` is allowed only for active/draining/closed/incomplete sessions.
- Partial unique index permits at most one initializing/connecting/active/draining row per user.
- Unique `(user_id,start_request_id)`, `(user_id,session_seq)`, and non-null `call_id`.

#### Transcript items and parts

- `ordinal`, `expected_parts`, audio offsets, and content indexes are non-negative; ordinal begins at 1 when present.
- `audio_end_ms >= audio_start_ms` when both exist.
- `time_anchor_at` is null until frozen by the ingestion layer; layer 1 permits it only on a user item.
- Confirmed root means `predecessor_known=true` and `previous_item_id IS NULL`; unknown predecessor means `predecessor_known=false` and must also have null predecessor ID.
- A complete transcript part requires `final_text`, `final_event_id`, `text_hash`, and `completed_at`.
- Pending parts require all final fields null. Failed parts require `error_code` and no `final_text`/hash.
- Excluded or interrupted parts may retain a final result for inspection.
- Unique `(session_id,provider_item_id)`, partial unique `(session_id,ordinal) WHERE ordinal IS NOT NULL`, and `(item_id,content_index)`.

#### Reconciliation jobs

- `from_ordinal >= 1`, `through_ordinal >= from_ordinal`, `attempts >= 0`.
- `resolution_note` length is at most 500.
- Running rows require `claim_token`, `lease_until`, and `base_mind_revision`; every other state requires all three null.
- `finished_at` is non-null only for succeeded/blocked/skipped; those terminal states require it.
- Partial unique index permits one running job per user.
- Unique `(session_id,from_ordinal)`. Overlap prevention remains a transactional repository invariant because a simple unique constraint cannot express non-overlapping ranges without adding an unnecessary range/exclusion abstraction.

#### Memories

- `version >= 1`.
- Semantic memory requires null `occurred_at`; episodic memory may contain it.
- Deleted state is retained as a tombstone; do not blank its content.
- Required subject, predicate, and content lengths match contracts.

#### Commitments

- `version >= 1`, `schedule_version >= 1`, priority in 1–3.
- Open requires null terminal timestamps; completed requires only `completed_at`; dismissed requires only `dismissed_at`.
- `instant`/`date` require due time, timezone, and due text.
- `unresolved` requires null due time and non-null due text.
- `none` requires all three due values null.
- Partial due index: `(due_at,priority,created_at,id)` where open and due time is non-null.

#### Changes and evidence

- Exactly one of `memory_id` and `commitment_id` is non-null.
- Reconciler actor requires `job_id`; user actor requires it null.
- `entity_version >= 1`.
- Unique `(memory_id,entity_version)` and `(commitment_id,entity_version)`.
- Composite target FKs include user ID.
- `change_sources` has PK `(change_id,transcript_part_id)`, non-empty evidence text, and composite user-scoped FKs to both parents.
- PostgreSQL cannot assert substring evidence or “at least one source” across rows without procedural triggers. Enforce these in the single transactional repository path and prove rollback in integration tests. Do not add triggers for the MVP.

#### Commitment logs

- `schedule_version`, `commitment_version`, `batch_position >= 1`; attempts >= 0; priority 1–3.
- Unique `(commitment_id,schedule_version)` and `(batch_id,batch_position)`.
- Composite `(commitment_id,commitment_version)` references the corresponding unique commitment change revision. Include `user_id` in the target relationship so cross-user pairing is impossible.
- `emitted_at` null means eligible for future emitter handling; layer 1 does not run an emitter.

## 6. Database access foundation

### 6.1 Pool

Create one `pg.Pool` per backend process. Configuration is validated once and injected into repositories. Set:

- connection string from validated config;
- a finite connection timeout;
- an application name identifying Openloop;
- a small MVP pool size, default 10 and configurable;
- no statement-level logging of parameter values.

Expose explicit startup `SELECT 1` readiness and graceful `pool.end()`. Do not create pools inside request handlers or repositories.

### 6.2 Transaction helper

```ts
type IsolationLevel = "read committed" | "repeatable read" | "serializable";

async function withTransaction<T>(
  pool: Pool,
  options: { isolation: IsolationLevel },
  work: (client: PoolClient) => Promise<T>,
): Promise<T>;
```

Behavior:

- Checkout exactly one client.
- `BEGIN`, set the selected isolation level, execute work, and `COMMIT`.
- On failure, attempt `ROLLBACK`, preserve the original error, and always release the client.
- Never retry transactions implicitly. Repository methods decide whether a conflict is a typed domain error; workers in later layers own retry policy.
- Manual edits and extraction application use `READ COMMITTED` plus explicit row locks. Multi-query read snapshots use `REPEATABLE READ`.

### 6.3 Lock order

Every writer follows this exact sequence:

1. `mind_state` row for the user (`FOR UPDATE`).
2. `voice_sessions` row where needed.
3. `reconciliation_jobs` row where needed.
4. memory rows sorted by UUID.
5. commitment rows sorted by UUID.
6. commitment-log rows where needed.

If the requested user has no `mind_state`, return `not_found`. Never create it opportunistically during an unrelated write. Keep all external calls outside transactions.

## 7. Mind repository behavior

Expose implementations of these interfaces from `src/mind/index.ts`:

```ts
interface MindReader {
  getSnapshot(scope: UserScope): Promise<MindSnapshot>;
  listMemories(scope: UserScope, query: MemoryQuery & PageRequest): Promise<MemoryPage>;
  listCommitments(scope: UserScope, query: CommitmentQuery & PageRequest): Promise<CommitmentPage>;
  getTranscript(scope: UserScope, sessionId: UUID, page: PageRequest): Promise<TranscriptPage>;
  getProvenance(scope: UserScope, entity: EntityRef): Promise<readonly ChangeWithSources[]>;
}

interface MindWriter {
  editMemory(scope: UserScope, id: UUID, edit: MemoryEdit): Promise<Memory>;
  deleteMemory(scope: UserScope, id: UUID, guard: Versioned): Promise<Memory>;
  editCommitment(scope: UserScope, id: UUID, edit: CommitmentEdit): Promise<Commitment>;
  applyExtraction(claim: JobClaim, changes: ValidatedChangeSet): Promise<ApplyResult>;
}
```

### 7.1 Query behavior

All repository queries include `user_id=$scope.userId`; a record belonging to another user behaves as `not_found`.

Memory list filters:

- optional state, default active;
- optional kind;
- optional normalized subject;
- optional text matched against subject, predicate, and content using escaped `ILIKE` parameters;
- stable order `(updated_at DESC,id DESC)`.

Commitment list filters:

- optional status, default all;
- optional priority;
- optional `dueBefore` timestamp;
- stable order `(priority ASC,due_at ASC NULLS LAST,id ASC)`.

Transcript query:

- first verify the scoped session exists;
- placed items use `(ordinal ASC,content_index ASC)`;
- return items grouped into turns;
- return unplaced pending/failed items in `gaps`, sorted by first-seen time and ID;
- never interpret arrival order as conversation order.

Provenance query:

- verify the scoped entity exists, including tombstones/closed commitments;
- return changes in entity-version order;
- sources are ordered by transcript item ordinal then part content index;
- manual changes return an empty source list;
- validate every `after_state` with the correct versioned domain schema before returning it. Invalid stored JSON is an infrastructure/data-integrity failure, not an empty result.

Snapshot query:

- use one `REPEATABLE READ` transaction;
- verify the user state and read its revision;
- read all memories and commitments, including deleted/closed/overridden rows;
- sort both arrays by ID;
- do not include transcript text or changes.

### 7.2 Keyset pagination

Cursor JSON includes `v:1`, endpoint kind, the last row's complete sort key, and filters normalized into a stable fingerprint. Signatures are unnecessary for this local MVP, but cursors are opaque API values and fully validated. A cursor from another endpoint or changed filter set is invalid input.

Fetch `limit+1` rows. Return at most `limit`; derive `nextCursor` from the final returned row only when an additional row exists. Tests must cover equal timestamps, null due dates, page size one, deleted rows, and filter mismatch.

### 7.3 Manual memory transaction

`editMemory` and `deleteMemory` perform:

1. Validate DTO before opening the transaction.
2. Lock `mind_state`.
3. Lock the user-scoped memory by ID.
4. Return not-found or version-conflict as appropriate.
5. Validate state transition and build the full next record.
6. Increment memory version by one and set `updated_at` from database time.
7. Set/clear manual override according to the DTO rules.
8. Update the memory.
9. Insert one `mind_changes` row with actor `user`, operation, full validated `after_state`, and the new entity version.
10. Increment Mind revision by one and update its timestamp.
11. Commit and return the updated memory.

No-op semantic edits are rejected as invalid input. A release-only override edit is meaningful only when override is currently true.

### 7.4 Manual commitment transaction

Follow the memory transaction pattern. Additionally:

- derive terminal timestamps from the status transition;
- derive whether `schedule_version` increments;
- do not permit nonsensical transitions that merely repeat the current terminal state with no other change;
- validate the complete due tuple after applying the patch;
- insert a full commitment `after_state` change;
- increment Mind revision once regardless of the number of edited fields.

The change operation is `complete`, `dismiss`, or `reopen` when status changes accordingly; otherwise `update`, unless it is a release-only edit.

### 7.5 Atomic extraction application

Implement `applyExtraction` as the sole layer-1 path for reconciler changes:

1. Perform structural validation and reject more than 50 changes before opening the transaction.
2. Sort distinct target IDs to establish lock order. Reject duplicate existing targets and duplicate evidence refs per change.
3. Lock `mind_state`, session, job, target memories, and target commitments in the standard order.
4. Verify job user/session/range/hash against the claim.
5. Require job state running, matching claim token, and `lease_until > now()`.
6. Require current Mind revision equals the claim base revision.
7. Require session `applied_through = fromOrdinal - 1` and `sealed_through >= throughOrdinal`.
8. Verify every existing target's ownership, version, and `manual_override=false`.
9. Load every source through its user-scoped part/item/session relationship. Require user role, part state complete, source session equal to the job session, ordinal within the job's complete prefix, and at least one source ordinal in the new range.
10. Require `final_text.includes(evidenceText)` exactly and case-sensitively. Evidence text must be non-empty. This records what the model actually cited; normalization is not accepted as verbatim evidence.
11. Validate final replacement values and supported state transitions. Reject attempts to mutate IDs, ownership, versions, audit data, or overridden records.
12. Apply memory mutations first. Then apply commitment mutations sorted by priority, resolved due time with null last, earliest source ordinal, and target/new UUID.
13. Each mutation increments the entity version once, derives schedule version where applicable, writes the entity, inserts one `mind_changes` row with actor `reconciler`, and inserts all source rows.
14. Recheck that every reconciler change received at least one source. This is an in-memory/write-count assertion before commit.
15. Set session `applied_through=throughOrdinal`.
16. Mark the job succeeded, clear claim fields, set `finished_at`, and leave its immutable model/prompt/schema/input fields unchanged.
17. Increment Mind revision exactly once, including for an empty change set.
18. Commit and return IDs plus the new revision/cursor.

Any failure rolls back entities, audit rows, sources, cursor, job state, and Mind revision. Translate the claim-token/lease mismatch to `stale_claim`, revision mismatch to `stale_snapshot`, cursor/order mismatch to `dependency_blocked`, target version mismatch to `stale_snapshot`, and evidence/input failures to `invalid_input`.

Layer 1 does not claim jobs, retry jobs, interpret model output, or resolve natural-language dates. Tests create running claims and already-resolved values directly through factories.

## 8. HTTP adapter

Layer 1 provides the Mind routes but does not choose a production authentication provider. Accept a `UserScope` injected by a request-context middleware. The local demo middleware maps to the configured seeded user and binds only to localhost. Route handlers must never read `userId` from path, query, or body.

Implement:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/mind/memories` | Validated filters and keyset page. |
| GET | `/api/commitments` | Validated filters and keyset page. |
| GET | `/api/sessions/:sessionId/transcript` | Ordered completed transcript plus explicit gaps. |
| GET | `/api/mind/:entityType/:id/provenance` | `entityType` is exactly `memory` or `commitment`. |
| PATCH | `/api/mind/memories/:id` | Manual versioned edit. |
| DELETE | `/api/mind/memories/:id` | Version guard in a required JSON body for MVP consistency. |
| PATCH | `/api/commitments/:id` | Manual versioned edit/status transition. |

Rules:

- JSON only for mutation requests, maximum 32 KiB.
- Reject unknown fields and malformed IDs before repository calls.
- Success returns the full domain record or page using camelCase JSON.
- Errors use `{error:{code,message,details?}}`; messages are stable and contain no private content.
- GET routes have no side effects and never create jobs.
- No public endpoint exposes `applyExtraction`, raw SQL rows, job claims, commitment-log titles, or Mind snapshots.

## 9. Test implementation

Layer 1 acceptance relies on real PostgreSQL integration tests. Mocking `pg` is insufficient for constraints, locking, and atomicity.

### 9.1 Database isolation

Use a dedicated test database. Before a test file or isolated test transaction:

1. Confirm the database name contains an explicit test marker and differs from configured non-test database.
2. Run migrations once.
3. Truncate application tables in reverse FK order between tests using explicit table names and `RESTART IDENTITY`; never drop the database.
4. Seed UUIDs deterministically through factories where assertions benefit.

Tests that exercise concurrency use separate checked-out connections and commit/rollback explicitly. Give each such test a finite timeout and release connections in `finally`.

### 9.2 Required test matrix

#### Migration and constraints

- Empty database migrates successfully; second runner invocation is a no-op through the ledger.
- Changed checksum for an applied migration is rejected.
- Every enum/check accepts all valid values and rejects representative invalid values.
- Cross-user composite FK attempts fail for sessions, transcript parts, jobs, changes, evidence, and logs.
- One user cannot have two live sessions or two running jobs.
- Invalid cursor relationships, terminal timestamps, due tuples, part completion fields, and actor/job pairs fail.
- Deletes of referenced rows are restricted.

#### Readers

- Memory and commitment filters, default filters, deterministic sorting, and empty pages.
- Keyset pagination has no duplicates or omissions with tied timestamps/due times.
- Transcript order follows ordinal rather than creation time; unplaced rows appear as gaps.
- Snapshot includes tombstones, closed commitments, override flags, and a consistent revision.
- Provenance returns full chronological versions and ordered sources.
- Stored `after_state` of the wrong shape fails visibly.

#### Manual writers

- Successful edit updates entity, audit row, and Mind revision once.
- Missing entity and cross-user entity both return not found.
- Old expected version returns conflict and changes zero rows.
- Empty/no-op edits are rejected.
- Override release works only when currently set.
- Delete creates a tombstone and preserves prior evidence/history.
- Commitment status timestamps and schedule-version rules match the specification.
- Any forced audit insert failure rolls back the entity and Mind revision.

#### Extraction application

- Create/update/delete memory and create/update/complete/dismiss/reopen commitment paths.
- Multiple changes increment Mind revision once and entity versions separately.
- Empty change set advances cursor, succeeds job, and increments revision.
- Missing, incomplete, assistant, cross-session, cross-user, out-of-range, or non-verbatim evidence rolls back everything.
- Existing target with wrong version or override is rejected.
- Duplicate targets and more than 50 changes are rejected.
- Wrong/expired token, expired lease, revision mismatch, input hash mismatch, and cursor mismatch produce the correct error and zero writes.
- Two database connections simulate worker A and worker B. After B wins with a new token/revision, A's late result changes zero rows.
- Forced failure after entity update but before source/job update rolls back the complete transaction.
- Successful commitment writes create an entity-version change suitable for the commitment-log FK.

#### User isolation and HTTP

- Every read/write route is scoped to request context, regardless of IDs supplied by another user.
- Unknown request fields, invalid counters/cursors/timezones, oversized bodies, and malformed UUIDs return 400.
- Domain errors map to the specified status and safe body.
- Infrastructure failures return 503 without SQL/private data.
- GET routes leave row counts, revisions, and timestamps unchanged.

### 9.3 Validation commands

Implementation must provide and pass:

```sh
bun install
bun run db:migrate
bun test apps/backend/tests/mind
bun run check-types
bun run lint
```

If the repository chooses a workspace command wrapper, these exact capabilities may be exposed through equivalent root scripts. The README must state the actual commands and required PostgreSQL setup.

## 10. Implementation sequence

Build in this order so every step has a narrow verification target:

1. Root/backend package configuration, strict TypeScript, environment validation, pool, and test database safety checks.
2. Migration ledger/runner and the complete initial migration.
3. Branded primitive parsers, enums, domain read models, DTOs, and typed errors.
4. Row mappers and transaction helper.
5. Read repositories, snapshot behavior, and keyset pagination.
6. Manual memory/commitment write transactions and provenance.
7. Atomic extraction-apply transaction.
8. HTTP adapter and error mapping.
9. Full constraint/concurrency/rollback test matrix.
10. README commands and a final diff review.

Do not implement session initialization, Realtime event normalization, transcript-chain assembly, model extraction, job polling, scheduling ticks, or terminal emission in layer 1. Their database records and interfaces exist only to give later layers stable prerequisites.

## 11. Completion criteria

Layer 1 is complete only when all of the following are true:

- A fresh PostgreSQL database migrates deterministically and migration checksum drift is detected.
- All 11 domain/operational tables, required indexes, composite ownership FKs, and state checks exist.
- Public TypeScript contracts compile in strict mode without `any`, unchecked casts, or non-null assertions in domain/repository code.
- Bigint values remain exact decimal strings across SQL, repositories, and HTTP.
- All reads and writes are user-scoped.
- Manual memory/commitment edits are optimistic, audited, provenance-preserving, and atomic with Mind revision updates.
- `applyExtraction` atomically fences stale claims/snapshots and proves source-backed writes without importing an LLM.
- Transcript reads distinguish verified order from gaps.
- Keyset pagination is stable under tied sort values.
- Real-Postgres tests cover constraints, rollbacks, isolation, and two-connection concurrency.
- Typecheck, lint, migrations, and the Mind test suite pass from documented commands.
- No existing user-owned changes or the `intervue.ai` reference implementation are modified as part of the layer.

Passing this gate allows layer 2 transcript ingestion and layer 5 scheduling to begin independently against the stable layer-1 contracts.
