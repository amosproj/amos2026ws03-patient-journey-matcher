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

## Local database (PostgreSQL)

The local database runs in Docker via Docker Compose. It uses PostgreSQL 18 with the pgvector extension and is defined in `compose.yaml` in the repository root. Every developer gets the same setup, so the crawler, indexer and MCP server can be developed and tested against the same database.

### Prerequisites

- Docker Desktop (Windows/macOS) or Docker Engine with the Compose plugin
- Check the installation with `docker compose version`
- On Windows, Docker Desktop needs WSL2
- No Docker login is needed. The image is pulled automatically on first start.

### Configuration

Configuration is done through environment variables in a `.env` file. The file is not committed. Copy the template and adjust it:

```bash
cp .env.example .env
```

| Variable | Description | Example |
|---|---|---|
| `POSTGRES_USER` | Database user | `amos` |
| `POSTGRES_PASSWORD` | Password for the user, choose your own | `set your own password` |
| `POSTGRES_DB` | Database name | `patient_journey_matcher` |
| `POSTGRES_PORT` | Port on your machine (default `5432`) | `5432` |

Notes:
- The database is only reachable from your own machine (`127.0.0.1`).
- The user, password and database name are only applied on the first start with an empty volume. If you change them later, run `docker compose down -v` to reset (this deletes all data).
- If port 5432 is already in use, set `POSTGRES_PORT` to another value, e.g. `5433`.

### Commands

```bash
docker compose up -d        # start the database in the background
docker compose ps           # check status, should show "healthy"
docker compose logs -f postgres   # follow the logs
docker compose stop         # stop, data is kept
docker compose start        # start again after stop
docker compose down         # remove the container, data is kept in the volume
docker compose down -v      # remove container AND data (full reset)
```

You can leave the database running during normal work. It restarts automatically when Docker Desktop starts, unless you stopped it manually.

### Connecting

Open a SQL shell inside the container (use the values from your `.env`):

```bash
docker compose exec postgres psql -U amos -d patient_journey_matcher
```

Type `\q` to leave. Connection URL for clients running on your machine (asyncpg, node-postgres):

```
postgresql://amos:<password>@localhost:5432/patient_journey_matcher
```

When a component runs as a container in the same Compose file, use the host `postgres` instead of `localhost`.

### Data and initialization

- Data is stored in the Docker volume `pgdata` and survives `stop`, `down` and restarts. Only `down -v` deletes it.
- SQL files in `db/init/` run once on the first start with an empty volume. They enable the `vector` extension and will later create the shared schemas. After changing them, reset with `docker compose down -v` and start again.
- Use only synthetic patient data. The database is for development only.