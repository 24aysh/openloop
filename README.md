# Openloop

This checkout implements layers 1 and 2 of the [MVP architecture](docs/mvp-architecture.md): PostgreSQL storage, Mind contracts and repositories, versioned edits, local Mind HTTP routes, final-turn transcript ingestion, conversation ordering, and durable reconciliation batches. The [layer 1](specs/layer-1-implementation.md) and [layer 2](specs/layer-2-implementation.md) specs define their acceptance gates. Real sideband/WebRTC attachment, reconciliation workers, and scheduling workers are later layers.

## Local setup

Requires Bun 1.3, PostgreSQL 18, and Docker for the example database. The local HTTP demo binds to `127.0.0.1` and maps requests to the configured demo user; it is not an internet-facing authentication system.

```sh
docker run --rm -d --name openloop-layer1-postgres \
  -e POSTGRES_USER=openloop_test -e POSTGRES_PASSWORD=openloop_test \
  -e POSTGRES_DB=openloop_layer1_test -p 127.0.0.1:55440:5432 postgres:18.3
docker exec openloop-layer1-postgres psql -U openloop_test -d openloop_layer1_test -c 'CREATE DATABASE openloop_dev'
cp .env.example .env
bun install
bun run db:migrate
bun apps/backend/src/server.ts
```

The sample `DATABASE_URL` points to `openloop_dev`; `TEST_DATABASE_URL` points to `openloop_layer1_test`. Treat the sample credentials as local only. Never put a real API key in the repository.

```sh
bun test apps/backend/tests/mind
bun test apps/backend/tests/transcripts
bun run check-types
bun run lint
```

The test helper refuses a URL without a database name containing `test` or one matching `DATABASE_URL`. Make targets `install`, `migrate`, `test`, `typecheck`, `lint`, and `dev` wrap these commands. `make test` runs the two Postgres suites sequentially because they share the example test database. Layer 2 accepts synthetic server events directly; the real OpenAI sideband is attached in layer 3.
