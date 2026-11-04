# Crawler debug UI

A local web UI to run the crawler and watch it work. Start it from the repository root:

```sh
make debug             # then open http://127.0.0.1:8765
make debug PORT=9000   # on another port
```

Without Make: `cd crawler && uv run python ../debug/crawler/server.py`.

- Start and stop runs for PubMed, arXiv, Zenodo and YouTube, with one query or topic files.
- Watch every source call live: searches, reference lookups, retries and backoff.
- Inspect the documents, the citation graph, the failures and each record's JSON.
- Finished runs are kept in `debug/crawler/runs/` (gitignored) and can be reopened or downloaded as JSONL.

It runs in the crawler's uv environment, uses only the standard library, and plugs into the
crawler's public hooks (`run_requests` with `source_factory`, `link_extractor_factory` and
`sleep`), so the crawler needs nothing extra for it. API keys come from `crawler/.env`. The
server only listens on 127.0.0.1.
