# Layer 2 implementation plan: transcript ingestion and ordered batches

Status: implemented and verified with synthetic events; live sideband hookup is layer 3
Architecture source: [Openloop MVP architecture](../docs/mvp-architecture.md), section 4
Prerequisite: [layer 1](layer-1-implementation.md)
Scope: backend transcript ingestion and reconciliation-job creation only

## 1. Outcome and boundary

Layer 2 accepts validated Realtime server events from an injected event source, persists final transcript data in Mind, reconstructs conversation order from provider item links, and creates durable reconciliation jobs only for complete ordered user turns. It runs and passes tests without a browser, WebRTC, a sideband connection, an OpenAI key, a text model, or a reconciler worker. Layer 3 will attach the real sideband and call these interfaces; layer 4 will consume the jobs. Neither is imported here.

The layer does **not** extract facts, call a model, schedule commitments, accept browser-submitted transcript text, or persist audio or partial transcription deltas. The existing `transcript_items`, `transcript_parts`, `voice_sessions`, and `reconciliation_jobs` tables are sufficient. Do not add a queue service, event ledger, or migration unless implementation proves a specific invariant cannot be maintained with those tables.

OpenAI's [Realtime transcription guide](https://developers.openai.com/api/docs/guides/realtime-transcription#handle-transcript-events) says completion events for different turns can arrive out of order. The [server-event reference](https://developers.openai.com/api/reference/resources/realtime/server-events) supplies item IDs, optional predecessor links, final transcript events, and response statuses. The plan treats their event payloads as untrusted input; the ordering, gap, and close policies below are Openloop decisions.

## 2. Repository integration and deliverables

Reuse `src/contracts/{common,sessions,transcripts,reconciliation}.ts`, `db/transaction.ts`, `mind/extraction-apply.ts`'s `hashTranscriptInput`, and the layer-1 SQL schema. Keep row mapping inside a new `src/transcripts` domain module. Modify `src/contracts/index.ts` to export the new contracts. Add `apps/backend/tests/transcripts` using the existing Docker Postgres test helper. Extend the root test script and Make target so the layer can be checked independently.

Expected files (exact small-module split may change):

```text
apps/backend/src/contracts/transcript-ingestion.ts
apps/backend/src/transcripts/normalize.ts
apps/backend/src/transcripts/ingest.ts
apps/backend/src/transcripts/assemble.ts
apps/backend/src/transcripts/batch.ts
apps/backend/src/transcripts/capture.ts
apps/backend/src/transcripts/index.ts
apps/backend/tests/transcripts/*.test.ts
```

Do not change layer-1 public Mind read/write signatures, job hashing, or the initial migration in place. If a schema change becomes unavoidable, add `0002_*.sql` and a focused migration test. Update the architecture document first if the change alters a locked decision.

## 3. Public interfaces

Define strict Zod schemas and inferred immutable TypeScript types. IDs in provider events are bounded non-empty opaque strings, not sortable numbers; application IDs are the existing branded UUIDs. Capture epochs use the existing decimal-string `Counter`. All timestamps returned to callers use `Timestamp`. No event carries an authoritative user ID.

```ts
type NormalizedEvent =
  | ItemMetadataEvent       // item identity, type/role/status, optional predecessor, content layout
  | UserCommittedEvent      // item ID, optional predecessor
  | SpeechBoundaryEvent     // item ID, start/stop, optional audio offset
  | UserPartFinalEvent      // item ID, content index, exact final text
  | UserPartFailedEvent     // item ID, content index, bounded error code
  | AssistantResponseEvent // response ID/status and final output item summaries
  | AssistantTruncatedEvent
  | ItemDeletedEvent;

type NormalizeResult =
  | { kind: "event"; event: NormalizedEvent }
  | { kind: "ignored" };

type CloseReason =
  | "clean" | "drain_timeout" | "gap_timeout" | "sideband_lost"
  | "browser_lost" | "queue_overflow" | "integrity_error" | "restart";
type IngestResult = Readonly<{
  status: "stored" | "duplicate" | "ignored" | "capture_closed";
  sessionId: UUID;
  itemId: UUID | null;
}>;
type BatchResult = Readonly<{
  jobs: readonly { id: UUID; fromOrdinal: number; throughOrdinal: number }[];
  orderedThrough: number;
  sealedThrough: number;
}>;
type CaptureSummary = Readonly<{
  state: "draining" | "closed" | "incomplete";
  sealedThrough: number;
  reason: CloseReason | null;
}>;

interface TranscriptIngestor {
  ingest(sessionId: UUID, epoch: Counter, event: NormalizedEvent): Promise<IngestResult>;
  sealReadyPrefix(scope: UserScope, sessionId: UUID, cause: "timer" | "close"): Promise<BatchResult>;
  finishCapture(scope: UserScope, sessionId: UUID, reason: CloseReason): Promise<CaptureSummary>;
  recoverOpenCaptures(): Promise<readonly CaptureSummary[]>;
}
```

`normalizeServerEvent(payload: unknown, receivedAt: Timestamp): NormalizeResult` is pure and has no database access. Reject malformed supported events with a typed validation error. Ignore known deltas, audio bytes, usage counters, and unrelated session/response diagnostics. Unknown events that imply an unsupported conversation item mutation are not silently ignored: represent them as a terminal capture error. `IngestResult` reports `stored`, `duplicate`, `ignored`, or `capture_closed`, along with session/item identity and current capture state. A conflicting event raises a typed integrity error after durably marking the capture incomplete. `BatchResult` contains created job IDs/ranges and the final `orderedThrough`/`sealedThrough`; `CaptureSummary` reports `closed`, `incomplete`, or `draining`, the safe sealed boundary, and a bounded reason code. Domain text and raw provider payloads never appear in errors or operational logs.

Pass `{ model, promptVersion, schemaVersion }` into the ingestor/batcher constructor so each job records immutable extraction configuration. The values are injected test strings in layer 2; selection of a real model belongs to layer 4. Use a tiny injectable clock for deterministic gap/drain tests. `receivedAt` is stamped by the backend before normalization, not accepted from the provider JSON.

Layer 3 must call `ingest` using the session ID and epoch it obtained from its saved sideband association. There is no public HTTP transcript-write route. For a real sideband, one bounded serial async queue per connection awaits each `ingest` call; relevant queue capacity is 1,000. An ignored delta never occupies this queue. Queue overflow, failed persistence, or cancellation closes capture as incomplete and stops accepting events. The queue can be tested with a fake event source in this layer; it has no WebSocket dependency.

## 4. Normalization rules

Normalize only the fields the database needs. Preserve whether `previous_item_id` is **absent** (`predecessorKnown=false`) or explicitly `null` (`predecessorKnown=true`, root). Never infer conversation order from `event_id`, item ID, response ID, completion time, or receipt time. Validate `event_id`, item ID, content index, status, and bounded text/error fields before a DB write. Drop base64 audio from item/response payloads immediately.

| Realtime server event | Normalized action |
| --- | --- |
| `conversation.item.created`, `.added`, `.done` | Upsert item identity, role/type, optional predecessor, and definitive content layout when supplied. A user item being `done` does not mean its input transcription is final. Both `created` and `added` are accepted because the current server-event reference documents both forms. |
| `input_audio_buffer.committed` | Upsert a user placeholder, store first observed `committedAt`, and merge its optional predecessor. |
| `input_audio_buffer.speech_started`, `.speech_stopped` | Upsert a placeholder keyed by item ID; record first observed boundary time and non-negative audio position. No transcript text. |
| `conversation.item.input_audio_transcription.completed` | Upsert final user `user_audio` part keyed by `(item, content_index)`, including exact text (empty string is valid), event ID, SHA-256, and completion time. This is the **only** authority for user transcript text. |
| `conversation.item.input_audio_transcription.failed` | Mark that user part failed with a bounded code; block sealing across it. Do not store the provider's free-form error message. |
| `response.done` | Read terminal response status and output items. Persist assistant text only for completed assistant message items in a completed response; map `output_audio` transcript to `assistant_audio` and `output_text` text to `assistant_text`. Cancelled, failed, or incomplete output is interrupted. A completed assistant item with no usable text remains a structural ordering node. |
| `conversation.item.truncated` | Mark the assistant item/part interrupted and preserve its position; never infer a heard-text prefix from `audio_end_ms`. |
| `conversation.item.deleted` or a known unsupported item/content mutation | Mark capture incomplete with a bounded reason. Do not remove an already recorded ordering node or change a sealed batch. |
| Transcript/text/audio delta, `response.output_*` delta/done, and `response.content_part.done` | Do not persist as authoritative text. `response.done` is the assistant terminal source; a per-part `done` can also occur for interrupted responses. |

For voice-only user items, definitive content metadata must say `type=message`, `role=user`, with one or more `input_audio` parts at contiguous indexes `0..N-1`. A provisional empty `content` array in an in-progress item is **not** a definitive zero-part turn. `expected_parts` remains null until a completed item layout establishes it. A final transcription may precede that metadata and creates a placeholder; it cannot make the item eligible by itself. Unsupported user text/image content or an `other` item blocks the prefix and makes capture incomplete rather than losing a turn.

An assistant item may appear before its `response.done` or have no saved transcript. Its known identity and predecessor are enough to walk the chain. Layer 2 never includes assistant text in the reconciliation hash or extraction evidence. If a terminal assistant text disagrees with an existing final value, treat it as an integrity conflict; do not overwrite it.

## 5. Persistence transaction and idempotency

For each relevant event, `ingest` uses one short `READ COMMITTED` transaction: lock the owning `mind_state` row, then `voice_sessions` row, then affected item and part rows. Check the supplied epoch and require an active/draining capture; terminal or stale-epoch events return `capture_closed` without writing. Derive `user_id` and timezone from the session. Upsert by `(session_id, provider_item_id)` and `(item_id, content_index)` using application UUIDs for new rows. Store only final text and essential metadata; do not add a raw-event table.

Merge fields monotonically:

- Unknown predecessor/role/layout may become known. A known value cannot change to a different known value. Explicit root (`null`) cannot later become a non-root link.
- First observed committed/speech time and provider offsets remain stable on retries. Identical duplicates return `duplicate`; changed repeated values are conflicts, except a later optional speech boundary may fill a previously missing field.
- A final part may move `pending → complete` or `pending → failed`. Identical replays are no-ops. Complete text/hash may never change, even under a new event ID. Failure and final completion for the same part conflict; no invented recovery from a failed transcription.
- Mark a user item `complete` only after definitive expected count is known and every indexed user part is complete. `''` is a completed silence part, but it provides no extraction evidence. Do not set `terminal_at` merely because item metadata says `done`.
- Preserve a sealed **user** item's `time_anchor_at`, role, predecessor, expected count, part text/hash, and eligibility state. A late no-op is allowed; a substantive change fails capture. A sealed assistant node may later become interrupted without changing its structural identity or a job hash. Late speech metadata may fill inspection fields but cannot recompute a frozen anchor or job hash.

Run the ordering assembler after each structural change under the same session lock; persist any newly proven ordinals and `ordered_through` atomically. Do not advance `sealed_through` or create a job in the item-ingest transaction except through the explicit batch operation. On an irreconcilable conflict, roll back the attempted event, then in a separate locked finalization transaction seal every already-safe prefix, mark the session incomplete, set a bounded `error_code`/`close_reason`, increment `capture_epoch`, and exclude known unsealed suffix rows. The caller must stop capture; do not retry the conflicting payload as though it were transient. A database outage is a persistence failure, not a successful ingest; stop the source and make incompleteness visible when DB access returns.

## 6. Conversation assembly and completeness

`assemble` reads all items of one session under the session lock. Treat provider item IDs as opaque. A confirmed root is exactly one item with `predecessorKnown=true` and `previousItemId=null`. Walk successor links through user **and** assistant nodes. Assign ordinals `1..N` only for the unique connected prefix. Unlinked placeholders keep `ordinal=null` and appear as gaps through the layer-1 transcript reader. A missing predecessor or an item whose predecessor is still unknown stops the prefix; it never authorizes sorting by arrival time. Multiple roots, two successors to one predecessor, cycles, role changes, or insertion before a sealed ordinal are integrity failures. Recompute and compare already assigned ordinals before updating; never renumber a sealed item.

`ordered_through` is the last contiguous **structural** ordinal, which can be greater than `sealed_through`. Extraction eligibility is stricter: every crossed node has known role/order; every user node has definitive count, complete parts at all indexes, and no failed/excluded state. Assistant nodes need only their ordering identity; unsupported `other` nodes stop. A known failed user part blocks later turns even if those later transcripts are complete.

Example fixture: U2 final text arrives before U1, with chain `U1 → A1 → U2`. Persist U2 as a placeholder/final part, but create no U2 job. Once the root, A1 link, both user layouts, and U1 final part are present, the safe prefix is U1, A1, U2. Job ranges use ordinals including A1; model input contains only the user parts. A `response.done` for A1 never substitutes for U1's transcription completion.

The provider offers no durable global “all transcripts complete” watermark. A ready prefix is therefore an Openloop assertion about **known** connected nodes. If later metadata would insert before a sealed boundary, report incomplete capture rather than silently changing earlier jobs. Previously applied extraction is not automatically undone; this is a stated MVP limit.

## 7. Batch creation and durable recovery

`sealReadyPrefix` takes the user and session locks in the established order and recomputes the safe prefix in the same transaction. Start at `sealed_through + 1`; choose the largest eligible boundary ending on a complete user item with at most **20 new user turns**. A batch may cross assistant nodes and may include earlier user turns as model context, but new ranges never overlap. If no new complete user turn is reachable, return an empty result without advancing the cursor. On clean close, loop until all currently safe user turns are sealed, not just the first 20.

Before insertion, freeze `time_anchor_at` for each newly crossed user item to its first stored `speech_stopped_at`, otherwise `committed_at`, otherwise null. Existing anchors are never changed. Build the input hash by calling the existing `hashTranscriptInput(session.timezone, parts)` with **all** complete user parts from ordinal 1 through the chosen boundary in `(ordinal, content_index)` order. Pass UUIDs, SHA-256 text hashes, and `time_anchor_at?.toISOString() ?? null` in the exact shape used by layer-1 `applyExtraction`. Do not introduce a second hash algorithm. Insert one `pending` job with `from_ordinal=old sealed_through+1`, `through_ordinal=boundary`, pinned model/prompt/schema values, then update `sealed_through` in the same transaction. The session lock plus unique `(session_id, from_ordinal)` makes repeated timer/restart scans idempotent. A forced insert failure rolls back the frozen anchors and cursor.

A 2-second in-process timer scans eligible active/draining sessions and calls `sealReadyPrefix`; tests may call it directly with a fake clock. The scan is an optimization, not a reliability source: on process restart, scan durable sessions and recover missing jobs from persisted items. Jobs are not started here. Layer 4 alone claims and runs them.

## 8. Gaps, close, and restart

While active, an unresolved known predecessor, missing definitive layout/part, or failed user part prevents sealing across that node. If a known gap remains for **30 seconds** from the earliest durable observation (`first_seen_at` or `committed_at`), the periodic scan ends capture as incomplete. Earlier safe user prefixes may still be sealed. Return a bounded gap reason and list unplaced/excluded items via existing transcript reads; never fabricate missing text.

Layer 3 owns microphone and sideband lifecycle. On graceful close it sets `close_requested_at` and state `draining`, disables microphone input, and keeps the transports alive for at most **10 seconds**. It calls `finishCapture` after the serial queue drains and either (a) every known committed user item/part is complete plus at least **1 second** without a relevant event since microphone disable, or (b) the deadline is reached. Layer 2 verifies the persisted close time and last relevant event time. If called too early, return `draining` without a terminal transition. Quiet time is a drain heuristic, not proof of missing-event absence. At the deadline, a missing link/part/utterance makes the session `incomplete`; a clean drain makes it `closed`. A dropped sideband/browser, queue overflow, gap timeout, or integrity error ends it incomplete immediately. Always seal all already safe batches under the user/session lock before terminal transition, then mark known unsealed suffix user items/parts excluded and increment `capture_epoch`. Terminal sessions reject late events; no replay of provider history is assumed.

At startup, `recoverOpenCaptures` finds sessions left in `initializing`, `connecting`, `active`, or `draining` by the previous process. It locks each user/session, seals only durable safe prefixes in repeated 20-user-turn batches, marks the rest incomplete/excluded, and fences the old epoch. Do not attempt sideband reconnection as a lossless replay. Already-created jobs remain pending. A later session can start only after this terminal transition, preserving cross-session job order. Recovery is safe to run twice and to race with a scan because both use the same locks.

`last_sideband_event_at` advances only for successfully ingested relevant events. Exclude an item only if it is beyond `sealed_through`; never rewrite sealed part content or remove provenance. Keep terminal reason codes short and content-free.

## 9. Independent implementation sequence and tests

Build and verify in this order, using fake events and the existing Docker test database. Each step depends only on earlier steps and layer 1.

| Step | Implementation | Independent check |
| --- | --- | --- |
| 1 | Contracts and pure normalizer | Fixture tests for each supported event, omitted versus null predecessor, malformed fields, ignored deltas, and removal of audio payloads. |
| 2 | Transactional item/part ingestion | Real-Postgres tests for completion-before-metadata, duplicate final, conflicting final, failed part, empty final text, multi-part layout, stale epoch, cross-session item ID isolation, and rollback. |
| 3 | Chain assembler | Real-Postgres tests for U2-before-U1, interleaved assistant node, unknown versus confirmed root, missing predecessor, branch, cycle, and late predecessor insertion after a seal. |
| 4 | Batch sealer and hash compatibility | Real-Postgres tests for 20-turn cap, exact ordinal ranges/hashes, frozen anchors, no empty job, concurrent/repeated seal, and insert-failure rollback. Call layer-1 `applyExtraction` with a test claim on a sealed job to prove the hash matches. |
| 5 | Capture drain, gap timer, and restart recovery | Fake-clock plus real-Postgres tests for 30-second gap, 1-second quiet window, 10-second deadline, repeated close/recovery, complete earlier prefix with excluded suffix, stale events after epoch fence, and a crash between ingestion and timer scan. |
| 6 | Bounded serial event processor | Inject delayed/failing writes and an event burst; prove FIFO, awaited persistence, ignored-delta bypass, overflow shutdown, and no unhandled async work. |

Use `beforeAll` migrations and explicit reverse-FK truncation between tests as in layer 1. Concurrency tests use separate pool connections with finite timeouts and release them in `finally`. Do not call OpenAI or mock PostgreSQL transactions. Include a no-content log assertion where applicable. Validation commands:

```sh
bun run db:migrate
bun test apps/backend/tests/transcripts
bun run check-types
bun run lint
bun test apps/backend/tests/mind
```

Update `README.md` with the layer-2 test command and the fact that real event attachment comes in layer 3. Keep the Docker Postgres setup from layer 1; no additional dependency or container is needed.

## 10. Completion gate

Layer 2 is complete when synthetic server events produce the same durable transcript and job ranges regardless of completion arrival order; no partial, failed, ambiguous, or unplaced user turn reaches a job; retries create no duplicate parts or jobs; stale epochs and late conflicting data cannot mutate sealed input; close and restart preserve every safe prefix and expose missing capture; and the new tests plus layer-1 checks pass. A developer must be able to inspect ordered turns, gaps, and pending jobs in PostgreSQL without starting Realtime or the reconciler.
