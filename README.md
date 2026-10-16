# Openloop

This checkout implements layers 1 through 3 of the [MVP architecture](docs/mvp-architecture.md): PostgreSQL storage, Mind contracts and repositories, versioned edits, local Mind HTTP routes, final-turn transcript ingestion, conversation ordering, durable reconciliation batches, and browser-to-Realtime WebRTC with a backend sideband bound to the same call. The [layer 1](specs/layer-1-implementation.md), [layer 2](specs/layer-2-implementation.md), and [layer 3](specs/layer-3-implementation.md) specs define their acceptance gates. Reconciliation and scheduling workers are later layers.

## Local setup

Requires Bun 1.3, PostgreSQL 18, and Docker for the example database. The local HTTP demo binds to `127.0.0.1` and maps requests to the configured demo user; it is not an internet-facing authentication system.

```sh
docker run --rm -d --name openloop-layer1-postgres \
  -e POSTGRES_USER=openloop_test -e POSTGRES_PASSWORD=openloop_test \
  -e POSTGRES_DB=openloop_layer1_test -p 127.0.0.1:55440:5432 postgres:18.3
docker exec openloop-layer1-postgres psql -U openloop_test -d openloop_layer1_test -c 'CREATE DATABASE openloop_dev'
cp .env.example .env
# Replace OPENAI_API_KEY in .env with a local development key.
bun install
bun run db:migrate
bun apps/backend/src/server.ts
```

In another terminal, start the browser shell at `http://127.0.0.1:3000`:

```sh
bun run --cwd apps/frontend dev
```

The frontend requests microphone access before creating a backend session. The microphone track remains disabled until WebRTC, the data channel, the backend sideband, and transcript capture are ready. Stop drains accepted final transcript events before closing the call. The backend stores final transcript events from its sideband only; the browser never submits transcript text.

The sample `DATABASE_URL` points to `openloop_dev`; `TEST_DATABASE_URL` points to `openloop_layer1_test`. Treat the sample credentials as local only. Never put a real API key in the repository.

```sh
bun test apps/backend/tests/mind
bun test apps/backend/tests/transcripts
bun test apps/backend/tests/sessions
bun test apps/frontend/tests/voice
bun run --cwd apps/frontend build
bun run check-types
bun run lint
```

The test helper refuses a URL without a database name containing `test` or one matching `DATABASE_URL`. Make targets `install`, `migrate`, `test`, `typecheck`, `lint`, and `dev` wrap these commands. `make test` runs the Postgres suites sequentially because they share the example test database. Automated tests use fake Realtime transports and need no API key or microphone. Use the browser shell for the manual two-turn Realtime acceptance check described in the layer 3 spec.
