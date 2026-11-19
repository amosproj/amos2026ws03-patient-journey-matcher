# Build, run and test

Run the commands from the repository root. Each `make` target runs the `uv`, `pnpm`, `docker compose` or script commands shown in the [`Makefile`](../../Makefile), so you can also run them directly. No credentials are needed, except for `make graph`.

## Prerequisites

| Tool | Version |
|---|---|
| [Git](https://git-scm.com/downloads) | any recent |
| [Docker](https://docs.docker.com/get-docker/) with Compose | any recent, for the [database](database.md) |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | 0.13 or newer |
| [Node.js](https://nodejs.org/en/download) | 24 LTS |
| [pnpm](https://pnpm.io/installation) | 12, pinned in `matcher/package.json` |
| [Make](https://www.gnu.org/software/make/) | any recent |

## Make targets

| Command | What it does |
|---|---|
| `make build` | Installs the locked dependencies of `crawler/` and `matcher/`, and type-checks `matcher/` |
| `make test` | Builds, then runs the same checks as [CI](#ci); with the root `.env`, the database tests use the database from `make db` |
| `make test-integration` | Builds, then runs only the [end-to-end tests](#end-to-end-tests) |
| `make db` | Starts the [database](database.md) and applies `db/init/`; needs the root `.env` |
| `make seed` | Runs `make db`, then stores a sample crawl of every source ([`scripts/seed.py`](../../scripts/seed.py)) |
| `make index` | Builds, then updates the indexes of all approaches, today the [keyword index](../design/keyword-matching.md) |
| `WHISPER_MODEL=tiny-q5_1 make transcribe` | Builds, then runs the [transcription job](../design/keyword-matching.md#speech-to-text) until you stop it: speech-to-text for podcast audio that has no transcript, for the indexes. It reads no file until you set how many at once: [options](#options) or the debug UI |
| `make start` | Builds, then starts the MCP server on `http://127.0.0.1:3000/mcp`; needs the root `.env` |
| `make debug` | Starts the [debug UI](../../debug/crawler/README.md) for the crawler, the database, the index and the matcher on `http://127.0.0.1:8765` |
| `make graph PATIENT=Patient-5` | Builds the [patient graph](../user/mcp-interface.md#patient-graph) of one synthetic patient and writes `patientdata/Patient-5/graph.json` with the [patient graph tool](../../tools/patient-graph/README.md); needs `GEMINI_API_KEY` |

## Run the matcher locally

```sh
cp .env.example .env   # choose your own POSTGRES_PASSWORD
make seed              # database plus sample documents
make index             # keyword index; the first run is slow, see Limitations
make start             # MCP server, keep it running
```

Then call it from a second terminal with the MCP Inspector: [MCP interface, try it](../user/mcp-interface.md#try-it). To see each step of the pipeline with this data, start the [debug UI](../../debug/crawler/README.md) with `make debug`.

## Options

| Option | Effect |
|---|---|
| `make index APPROACHES=keyword` | Indexes only the named approaches |
| `MCP_PORT=3001 make start` | Starts the MCP server on another port |
| `POSTGRES_PORT=5433` in `.env` | Publishes the database on another port, if 5432 is taken |
| `make debug PORT=9000` | Starts the debug UI on another port |
| `DATABASE_URL=… make index`, `TEST_DATABASE_URL=… make test` | Uses another database; a variable that is set wins over `.env` |
| `YOUTUBE_API_KEY` in `crawler/.env` | `make seed` also crawls YouTube; without it, YouTube is skipped |
| `GEMINI_API_KEY` in `tools/patient-graph/.env` or the environment | Needed by `make graph` ([patient graph tool](../../tools/patient-graph/README.md)) |
| `VERTEX_LLM_MODEL=… GEMINI_PACER_MIN_INTERVAL_S=5 make graph PATIENT=Patient-5` | Uses another model than `gemini-2.5-flash` and waits 5 s between Graphiti's LLM calls, which make up most requests; reading the PDFs and the embeddings are not paced. The graph steps use Kuzu, which prints a deprecation warning |
| `WHISPER_MODEL=base-q5_1 make transcribe WORKERS=2` | Transcribes with another [Whisper model](../../research/sources/podcasts.md#whisper-models) than the smallest recommended one (`tiny-q5_1`), and sets the number of files read at once without the debug UI |
| `cd crawler && uv run crawler refresh` | Backfills metadata languages and OpenAlex links of stored documents without crawling again; run `make index` afterwards ([refresh](../design/storage.md#refresh-stored-enrichment)) |
| `cd crawler && uv run python ../scripts/coverage.py` | After indexing: reports full-text links, read and indexed texts, pending rows and failures |
| `cd crawler && uv run crawler pubmed --topic prostate_cancer --max-results 200 --store` | Adds more documents; needs `DATABASE_URL` in `crawler/.env` ([connecting](database.md#connecting)). Run `make index` afterwards. Other sources and flags: [crawler](../../crawler/README.md) |

## Development

The Python crawler and the TypeScript matcher are separate projects with their own lockfiles. Commit `crawler/uv.lock` and `matcher/pnpm-lock.yaml` with every dependency change (and `tools/patient-graph/uv.lock` for the [patient graph tool](../../tools/patient-graph/README.md)).

**Crawler (`crawler/`, Python 3.12, uv).** `uv sync --locked` installs the locked dependencies into `crawler/.venv`. Checks: `uv run pytest`, `uv run mypy src`, `uv run ruff check .`, `uv run ruff format .`. Add a dependency with `uv add <package>`, a dev tool with `uv add --dev <package>`. API keys and flags: [crawler](../../crawler/README.md).

**Matcher (`matcher/`, TypeScript, Node.js 24, pnpm workspace).** `pnpm install --frozen-lockfile` installs all packages. Checks: `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm test:integration`. Add a dependency to one package with `pnpm --filter @matcher/indexer add <package>`, a shared dev tool with `pnpm add -w -D <package>`. Package rules: [matcher](../../matcher/README.md).

**Database tests.** The store tests of the crawler, the database tests of `@matcher/db` and `@matcher/keyword`, and the end-to-end tests are skipped unless `TEST_DATABASE_URL` points to a PostgreSQL database; the root `.env` sets it for `make`.

### End-to-end tests

The tests in [`matcher/mcp-server/src/integration/`](../../matcher/mcp-server/src/integration/) run the whole workflow with the real components: the crawler stores documents in a new database, the indexer downloads and indexes their full texts, and an MCP client calls `match_journey` and `get_source` over HTTP. A local HTTP server stands in for Zenodo, PubMed, PMC and the podcast feeds, so the tests need no internet access and no credentials. Run them with `make db` and `make test-integration`; `make test` and CI run them too.

Not covered: the live data sources, the quality of the ranking, reading a valid PDF, and transcribing audio with Whisper.

### CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every pull request, on every push to `main`, and on demand. The `crawler` job runs the crawler checks above, with a PostgreSQL service container for the store tests. The `matcher` job starts the database from `compose.yaml`, installs the crawler for the end-to-end tests, and runs the matcher checks above. Each job stops at the first failure.

- `tools/patient-graph/` is not checked; it has only an import test (`uv run pytest` in that folder).
- The crawler tests use fakes shaped like the API responses and never call the live APIs.
- There is no vulnerability or licence scan.
- A failed check blocks merging only once a repository admin makes `crawler` and `matcher` required status checks for `main`.

### SBOM

After installing both projects:

```sh
uv run --project crawler python scripts/dependencies.py
```

It writes the direct dependencies of `crawler/` and `matcher/` with version, licence and scope to `out/dependencies.tsv`; those of the [patient graph tool](../../tools/patient-graph/README.md#development) are added by hand. The `Context` and `Comment` columns stay empty; fill them in afterwards.

## Limitations

- **Index before you query.** Without `make index`, `match_journey` answers `degraded: true` with no results.
- **The first `make index` is slow, mostly because of arXiv.** arxiv.org asks for 15 s between requests ([request budgets](../design/sources.md#request-budgets)), and a paper without an HTML version needs a second download, the PDF. The indexer reads 500 documents at a time from all hosts in parallel and prints its progress every minute. Ctrl+C is safe: the next run continues with the documents not read yet and retries failed downloads. Later runs read only new and changed documents.
- **A changed indexer reads only new and changed documents.** To rebuild the keyword index from scratch, drop it and run `make index`. As no index keeps a transcript, `make transcribe` then reads the podcast audio again:

  ```sh
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA keyword CASCADE" -c "DELETE FROM transcripts"'
  ```
- **The seed is a small sample.** Journeys on diseases it barely covers find little. How the ranking can go wrong: [keyword matching](../design/keyword-matching.md#known-limitations).
- **Local use only.** The server listens on `127.0.0.1` and has no authentication.
- **Old database volumes** may warn "collation version mismatch": [database](database.md#data-and-initialization).
