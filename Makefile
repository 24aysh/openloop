.PHONY: install migrate test typecheck lint dev

install:
	bun install

migrate:
	bun run db:migrate

test:
	bun run test:mind

typecheck:
	bun run check-types

lint:
	bun run lint

dev:
	bun apps/backend/src/server.ts
