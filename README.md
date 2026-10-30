# Patient Journey Matcher (AMOS WS 2026)
Something something something

## Development setup

The Python crawler, the Python backend and the TypeScript matcher are separate projects with their own lockfiles. Commit `crawler/uv.lock`, `backend/uv.lock` and `matcher/pnpm-lock.yaml` with every dependency change.

| Folder | Language | Package manager | Content |
|---|---|---|---|
| `crawler/` | Python 3.12 | [uv](https://docs.astral.sh/uv/) | Source crawlers |
| `backend/` | Python 3.12 | [uv](https://docs.astral.sh/uv/) | API, workers and scrapers copied from SS26, see [`backend/README.md`](backend/README.md) |
| `matcher/indexer/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | Index builder |
| `matcher/mcp-server/` | TypeScript, Node.js 24 | [pnpm](https://pnpm.io/) workspace | MCP server |

### Prerequisites

| Tool | Version |
|---|---|
| [Git](https://git-scm.com/downloads) | any recent |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | 0.13 or newer |
| [Node.js](https://nodejs.org/en/download) | 24 LTS |
| [pnpm](https://pnpm.io/installation) | 12, pinned in `matcher/package.json` |

### Python (`crawler/`)

1. Install the locked dependencies into `crawler/.venv`:

   ```sh
   cd crawler
   uv sync --locked
   ```

2. Run the tools: `uv run pytest`, `uv run mypy src`, `uv run ruff check .`, `uv run ruff format .`
3. Add a dependency: `uv add <package>`, or `uv add --dev <package>` for dev tools.

### Python (`backend/`)

1. Install the locked dependencies into `backend/.venv`:

   ```sh
   cd backend
   uv sync --locked
   ```

2. Check that every module imports: `uv run pytest`
3. To run the services, copy `backend/.env.example` to `backend/.env` and fill it in. The file documents every environment variable the backend reads.

### TypeScript (`matcher/`)

1. Install the locked dependencies for all packages:

   ```sh
   cd matcher
   pnpm install --frozen-lockfile
   ```

2. Run the tools: `pnpm typecheck`, `pnpm test`, `pnpm lint`
3. Add a dependency to one package: `pnpm --filter @matcher/indexer add <package>`. Add shared dev tools to the root with `pnpm add -w -D <package>`.
