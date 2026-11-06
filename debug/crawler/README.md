# Crawler debug UI

Local web UI to start crawler runs and watch them live: source calls, retries, documents,
citation graph and failures.

```sh
make debug             # then open http://127.0.0.1:8765
make debug PORT=9000   # on another port
```

API keys come from `crawler/.env`. Finished runs are kept in `debug/crawler/runs/` (gitignored).
