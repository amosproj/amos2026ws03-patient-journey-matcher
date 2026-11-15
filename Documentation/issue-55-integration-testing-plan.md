# Issue 55: integration testing implementation

The suite connects real Python provider parsers, collection and storage to disposable
PostgreSQL databases, production keyword indexing/download/extraction, and the real MCP
SDK over the shared production HTTP route. Provider HTTP is replaced by local fixtures.
Crawling and indexing precede MCP matching; source retrieval returns links and clients
perform downloads. Algorithm comparison and live provider smoke checks remain out of scope.

Run `make db`, then `make test-integration` with `TEST_DATABASE_URL`. See [build.md](build.md).
`make test` and matcher CI include integration execution without duplicating ordinary tests.

- `workflow.test.ts`: full-text-only Zenodo match, metadata match, exclusions, defaults,
  schemas, discovery, retrieval, client download, unchanged reindexing, limits, historical
  focus, content types, no matches, validation and real storage error recovery.
- `providers.test.ts`: RSS transcript matching and links; PubMed XML parsing, reference
  traversal, citation provenance, PMC metadata/locator enrichment and indexed article XML.
- `errors.test.ts`: retry counts/backoffs, 429/503, persistent failure and next-run recovery,
  404 locator fallback, corrupt PDF, unsupported/audio formats, preflight and streamed size
  limits, real timeout abortion and partial collection failure.
- Focused service tests cover non-Error exceptions and private marker sanitization.

The harness owns subprocesses, SDK client/transport, HTTP servers and isolated databases.
Cleanup continues after individual failures. Python helpers use explicit constructors,
reject redirects and external DTD downloads, and retain real Biopython XML parsing using
packaged DTDs. Provider and downloader adapters reject unknown external destinations.
Whisper inference and provider API credentials are unnecessary.

Production changes share HTTP routing and sanitize unexpected failures; ranking and
journey inputs retain their existing contracts. Downloader timeout is configurable for
bounded tests with its existing 120-second production default preserved.
