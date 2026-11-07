# Build, test and start

Run these commands from the repository root. You need the tools listed under [Prerequisites](../README.md#prerequisites). No credentials are needed.

| Command | What it does |
|---|---|
| `make build` | Installs the locked dependencies of `crawler/` and `matcher/`, and typechecks `matcher/` |
| `make test` | Builds, then runs the same checks as [CI](github-ci.md); with the root `.env`, the database tests use the database from `make db` |
| `make start` | Builds, then starts the MCP server on `http://127.0.0.1:3000/mcp` |
| `make debug` | Starts the [crawler debug UI](../debug/crawler/README.md) on `http://127.0.0.1:8765` |
| `make db` | Starts the [database](database.md) and applies `db/init/`; needs the root `.env` |
| `make seed` | Runs `make db`, then fills the database with a sample crawl of every source: about 1,500 documents in about 6 minutes ([`scripts/seed.py`](../scripts/seed.py)) |

Make only calls the `uv` and `pnpm` commands from the [README](../README.md#development-setup), so you can still run them directly.

## From a fresh clone

```sh
git clone https://github.com/amosproj/amos2026ws03-patient-journey-matcher.git
cd amos2026ws03-patient-journey-matcher
make test
make start
```

## Check that the server runs

While `make start` is running, list the tools from a second terminal:

```sh
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

The answer lists `match_journey` and `get_source`. Both tools answer `NOT_AVAILABLE` until the matchers exist, see [MCP interface](mcp-interface.md).
