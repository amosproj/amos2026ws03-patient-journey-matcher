# Crawler debug UI

Local web UI to start crawler runs and watch them live: source calls, retries, documents,
citation graph and failures. The **Database** screen shows the stored documents, store runs
and schema, and empties tables once you type the database name; "Store in the database" stores
a run like `--store`.

```sh
make debug             # then open http://127.0.0.1:8765
make debug PORT=9000   # on another port
```

API keys and `DATABASE_URL` come from `crawler/.env`. Finished runs are kept in
`debug/crawler/runs/` (gitignored).
