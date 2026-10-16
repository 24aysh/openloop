.PHONY: install migrate test typecheck lint dev

install:
	bun install

migrate:
	bun run db:migrate

test:
	bun run test:mind
	bun run test:transcripts
	bun run test:sessions
	bun run test:voice
	bun run test:reconciliation

typecheck:
	bun run check-types

lint:
	bun run lint

dev:
	bun apps/backend/src/server.ts
