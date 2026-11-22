.PHONY: build test start debug db seed index transcribe graph

PORT ?= 8765

# With the root .env, `make test` runs the database tests against the database from `make db`
# instead of skipping them, and `make seed`, `make index`, `make transcribe` and `make start` use
# that database; a TEST_DATABASE_URL or DATABASE_URL that is already set wins.
ifneq ($(wildcard .env),)
include .env
LOCAL_DATABASE_URL := postgresql://$(POSTGRES_USER):$(POSTGRES_PASSWORD)@127.0.0.1:$(or $(POSTGRES_PORT),5432)/$(POSTGRES_DB)
export TEST_DATABASE_URL ?= $(LOCAL_DATABASE_URL)
seed index transcribe start: export DATABASE_URL ?= $(LOCAL_DATABASE_URL)
endif

build:
	cd crawler && uv sync --locked
	cd matcher && pnpm install --frozen-lockfile
	cd matcher && pnpm typecheck

test: build
	cd crawler && uv run ruff check .
	cd crawler && uv run ruff format --check .
	cd crawler && uv run mypy src
	cd crawler && uv run mypy tests/integration_support/crawl.py
	cd crawler && uv run pytest
	cd matcher && pnpm lint
	cd matcher && pnpm test
	cd matcher && pnpm test:integration

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

# Brings the indexes of the approaches up to date with the stored documents; run it after a
# crawl. All approaches, or the ones named, e.g. `make index APPROACHES=keyword`.
index: build
	cd matcher && pnpm --filter @matcher/indexer start $(APPROACHES)

# Reads the audio that has no transcript with speech-to-text, for the indexes, until it is
# stopped: `WHISPER_MODEL=tiny-q5_1 make transcribe`. How many files it reads at once is set in
# the debug UI, also while it runs, or here: `make transcribe WORKERS=2`.
transcribe: build
	cd matcher && pnpm --filter @matcher/transcriber start $(WORKERS)

.PHONY: test-integration
test-integration: build
	cd matcher && pnpm test:integration

# Builds the graph of one generated patient with the SS26 graph steps and writes it to
# patientdata/<patient>/graph.json, e.g. `make graph PATIENT=Patient-5`; needs GEMINI_API_KEY,
# see tools/patient-graph/README.md.
graph:
	cd tools/patient-graph && uv run --locked python patient_graph.py $(PATIENT)
