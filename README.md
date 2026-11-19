<p align="center">
  <img src="Documentation/logo.png" alt="Journey Matcher logo" width="240">
</p>

# Patient Journey Matcher (AMOS WS 2026)
The Patient Journey Matcher is an MCP server for the AIlixir app. A client sends a patient journey, a dated list of events such as diagnoses and operations, and gets back research papers, preprints, YouTube videos and podcast episodes that fit the latest event in that journey.

- **Crawler (Python):** collects metadata and links from PubMed, arXiv, Zenodo, YouTube and podcast feeds and stores them in PostgreSQL, never the full texts.
- **Indexer (TypeScript):** downloads each full text again, keeps it in memory and builds the index of each matching approach. Today this is [keyword matching](Documentation/design/keyword-matching.md); a graph-based and an AI-based approach follow.
- **MCP server (TypeScript):** matches the journey against the index and returns the best sources with links to the originals.

How it fits together: [software architecture](Documentation/design/architecture.md).

## Tech stack

| Part | Technology |
|---|---|
| Crawler | Python 3.12, uv, Crawlee for Python, asyncpg |
| Indexer and MCP server | TypeScript on Node.js 24, pnpm workspace, MCP TypeScript SDK (Streamable HTTP), zod |
| Database | PostgreSQL 18 with pg_textsearch (BM25 ranking), run with Docker Compose |
| Checks | pytest, mypy and Ruff; Vitest and Biome; GitHub Actions |

All libraries, what they are used for and their licences: [technology stack](Documentation/design/architecture.md#3-technology-stack).

## Getting started

### Prerequisites

| Tool | Version |
|---|---|
| [Git](https://git-scm.com/downloads) | any recent |
| [Docker](https://docs.docker.com/get-docker/) with Compose | any recent |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | 0.13 or newer |
| [Node.js](https://nodejs.org/en/download) | 24 LTS |
| [pnpm](https://pnpm.io/installation) | 12, pinned in `matcher/package.json` |
| [Make](https://www.gnu.org/software/make/) | any recent |

### Run it locally

```sh
cp .env.example .env   # choose your own POSTGRES_PASSWORD
make db                # PostgreSQL in Docker, with the tables from db/init/
make seed              # a small sample crawl of every source (also starts the database)
make index             # installs the dependencies and builds the index of each approach
make start             # MCP server on http://127.0.0.1:3000/mcp
```

Then call it with the MCP Inspector: [try it](Documentation/user/mcp-interface.md#try-it). The API keys of the data sources go into `crawler/.env` and are optional; without `YOUTUBE_API_KEY`, the sample crawl skips YouTube ([crawler](crawler/README.md)).

### Development

```sh
make build   # installs crawler/ with uv and matcher/ with pnpm, type-checks matcher/
make test    # all checks, as on CI
```

Single checks: `uv run pytest`, `uv run mypy src` and `uv run ruff check .` in `crawler/`; `pnpm test`, `pnpm lint` and `pnpm typecheck` in `matcher/`. Database tests run only with `TEST_DATABASE_URL`; the root `.env` sets it for `make`. Commit `crawler/uv.lock` and `matcher/pnpm-lock.yaml` with every dependency change. All make targets, the end-to-end tests, CI and the SBOM: [build, run and test](Documentation/build-deploy/build.md).

## Documentation

- **User:** [MCP interface](Documentation/user/mcp-interface.md), [synthetic patients](patientdata/patientdata.md), [debug UI](debug/crawler/README.md)
- **Design:** [software architecture](Documentation/design/architecture.md), [data sources](Documentation/design/sources.md), [storage](Documentation/design/storage.md), [keyword matching](Documentation/design/keyword-matching.md)
- **Build and deploy:** [build, run and test](Documentation/build-deploy/build.md), [local database](Documentation/build-deploy/database.md), [deployment](Documentation/build-deploy/deployment.md)
- **Research:** [the team's investigations](research/README.md)

Index of all pages and the [glossary](Documentation/glossary.md): [Documentation](Documentation/README.md).

## Repository

| Folder | Content |
|---|---|
| `crawler/` | Python crawler ([README](crawler/README.md)) |
| `matcher/` | TypeScript pnpm workspace: MCP server, indexer, approaches and shared packages ([README](matcher/README.md)) |
| `db/` | PostgreSQL image and schema |
| `deploy/` | Setup and backup scripts of the VM ([deployment](Documentation/build-deploy/deployment.md)) |
| `debug/crawler/` | [Debug UI](debug/crawler/README.md) for the crawler, the database, the index and the matcher |
| `scripts/` | Sample crawl, coverage report, patient graphs, speech-to-text, SBOM |
| `patientdata/` | [Synthetic patients](patientdata/patientdata.md) for development and tests |
| `backend/` | Code copied from the SS26 project, used only by `make graph` ([README](backend/README.md)) |
| `Documentation/` | User, design, and build and deploy documentation |
| `research/` | The team's investigations ([index](research/README.md)) |
| `Deliverables/` | Sprint deliverables, frozen |
