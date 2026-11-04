.PHONY: build test start debug

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
