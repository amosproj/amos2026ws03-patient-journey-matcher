# Debug UI

Local web UI with one screen per step of the pipeline:

| Screen | Shows |
|---|---|
| **Runs** | Starts crawler runs and shows them live: source calls, retries, documents, citation graph and failures. "Store in the database" stores a run like `--store` |
| **Database** | The stored documents, store runs and the schema of every table; a document also shows what the keyword index holds of it. Empties tables once you type the database name |
| **Index** | The [keyword index](../../Documentation/keyword-matching.md): how many full texts each source has, why the others are missing, the most frequent keywords and what the journey terms find. Starts the indexer job like `make index` |
| **Matcher** | `match_journey` for a synthetic journey, cut at any of its dates, with the steps of the match: the terms of each event, the rank of each hit in both indexes and the terms found there. Other ranking constants can be tried without changing code |

```sh
make debug             # then open http://127.0.0.1:8765
make debug PORT=9000   # on another port
```

API keys and `DATABASE_URL` come from `crawler/.env`. Finished crawler runs are kept in `debug/crawler/runs/` (gitignored).

The Index and Matcher screens run the matcher's own programs, so they need `make build`. The Matcher screen takes pasted or opened journeys and lists those under `patientdata/*/timeline.json`; it passes a journey on to the matcher and stores none. With "Through the MCP server" it calls the server of `make start` instead (on `MCP_PORT`, if set).
