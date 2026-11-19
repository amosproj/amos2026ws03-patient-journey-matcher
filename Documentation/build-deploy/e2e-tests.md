# End-to-end tests

The tests in [`matcher/mcp-server/src/integration/`](../../matcher/mcp-server/src/integration/) run the whole workflow with the real components: the Python crawler stores documents in a new database, the indexer downloads and indexes their full texts, and an MCP client calls `match_journey` and `get_source` over HTTP. A local HTTP server answers in place of Zenodo, PubMed, PMC and the podcast feeds, so the tests need no internet access and no credentials.

```sh
make db
make test-integration
```

`make test` and [CI](github-ci.md) run them too. Without `TEST_DATABASE_URL` (the root `.env` sets it for `make`), they are skipped, except on CI.

Not covered: the live providers, the quality of the ranking, reading a valid PDF and transcribing audio with Whisper.
