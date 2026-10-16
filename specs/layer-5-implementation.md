# Layer 5 implementation plan: commitment scheduling and backend logs

Status: implemented; deterministic PostgreSQL acceptance passed
Architecture source: [Openloop MVP architecture](../docs/mvp-architecture.md), section 7
Prerequisites: [layer 1](layer-1-implementation.md) only. Layers 2–4 are optional for implementation and tests; they can supply real commitments later.
Scope: turn eligible persisted commitments into durable, ordered log decisions and print those decisions in the backend terminal.

## 1. Outcome and boundary

An open commitment with a resolved `due_at` becomes eligible when PostgreSQL time reaches that instant. The scheduler records one `commitment_logs` row per `(commitment_id, schedule_version)`. A separate emitter prints each durable row as a structured terminal line and records its acknowledgment. The database row is the authoritative decision; terminal output can repeat after a crash, always with the same log ID.

This is the MVP's backend-only Act step. It does not send push/email/SMS, change a commitment's status, inject Mind into Realtime, create an admin UI, infer a new due time, or add recurrence, snooze, or lead-time reminders. `app-flow.md` puts user-facing reminders outside v0; the backend log is the explicit MVP demonstration of follow-through. No scheduler service, broker, notification table, migration, or new package is needed.

## 2. Reuse and expected files

Reuse the layer 1 `commitments`, `commitment_logs`, `mind_changes`, and `mind_state` tables, including `commitments_due`, `logs_unemitted`, the unique `(commitment_id,schedule_version)` and `(batch_id,batch_position)` constraints, and the FK from log commitment version to the exact `mind_changes` revision. Reuse `withTransaction`, typed UUID/version/timestamp parsing, existing PostgreSQL pool, test database helpers, and `seedCommitment`. The current manual writer and extraction apply path already increment `schedule_version` when `due_at` changes or a terminal commitment reopens. Layer 5 must not recalculate or increment it.

Expected changes when implementing:

```text
apps/backend/src/scheduling/{scheduler,log-emitter,loop,index}.ts
apps/backend/src/server.ts
apps/backend/tests/scheduling/layer5.test.ts
package.json
Makefile
README.md
```

Keep scheduler DTOs local to `scheduling` unless another existing module must consume them. Add `test:scheduling` and include it in `make test`. The server starts the loop next to transcript scanning, session supervision, and reconciliation, and stops it before closing the pool. No public HTTP route or environment variable is needed. The terminal event omits `title_snapshot` and all transcript/Mind text; the private title stays in PostgreSQL for authorized inspection.

## 3. Incremental build gates and interfaces

| Gate | Depends on | Deliverable | Independent proof |
| --- | --- | --- | --- |
| 5A: durable decision | Layer 1 schema and writers | `CommitmentScheduler.tick()` with transactional eligibility, ordering, and log inserts | Seed/manual-edit commitments in PostgreSQL; inspect rows and concurrency races without an emitter |
| 5B: terminal emission | Layer 1 log table; 5A code is not required | `CommitmentLogEmitter.flush()` with an injected sink and durable retry/ack | Seed log rows directly, use a fake sink, and test output failure and repeat after lost acknowledgment |
| 5C: backend lifecycle | 5A and 5B | Immediate startup scan and one-second non-overlapping loop | Start/stop with fake components; run the full database path without browser or OpenAI |

```ts
interface CommitmentScheduler {
  tick(): Promise<{ createdLogIds: UUID[] }>;
}

type TerminalEvent = Readonly<{
  event: "commitment_due";
  logId: UUID;
  commitmentId: UUID;
  commitmentVersion: Version;
  scheduleVersion: Version;
  priority: 1 | 2 | 3;
  dueAt: Timestamp;
  lateByMs: number;
  batchId: UUID;
  batchPosition: number;
}>;

interface TerminalSink {
  emit(event: TerminalEvent): Promise<void>;
}

interface CommitmentLogEmitter {
  flush(): Promise<{ emitted: number; remaining: number }>;
}
```

The production sink writes one JSON line to the backend terminal, awaiting write completion/backpressure. Tests inject a sink that records events or throws. Parse database IDs, bigint versions, priority, and timestamps at the repository boundary; do not coerce bigint versions to unsafe JavaScript numbers. `remaining` counts un-emitted rows, including rows delayed by retry. The scheduler and emitter do not need a user-facing interface or another dependency.

## 4. Eligibility and durable decision (5A)

`due_at` is the first logging instant. Only `status='open'`, non-null `due_at <= tick_time`, and an absent log for the current `schedule_version` qualify. Unresolved/absent due times and completed/dismissed commitments never qualify. A past due time becomes eligible on the first tick after persistence or backend recovery. Priority orders the **currently eligible set**: `(priority ASC, due_at ASC, created_at ASC, id ASC)`. A future high-priority item cannot block a due low-priority item. Do not infer urgency from lateness or silently move due times; layer 4 and manual edits own temporal meaning.

Run each tick in one `READ COMMITTED` transaction. First acquire a transaction-scoped advisory lock using a fixed, documented application key, for example `(776501,5)` via `pg_try_advisory_xact_lock`. If another scheduler holds it, return an empty result; the next poll retries. Find user IDs that appear to have due, unlogged work, then acquire their `mind_state` row locks in UUID order, one by one. Lock candidate commitment rows in ID order, following the project's normal `mind_state` → commitment → log lock order. **After locks are acquired**, read one fresh `clock_timestamp()` from PostgreSQL; `now()` would be frozen at transaction start and is not the decision time. Re-evaluate eligibility under the locks against that single timestamp. A commitment becoming due or a new user appearing just after the preliminary candidate scan is handled on the next tick.

Sort the locked eligible set in PostgreSQL by the ordering above, preserving its sub-millisecond timestamp precision. Generate one batch UUID for the tick and one UUID per log. Insert immutable snapshots of `user_id`, commitment ID, current `schedule_version` and `version`, `due_at`, `eligible_at=tick_time`, priority, title, batch ID, and one-based batch position. Set `emit_available_at=tick_time`; leave `emitted_at` null and attempts zero. The exact-version FK must resolve to the existing `mind_changes` row; a missing revision is an integrity error that rolls back the tick. Commit before any terminal output. Rely on the unique schedule key as a final duplicate guard, but recheck under locks rather than using conflicts to hide a broken race. Log insertion does not mutate commitments or Mind revision.

Completion/rescheduling that commits before the decision wins and prevents an obsolete log. If the scheduler commits first, its row remains valid history even if completion follows immediately. An as-yet-unreconciled spoken completion cannot suppress a due log. A later `due_at` change creates another schedule version; reopening a closed commitment does too. Title-only or priority-only edits keep the same schedule version and do not generate a second log for a version already logged. Clearing a due time makes the commitment ineligible until another resolved due time is saved.

## 5. Ordered terminal emission (5B)

Hold a **session-scoped** advisory lock with a separate fixed key, for example `(776501,6)`, on one dedicated PostgreSQL connection for the whole `flush`. Release it after success or failure, closing the connection if unlock fails. If another emitter holds it, return without output. This lock serializes terminal writers, including accidental second backend processes; it is distinct from the scheduler's transaction lock. Do not keep a database transaction open while writing to the terminal.

Read the oldest un-emitted log in `(eligible_at,batch_id,batch_position,id)` order, regardless of `emit_available_at`. If that oldest row is not yet available, stop: a failed earlier line holds later lines so terminal order remains stable. Build `TerminalEvent` from that row, with `lateByMs=max(0, terminal-attempt DB time - due_at)`; print the stable IDs, versions, priority, due time, lateness, and batch position, not title/private content. The line is a delivery attempt, not another scheduling decision.

After a successful sink call, acknowledge that row in a short transaction: lock its user's `mind_state` first, then the log row; recheck `emitted_at IS NULL` and set `emitted_at` from the database clock. If the sink throws, use the same lock order to increment `emit_attempts`, store the fixed safe code `terminal_write_failed`, and set `emit_available_at` to database time plus `min(60, 5 * 2^(failed_attempts-1))` seconds. Stop the flush after a failure. Do not log arbitrary exception messages or private payloads. A database failure propagates to the backend health handler; durable rows are retried after recovery. A crash after printing but before acknowledgment prints the same log ID again. Consumers/tests deduplicate by log ID; never claim exactly-once terminal lines.

## 6. Runtime integration and acceptance (5C)

Run an immediate scheduling-plus-emission pass on startup and then repeat every second with a non-overlapping in-process loop. Each pass calls `tick()` before `flush()`, so a delayed terminal row does not prevent new durable scheduling decisions. A sink failure is recorded by the emitter and leaves the process running; an unexpected database failure is reported through the existing background-error path and shutdown. `stop()` clears the timer and waits for the active pass before the shared pool closes. The loop must not create untracked promises or log private content.

Use PostgreSQL-in-Docker integration tests with an injected sink and controlled database timestamps. Acceptance cases:

- Before due time: no row. At/after due time: one row, including after a backend restart; unresolved/none, completed, and dismissed records have none.
- At one tick, high/normal/low due items log in that order; within a priority use due time, creation time, and ID. A future high-priority item never blocks a due low-priority one. Batch positions match row order.
- Two simultaneous ticks create one log per schedule version. Completion/rescheduling races produce either the old committed decision or the new state, never an invalid duplicate or a log for a state that committed before the decision.
- A due edit and a reopen produce the intended new schedule version and log. Title/priority-only edits do not relog a version already decided. Log rows retain the exact commitment revision and title/priority snapshot even after later edits.
- Sink failure persists attempts and bounded retry time, holds later rows, and then emits in order. Simulate output followed by lost acknowledgment: the durable row count stays one and the repeated terminal line has the same log ID.
- Startup catches overdue rows and un-emitted rows. Terminal events contain no title, transcript, API key, or Mind content. Logging does not change commitment status or `mind_state.revision`.

Run `bun run test:scheduling`, `bun run check-types`, `bun run lint`, then `make test` using the existing test database. Optionally run a local end-to-end demo with a seeded due commitment; no OpenAI call is needed to accept this layer. The healthy idle-backend target is a durable log within two seconds of a persisted due time, plus terminal sink latency. Downtime, queued reconciliation, capture gaps, and terminal failures can make output late; preserve the due and eligibility timestamps so that delay is visible.
