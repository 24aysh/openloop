# Openloop

This checkout contains the six layers of the [MVP architecture](docs/mvp-architecture.md): PostgreSQL Mind storage, final-turn transcript ingestion and ordering, browser-to-Realtime WebRTC with a backend sideband, durable text-model reconciliation, backend commitment logging, and integrated browser views. Deterministic Layer 6 checks pass; the live OpenAI/microphone smoke test remains to be run in a configured local environment. The [layer 1](specs/layer-1-implementation.md), [layer 2](specs/layer-2-implementation.md), [layer 3](specs/layer-3-implementation.md), [layer 4](specs/layer-4-implementation.md), [layer 5](specs/layer-5-implementation.md), and [layer 6](specs/layer-6-implementation.md) specs define their acceptance gates.

## Local setup

Requires Bun 1.3, PostgreSQL 18, and Docker for the example database. The local HTTP demo binds to `127.0.0.1` and maps requests to the configured demo user; it is not an internet-facing authentication system.

```sh
docker run --rm -d --name openloop-layer1-postgres \
  -e POSTGRES_USER=openloop_test -e POSTGRES_PASSWORD=openloop_test \
  -e POSTGRES_DB=openloop_layer1_test -p 127.0.0.1:55440:5432 postgres:18.3
docker exec openloop-layer1-postgres psql -U openloop_test -d openloop_layer1_test -c 'CREATE DATABASE openloop_dev'
cp .env.example .env
# Replace OPENAI_API_KEY in .env with a local development key. Set RECONCILIATION_MODEL
# to a Responses model with strict structured-output support available to your account.
bun install
bun run db:migrate
bun apps/backend/src/server.ts
```

In another terminal, start the browser shell at `http://127.0.0.1:3000`:

```sh
bun run --cwd apps/frontend dev
```

The frontend requests microphone access before creating a backend session. The microphone track remains disabled until WebRTC, the data channel, the backend sideband, and transcript capture are ready. Stop drains accepted final transcript events before closing the call. The backend stores final transcript events from its sideband only; the browser never submits transcript text.

The browser has Voice, Mind, and Commitments views. Voice distinguishes a closed capture from pending or blocked Mind extraction, and shows incomplete/failed capture without claiming the speech was saved. The current session's ordered transcript and gaps can be inspected there. Mind lists searchable semantic and episodic records, supports version-checked correction/deletion, and shows source history. Commitments lists due meaning and priority, supports version-checked completion/dismissal, and shows source history. These views use the existing demo-user API; they do not feed memories into Realtime or send user-facing notifications.

For a live browser walkthrough and SQL checks against transcripts, Mind changes, and due logs, follow the [manual testing guide](docs/manual-testing.md).

The backend polls durable reconciliation jobs every second. It extracts only from sealed, completed user turns, applies validated changes atomically, and keeps earlier failed jobs ahead of later jobs for the same user. A blocked job needs an explicit local operator decision:

```sh
bun apps/backend/src/reconciliation/operator.ts retry <job-id> --reason "cause fixed"
bun apps/backend/src/reconciliation/operator.ts skip <job-id> --reason "accepted missing extraction"
```

Retry keeps the original transcript range and model versions. Skip advances the applied cursor without changing memories or commitments, and the transcript remains available. These commands operate on the configured local database; do not expose them as browser routes. Reconciliation uses [OpenAI Responses strict structured output](https://developers.openai.com/api/docs/guides/structured-outputs) with `store: false`. The sample `gpt-5.4` model is documented as supporting [Responses and structured outputs](https://developers.openai.com/api/docs/models/gpt-5.4); account access must be checked in your environment.

The backend also checks open commitments every second. Once a resolved due time arrives, it records an ordered decision in `commitment_logs` and prints a JSON `commitment_due` line. The database records each schedule version once; a terminal line can repeat after a crash, so use its stable `logId` to identify duplicates. Terminal lines omit the private title. Completing or dismissing a commitment prevents future logs; a log already committed remains as history.

On SIGINT/SIGTERM, readiness becomes false and new voice starts are rejected. Existing sessions can report draining while the backend waits up to ten seconds for accepted final turns; unfinished captures become incomplete. Background model requests are aborted and durable jobs are recovered on the next start. A forced process kill can lose sideband events that were never persisted.

The sample `DATABASE_URL` points to `openloop_dev`; `TEST_DATABASE_URL` points to `openloop_layer1_test`. Treat the sample credentials as local only. Never put a real API key in the repository.

```sh
bun test apps/backend/tests/mind
bun test apps/backend/tests/transcripts
bun test apps/backend/tests/sessions
bun test apps/backend/tests/reconciliation
bun test apps/backend/tests/scheduling
bun test apps/frontend/tests/voice
bun test apps/frontend/tests/mind
bun test apps/backend/tests/integration
bun run --cwd apps/frontend build
bun run check-types
bun run lint
```

The test helper refuses a URL without a database name containing `test` or one matching `DATABASE_URL`. Export `TEST_DATABASE_URL` from `.env.example` or your local test setup before running database tests. Make targets `install`, `migrate`, `test`, `typecheck`, `lint`, and `dev` wrap these commands. `make test` runs the Postgres suites sequentially because they share the example test database. Automated tests use fake Realtime transports and need no API key or microphone. Use the browser shell for the manual two-turn Realtime acceptance check described in the layer 6 spec; natural-language extraction quality and live account/model access are not established by deterministic tests.
