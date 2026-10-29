# Patient Journey Matcher (AMOS WS 2026)
Something something something

## Development setup

The Python crawler and the TypeScript matcher are separate projects with their own lockfiles. Commit `crawler/uv.lock` and `matcher/pnpm-lock.yaml` with every dependency change.

| Folder | Language | Package manager | Content |
|---|---|---|---|
| `crawler/` | Python 3.12 | [uv](https://docs.astral.sh/uv/) | Source crawlers |
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

### TypeScript (`matcher/`)

1. Install the locked dependencies for all packages:

   ```sh
   cd matcher
   pnpm install --frozen-lockfile
   ```

2. Run the tools: `pnpm typecheck`, `pnpm test`, `pnpm lint`
3. Add a dependency to one package: `pnpm --filter @matcher/indexer add <package>`. Add shared dev tools to the root with `pnpm add -w -D <package>`.

### GitHub CI

See [`Documentation/github-ci.md`](Documentation/github-ci.md).

### SBOM generation

After installing both projects, run from the repository root:

```sh
uv run --project crawler python scripts/dependencies.py
```

It writes all direct dependencies with version, licence and scope to `out/dependencies.tsv`. The `Context` and `Comment` columns stay empty; fill them in afterwards, for example with your coding agent.
