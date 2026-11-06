.PHONY: build test start debug db

PORT ?= 8765

build:
	cd crawler && uv sync --locked
	cd matcher && pnpm install --frozen-lockfile
	cd matcher && pnpm typecheck

test: build
	cd crawler && uv run ruff check .
	cd crawler && uv run ruff format --check .
	cd crawler && uv run mypy src
	cd crawler && uv run pytest
	cd matcher && pnpm lint
	cd matcher && pnpm test

start: build
	cd matcher && pnpm --filter @matcher/mcp-server start

debug:
	cd crawler && uv run --locked python ../debug/crawler/server.py --port $(PORT)

# Starts the database and applies db/init/ again; the files are idempotent, so this also
# brings an existing volume up to date.
db:
	docker compose up -d --wait
	docker compose exec -T postgres sh -ec 'for f in /docker-entrypoint-initdb.d/*.sql; do PGOPTIONS=--client-min-messages=warning psql -v ON_ERROR_STOP=1 -q -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -f "$$f"; done'
