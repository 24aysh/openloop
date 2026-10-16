# Manual test: local Openloop MVP

This guide exercises the running browser, backend, and PostgreSQL database together. It uses the single demo user configured in `.env`. The live voice and extraction steps require an OpenAI API key with access to the configured Realtime, transcription, and Responses models; model output may differ from the example. The browser does not read Mind back into Realtime, and due commitments produce backend terminal logs, not user notifications.

Run the commands from the repository root unless a step says otherwise. Use local test data only: the SQL below displays transcript and memory content.

## 1. Start PostgreSQL and configure the app

Install Docker and Bun 1.3. On first setup, start the same PostgreSQL 18 container used in the README and create the application database:

```sh
docker run --rm -d --name openloop-layer1-postgres \
  -e POSTGRES_USER=openloop_test -e POSTGRES_PASSWORD=openloop_test \
  -e POSTGRES_DB=openloop_layer1_test -p 127.0.0.1:55440:5432 postgres:18.3
docker exec openloop-layer1-postgres psql -U openloop_test -d openloop_layer1_test \
  -c 'CREATE DATABASE openloop_dev'
```

If the container already exists and is running, keep it and skip `docker run`. Create `openloop_dev` only if it does not exist. This example uses `--rm`, so stopping the container removes its database files; leave it running while inspecting the data.

If `.env` does not exist yet, copy the example before editing it:

```sh
cp .env.example .env
bun install
bun run db:migrate
```

If `.env` already exists, keep it and run only `bun install` and `bun run db:migrate`. Edit your local `.env`: replace `OPENAI_API_KEY=replace-with-local-key` with a development key, and confirm the configured model IDs are available to that account. Keep `DATABASE_URL` pointed at `openloop_dev`, `DEMO_USER_ID` and `DEMO_USER_TIMEZONE` set to the intended demo user, and `PORT=3001`: the frontend proxy currently targets port 3001. Do not commit `.env` or paste the key into a terminal command. Migrations must succeed before starting the backend.

## 2. Run backend and browser

In terminal A:

```sh
bun apps/backend/src/server.ts
```

In terminal B:

```sh
bun run --cwd apps/frontend dev
```

Open `http://127.0.0.1:3000` in a browser with microphone access. The backend binds to `127.0.0.1:3001`; check it from a third terminal:

```sh
curl -i http://127.0.0.1:3001/health/ready
```

Expect HTTP 200 with `{"ok":true}`. The browser should show **Voice**, **Mind**, and **Commitments**. Keep terminal A visible for reconciliation diagnostics and eventual `commitment_due` JSON lines.

## 3. Speak, stop, and inspect the browser

1. Open **Voice**, click **Start conversation**, and grant microphone permission. Wait for `active` before speaking; capture readiness gates the microphone. Say a few distinct facts slowly, for example: “I discussed our project with Ananya on Tuesday. She likes science fiction movies. I promise to send Ananya the presentation tomorrow at 5 PM. That is high priority.” The assistant may respond conversationally; it does not use stored Mind memories in its reply.
2. Click **Stop**. The voice status should pass through draining and then reach `closed`, `incomplete`, `failed`, or an uncertain close state. A clean `closed` capture means recording ended; wait for the extraction backlog to reach zero and `appliedThrough` to reach `sealedThrough` before treating Mind as current. A blocked job or transcript gap is a real failure to investigate, not a successful extraction.
3. Click **Inspect transcript**. Check the completed user turn, its order, and any gap or failed item. If the spoken text is absent, do not expect it to appear in Mind. The browser stores no separate transcript copy; this view reads the backend transcript API.
4. Open **Mind** and **Commitments**, using **Refresh** after extraction completes. Look for a semantic preference, an episodic event, and an open presentation commitment. Wording and exact extraction are model dependent. Search Mind for “Ananya”, inspect **Sources**, and compare the quoted evidence with the transcript. If the model omitted or misinterpreted a fact, record that as an extraction-quality observation; check the job state below before blaming capture.

## 4. Inspect the PostgreSQL records

Open a PostgreSQL prompt in terminal C:

```sh
docker exec -it openloop-layer1-postgres psql -U openloop_test -d openloop_dev
```

At the `psql` prompt, use the `DEMO_USER_ID` from your `.env` (the value below is the example default). The `\gset` command selects the newest session for the following queries; rerun it after a later voice session.

```sql
\pset pager off
\x auto
\set demo_user 00000000-0000-4000-8000-000000000001
SELECT id AS session_id FROM voice_sessions
WHERE user_id = :'demo_user'::uuid ORDER BY session_seq DESC LIMIT 1 \gset
\echo Session: :session_id

SELECT session_seq, state, ordered_through, sealed_through, applied_through,
       close_reason, error_code, created_at, closed_at
FROM voice_sessions WHERE id = :'session_id'::uuid;

SELECT i.ordinal, i.role, i.state AS item_state, i.provider_item_id,
       i.previous_item_id, i.error_code AS item_error,
       p.id AS part_id, p.content_index, p.kind, p.state AS part_state,
       p.final_text, p.error_code AS part_error
FROM transcript_items i
LEFT JOIN transcript_parts p ON p.user_id = i.user_id AND p.item_id = i.id
WHERE i.session_id = :'session_id'::uuid
ORDER BY i.ordinal NULLS LAST, i.first_seen_at, p.content_index;

SELECT id, from_ordinal, through_ordinal, state, attempts, last_error_code,
       model, created_at, finished_at
FROM reconciliation_jobs WHERE session_id = :'session_id'::uuid
ORDER BY from_ordinal;
```

For a normal completed user turn, expect one ordered `transcript_items` row and at least one `transcript_parts` row with `state='complete'` and `final_text`. Duplicated provider final events should not produce duplicate parts. `sealed_through` is the safe extraction prefix, and `applied_through` advances after its job succeeds. An unplaced (`ordinal IS NULL`), failed, or pending item explains a browser gap or incomplete capture. The job may briefly be `pending`, `running`, or `retry_wait`; `succeeded` means its proposed Mind changes were applied. A `blocked` job requires an operator decision.

Inspect Mind and the link back to exact transcript evidence:

```sql
SELECT id, kind, subject, predicate, content, occurred_at, time_text,
       state, version, manual_override, updated_at
FROM memories WHERE user_id = :'demo_user'::uuid
ORDER BY updated_at DESC, id DESC;

SELECT id, title, subject, status, priority, due_at, due_timezone,
       due_text, due_precision, version, schedule_version, manual_override
FROM commitments WHERE user_id = :'demo_user'::uuid
ORDER BY priority, due_at NULLS LAST, id;

SELECT ch.created_at, ch.actor, ch.operation, ch.entity_version, ch.job_id,
       ch.memory_id, ch.commitment_id, i.session_id, i.ordinal,
       p.content_index, src.evidence_text
FROM mind_changes ch
LEFT JOIN change_sources src ON src.user_id = ch.user_id AND src.change_id = ch.id
LEFT JOIN transcript_parts p ON p.user_id = src.user_id AND p.id = src.transcript_part_id
LEFT JOIN transcript_items i ON i.user_id = p.user_id AND i.id = p.item_id
WHERE ch.user_id = :'demo_user'::uuid
ORDER BY ch.created_at, ch.entity_version;
```

Semantic and episodic records live in `memories`; prospective promises live in `commitments`. A reconciler-authored `mind_changes` row has a `job_id`, and its `change_sources` point to transcript parts and evidence text. A user correction can have no transcript source. The browser hides deleted memories by default, but their rows and change history remain in PostgreSQL.

## 5. Exercise due logging and follow-through

If extraction created an open commitment with a resolved `due_at`, you can wait for that time. For a quicker local check, or to resolve an open commitment whose `due_at` is null, use the existing version-checked API to move **that open commitment** to a near-future instant. Copy its `id` and current `version` from the commitments query, then run this in a shell (not inside `psql`):

```sh
due_at=$(date -u -d '+45 seconds' '+%Y-%m-%dT%H:%M:%SZ')
curl -sS -X PATCH 'http://127.0.0.1:3001/api/commitments/COMMITMENT_UUID' \
  -H 'Content-Type: application/json' \
  -d "{\"expectedVersion\":\"CURRENT_VERSION\",\"dueAt\":\"$due_at\",\"dueTimezone\":\"UTC\",\"dueText\":\"manual test at $due_at\",\"duePrecision\":\"instant\"}"
```

Replace `COMMITMENT_UUID` and `CURRENT_VERSION` first. The `date -d` form is for GNU `date` on Linux; on another platform, supply a future UTC ISO-8601 timestamp manually. The response should show a new `version`, an increased `scheduleVersion`, and the chosen `dueAt`. If you receive `version_conflict`, reread the row and retry with its current version. This edit is attributed to the demo user and sets `manualOverride=true`; the reconciler will not update that commitment until the override is released.

After the due instant, expect a `{"event":"commitment_due",...}` line in terminal A. It carries IDs and priority, not the private title. Compare its `logId` with:

```sql
SELECT l.id AS log_id, l.commitment_id, l.schedule_version,
       l.priority, l.due_at, l.eligible_at, l.batch_id, l.batch_position,
       l.emitted_at, l.emit_attempts, l.last_error_code
FROM commitment_logs l WHERE l.user_id = :'demo_user'::uuid
ORDER BY l.eligible_at, l.batch_id, l.batch_position;
```

One schedule version gets one durable `commitment_logs` row. A terminal line can repeat after a crash before `emitted_at` is saved, so compare `logId` rather than counting stdout lines as exactly-once delivery. When multiple commitments become due in the same batch, lower priority number logs first (1 before 2 before 3), then due time. An unresolved `due_at IS NULL` commitment does not schedule.

If you manually rescheduled the commitment above, release its override **after** observing the due log and **before** the next voice session. Read its new `version` from PostgreSQL, then run:

```sh
curl -sS -X PATCH 'http://127.0.0.1:3001/api/commitments/COMMITMENT_UUID' \
  -H 'Content-Type: application/json' \
  -d '{"expectedVersion":"CURRENT_VERSION","releaseManualOverride":true}'
```

This adds a user-authored `release_override` change and preserves the due log. Use the newest version after this response for any further manual edits. If you did not manually reschedule, no release is needed.

For follow-through, start a **new** voice session and say “I sent Ananya the presentation.” Stop and wait for reconciliation, then check whether the original commitment ID changed to `completed`, its version advanced, and a new `mind_changes` row cites the second session. Re-select the latest session with `\gset` above to inspect its transcript and job. The model may fail to match the prior commitment; in that case, note the extraction result and use **Mark completed** in the Commitments view to verify the manual path. Completing or dismissing a commitment prevents a future schedule decision, but does not remove a log that was already created.

To test memory correction, use **Correct** or **Delete** in Mind. Refresh the SQL queries: a correction increments `version` and adds an actor=`user` change, while deletion sets `state='deleted'` and removes the memory from the default browser list. **Sources** should show the original transcript evidence and the later manual change separately.

## 6. When the result is not what you expected

- **Backend will not start:** verify the Docker container is running, `bun run db:migrate` succeeded, `.env` has a real key, and port 3001 is free. `GET /health/ready` must return 200 before testing voice. The frontend proxy is hard-coded to 3001 even if `PORT` changes.
- **Microphone or call setup fails:** use `http://127.0.0.1:3000`, grant microphone permission, and inspect the Voice phase and session `state`/`error_code`. A valid key and compatible Realtime/transcription model access are required. A session that never reaches `active` should not be treated as a transcript test.
- **Transcript is absent or out of order:** inspect `transcript_items`, `transcript_parts`, `ordinal`, and `error_code`. Only completed final turns are extracted; partial transcription is not persisted as a Mind source. Use the browser transcript gap display to identify excluded speech.
- **Transcript exists but Mind is unchanged:** inspect `reconciliation_jobs`. Pending/running jobs may need time; a `blocked` job preserves the transcript. After fixing the cause, run `bun apps/backend/src/reconciliation/operator.ts retry JOB_UUID --reason "cause fixed"` from the repository root. Use `skip` only if you intentionally accept missing extraction for that range.
- **No due line:** verify `status='open'`, `due_at <= now()`, and the `commitment_logs` row. A null `due_at` is unresolved, a completed/dismissed commitment is ineligible, and an `emitted_at IS NULL` row indicates emission is still pending or retrying. The browser does not show a reminder notification.

Stop the frontend and backend with Ctrl-C when finished. The backend drains active captures on SIGINT/SIGTERM; check for `incomplete` if you interrupt an active session. Exit `psql` with `\q`. Keep the Docker container running if you want to inspect this database later.
