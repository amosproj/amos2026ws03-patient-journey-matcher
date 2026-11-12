# Build, run and test

Run these commands from the repository root. You need the tools listed under [Prerequisites](../README.md#prerequisites) and Docker for the [database](database.md). No credentials are needed.

| Command | What it does |
|---|---|
| `make build` | Installs the locked dependencies of `crawler/` and `matcher/`, and typechecks `matcher/` |
| `make test` | Builds, then runs the same checks as [CI](github-ci.md); with the root `.env`, the database tests use the database from `make db` |
| `make start` | Builds, then starts the MCP server on `http://127.0.0.1:3000/mcp`; needs the root `.env` for the database |
| `make debug` | Starts the [debug UI](../debug/crawler/README.md) for the crawler, the database, the index and the matcher on `http://127.0.0.1:8765` |
| `make db` | Starts the [database](database.md) and applies `db/init/`; needs the root `.env` |
| `make seed` | Runs `make db`, then fills the database with a sample crawl of every source, in about 6 minutes ([`scripts/seed.py`](../scripts/seed.py)) |
| `make index` | Builds, then updates the indexes of all approaches, e.g. the [keyword index](keyword-matching.md) |

Make only calls the `uv` and `pnpm` commands from the [README](../README.md#development-setup), so you can still run them directly.

## Run the matcher locally
Ensure prerequisites are met:
```sh
cp .env.example .env   # choose your own POSTGRES_PASSWORD
```
Then:

```sh
make seed              # database plus sample documents, about 6 minutes
make index             # keyword index; the first run takes about 30 minutes (arXiv's rate limit, see below)
make start             # MCP server on http://127.0.0.1:3000/mcp, keep it running
```

In a second terminal, open the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector --transport http --server-url http://127.0.0.1:3000/mcp
```

In the browser, connect to the server, open **Tools** and pick `match_journey`. Turn on **Edit as JSON**, paste these arguments and click **Execute Tool**:

```json
{
  "journey": {
    "patient_id": "demo-1",
    "events": [
      { "id": "e1", "type": "surgery", "label": "Radikale Prostatektomie", "date": "2027-01-22" },
      { "id": "e2", "type": "progression", "label": "PSA-Anstieg – Biochemisches Rezidiv", "date": "2028-12-25" }
    ]
  },
  "algorithm": "keyword",
  "limit": 10
}
```

The answer names the focus event `e2` and lists papers on biochemical recurrence after prostatectomy. `limit` takes 1 to 50; all fields of the call and the answer: [MCP interface](mcp-interface.md). The Matcher screen of the [debug UI](../debug/crawler/README.md) takes the same JSON and shows how an answer came about.

The same without a browser:

```sh
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http \
  --method tools/call --tool-name match_journey \
  --tool-args-json '{"journey":{"patient_id":"demo-1","events":[{"id":"e1","type":"progression","label":"PSA-Anstieg – Biochemisches Rezidiv","date":"2028-12-25"}]},"limit":3}'
```

## Options

| Option | Effect |
|---|---|
| `make index APPROACHES=keyword` | Indexes only the named approaches |
| `MCP_PORT=3001 make start` | Starts the MCP server on another port |
| `POSTGRES_PORT=5433` in `.env` | Publishes the database on another port, if 5432 is taken |
| `make debug PORT=9000` | Starts the debug UI on another port |
| `DATABASE_URL=… make index`, `TEST_DATABASE_URL=… make test` | Uses another database; a variable that is set wins over `.env` |
| `YOUTUBE_API_KEY` in `crawler/.env` | `make seed` also crawls YouTube; without it, YouTube is skipped |
| `WHISPER_MODEL=small.en make index` | Also transcribes podcast episodes without a transcript, offline; the first run downloads the model (0.5 GB), and the seed's episodes take about 1.5 hours on a Mac mini (M4; [podcasts](sources/podcasts.md#indexing)) |
| `cd crawler && uv run crawler pubmed --topic prostate_cancer --max-results 200 --store` | Adds more documents; needs `DATABASE_URL` in `crawler/.env` ([connecting](database.md#connecting)). Run `make index` afterwards. Other sources and flags: [crawler](../crawler/README.md) |

## Limitations

- **Index before you query.** Without `make index`, `match_journey` answers `degraded: true` with no results.
- **The first `make index` takes about 30 minutes, mostly because of arXiv's rate limit.** arxiv.org asks for 15 s between requests (`Crawl-delay: 15` in its robots.txt, see [request budgets](sources/README.md#5-storage-limits-and-retention)), and a paper without an HTML version needs a second download, the PDF. Zenodo allows one file a second. The indexer reads 500 documents at a time, all hosts in parallel, and starts the next 500 when the slowest download is done, so batches of Zenodo records and of arXiv papers add up. It prints its progress every minute. You can stop it with Ctrl+C: the next run continues with the documents not read yet, and tries failed downloads again. Later runs read only new and changed documents.
- **A changed indexer only reads new and changed documents.** To rebuild the keyword index from scratch, drop it, then run `make index`:

  ```sh
  docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "DROP SCHEMA keyword CASCADE"'
  ```
- **The seed is a small sample.** Journeys on diseases it barely covers find little. How the ranking can go wrong: [keyword matching](keyword-matching.md#known-limitations).
- **Local use only.** The server listens on `127.0.0.1` and has no authentication.
- **Old database volumes** warn "collation version mismatch": [database](database.md#data-and-initialization).
