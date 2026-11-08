.PHONY: build test start debug db seed

PORT ?= 8765

# With the root .env, `make test` runs the database tests against the database from `make db`
# instead of skipping them, and `make seed` fills that database; a TEST_DATABASE_URL or
# DATABASE_URL that is already set wins.
ifneq ($(wildcard .env),)
include .env
LOCAL_DATABASE_URL := postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@127.0.0.1:$(or $(POSTGRES_PORT),5432)/$(POSTGRES_DB)
export TEST_DATABASE_URL ?= $(LOCAL_DATABASE_URL)
seed: export DATABASE_URL ?= $(LOCAL_DATABASE_URL)
endif

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
	docker compose up -d --wait --build
	docker compose exec -T postgres sh -ec 'for f in /docker-entrypoint-initdb.d/*.sql; do PGOPTIONS=--client-min-messages=warning psql -v ON_ERROR_STOP=1 -q -U "$$POSTGRES_USER" -d "$$POSTGRES_DB" -f "$$f"; done'

# Starts the database like `make db`, then fills it with a sample crawl of every source (about
# 6 minutes); see scripts/seed.py.
seed: db
	cd crawler && uv run --locked python ../scripts/seed.py
