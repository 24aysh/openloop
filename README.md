# openloop

This is a small implementation of a voice agent that talks with user naturally and another text llm uses those transcripts to filtrate mind with memories, facts and commitments. Something similar to moonshot(yc s26) that i tried to replicate

## local run

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

For a live browser walkthrough and SQL checks against transcripts, Mind changes, and due logs, follow the [manual testing guide](docs/manual-testing.md).

The backend polls durable reconciliation jobs every second. It extracts only from sealed, completed user turns, applies validated changes atomically, and keeps earlier failed jobs ahead of later jobs for the same user. A blocked job needs an explicit local operator decision:

