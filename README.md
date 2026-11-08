<p align="center">
  <img src="Documentation/logo.png" alt="Journey Matcher logo" width="240">
</p>

# Patient Journey Matcher (AMOS WS 2026)
The Patient Journey Matcher is an MCP server for the AIlixir app. A client sends a patient journey, a dated list of events such as diagnoses and operations, and gets back research papers, preprints, YouTube videos and podcast episodes that fit the most recent points in that journey.

- **Crawler (Python):** indexes PubMed, arXiv, Zenodo, YouTube and podcast feeds in advance. It stores only metadata and links in PostgreSQL, never the full texts.
- **Indexer (TypeScript):** downloads each text again, keeps it in memory and builds three competing indexes: word statistics, a graph of medical entities and relations, and AI summaries.
- **MCP server (TypeScript):** matches the journey against the indexes and returns the best sources with links to the originals.

Details: [software architecture](Documentation/architecture/software-architecture.html).

## Development setup

The Python crawler and the TypeScript matcher are separate projects with their own lockfiles. Commit `crawler/uv.lock` and `matcher/pnpm-lock.yaml` with every dependency change.

| Folder | Language | Package manager | Content |
|---|---|---|---|
| `crawler/` | Python 3.12 | [uv](https://docs.astral.sh/uv/) | PubMed, arXiv, Zenodo, YouTube and podcast crawlers |
| `debug/crawler/` | Python 3.12, HTML | uses `crawler/` | [Debug UI](debug/crawler/README.md) for the crawler and the database |
| `matcher/db/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | Reads the stored sources ([storage](Documentation/storage.md)) |
| `matcher/core/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | Contracts of the approaches: `Approach`, `Indexer`, `Matcher`, rank fusion |
| `matcher/approaches/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | The list of approaches, for the MCP server and the indexer |
| `matcher/download/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | Downloads full texts and reads their text ([keyword matching](Documentation/keyword-matching.md#full-texts)) |
| `matcher/algorithms/keyword/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | [Keyword matching](Documentation/keyword-matching.md): BM25 index and matcher; [adding an approach](matcher/algorithms/README.md) |
| `matcher/indexer/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | Index builder (`make index`) |
| `matcher/mcp-server/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | MCP server; builds the journey state all matchers get: focus and context |

How the matcher packages depend on each other and the rules for their code: [`matcher/README.md`](matcher/README.md).

### Prerequisites

| Tool | Version |
|---|---|
| [Git](https://git-scm.com/downloads) | any recent |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | 0.13 or newer |
| [Node.js](https://nodejs.org/en/download) | 24 LTS |
| [pnpm](https://pnpm.io/installation) | 12, pinned in `matcher/package.json` |
| [Make](https://www.gnu.org/software/make/) | any recent |

### Build, test and start

See [`Documentation/build.md`](Documentation/build.md).

### Python (`crawler/`)

1. Install the locked dependencies into `crawler/.venv`:

   ```sh
   cd crawler
   uv sync --locked
   ```

2. Run the tools: `uv run pytest`, `uv run mypy src`, `uv run ruff check .`, `uv run ruff format .`. The store tests are skipped unless `TEST_DATABASE_URL` points to a PostgreSQL database.
3. Add a dependency: `uv add <package>`, or `uv add --dev <package>` for dev tools.

### TypeScript (`matcher/`)

1. Install the locked dependencies for all packages:

   ```sh
   cd matcher
   pnpm install --frozen-lockfile
   ```

2. Run the tools: `pnpm typecheck`, `pnpm test`, `pnpm lint`. The `@matcher/db` database tests are skipped unless `TEST_DATABASE_URL` points to a PostgreSQL database.
3. Add a dependency to one package: `pnpm --filter @matcher/indexer add <package>`. Add shared dev tools to the root with `pnpm add -w -D <package>`.
4. Start the MCP server: `pnpm --filter @matcher/mcp-server start`. See [`Documentation/mcp-interface.md`](Documentation/mcp-interface.md).

#### Testing the MCP server

Start the server (step 4 above), then test it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) in a second terminal:

```sh
# Web UI, connected to our server
npx @modelcontextprotocol/inspector --transport http --server-url http://127.0.0.1:3000/mcp
```

### GitHub CI

See [`Documentation/github-ci.md`](Documentation/github-ci.md).

### SBOM generation

After installing both projects, run from the repository root:

```sh
uv run --project crawler python scripts/dependencies.py
```

It writes all direct dependencies with version, licence and scope to `out/dependencies.tsv`. The `Context` and `Comment` columns stay empty; fill them in afterwards, for example with your coding agent.

### PostgreSQL 

Setup: [`Documentation/database.md`](Documentation/database.md). Tables, `--store` and reading: [`Documentation/storage.md`](Documentation/storage.md).