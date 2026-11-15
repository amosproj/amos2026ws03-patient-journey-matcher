# Issue 55: test findings and workflow

ISSUE 55  /  01

Integration test findings

The application workflow passes with real components and deterministic local provider responses. The strongest result is that a term present only in downloaded article text becomes discoverable through MCP.

| Verification | Result | Evidence |
| --- | --- | --- |
| Integration suite, freshly rerun | 17 passed / 3 files | 15 November 2026. 15.34s (tests 96%, import 4%) |
| Crawler regression suite | 520 passed | Earlier full local check in this implementation session. |
| Ordinary matcher tests | 145 passed | Earlier full local check; integration tests excluded. |
| Static checks | Passed | Crawler lint, format and mypy; matcher lint and typecheck. |

What the results establish

Connected workflow. Python collection writes rows that the TypeScript indexer and MCP service can read from the same isolated database.

Full-text contribution. zenodo:101 matches Olaparib despite its title having no such term. zenodo:102 matches metadata; unrelated zenodo:103 is excluded.

Recovery. Transient download errors retry, failed files recover on a later indexing run, and successful metadata search survives background file failures.

Stable MCP behavior. Invalid requests fail without disabling the server. Missing indexes degrade safely; valid no-match searches remain non-degraded.

Evidence context: branch feature/55-mcp-integration-tests-error-handling; base HEAD 7ac9f36 with uncommitted integration changes. Test totals include parameterized cases; one test can contain several assertions.


---


ISSUE 55  /  02

Workflow: inputs to outputs

Collection and indexing prepare the corpus before a client searches. Every application stage shown below uses its real implementation; external provider services are represented by a local HTTP fixture server.

Boundary that matters: match_journey reads a prepared index. It does not start a crawl. get_source returns stored links; a later HTTP file failure belongs to the downloading client.

Isolation: one disposable database per integration file; loopback servers use allocated ports. Python/provider and download adapters reject unknown external destinations and redirects. Biopython parses XML with packaged DTDs; external DTD downloads are rejected.


---


ISSUE 55  /  03

Worked example: Olaparib

Actual synthetic MCP arguments used by the workflow test. Algorithm and limit are omitted to exercise the defaults: keyword and 10.

```json
{
  "journey": {
    "patient_id": "synthetic",
    "events": [
      {
        "id": "focus",
        "type": "therapy",
        "label": "Olaparib",
        "date": "2026-01-01"
      }
    ]
  }
}
```

| Source | Fixture input | Observed output |
| --- | --- | --- |
| zenodo:101 | Title: Clinical treatment evidence.Article body contains Olaparib. | Full text indexed; terms contain olaparib; source returned by MCP. |
| zenodo:102 | Title: Olaparib clinical evidence.No full-text files. | Metadata match; get_source returns downloads: []. |
| zenodo:103 | Title: Weather observations.No full-text files. | Stored successfully; absent from Olaparib matches. |

Verified output projection. Source IDs are sorted here for readability; result scores, ranks and optional metadata are deliberately omitted. This is an explanatory projection, not an exact wire-response dump.

```json
{
  "algorithm": "keyword",
  "focus_event_id": "focus",
  "degraded": false,
  "matched_source_ids": [
    "zenodo:101",
    "zenodo:102"
  ]
}
```

Controls: limit: 1 returns one result; a podcast-only filter returns no article results; Pembrolizumab produces an empty, non-degraded response; as_of selects the earlier Olaparib event over a future event.

Reindexing result: running the indexer again without recrawling makes zero additional provider/file requests in the unchanged successful workflow.


---


ISSUE 55  /  04

Recovery and download findings

Backoff values above are recorded through the injected sleep function; the tests avoid waiting for those real-time delays. HTTP requests, abort signals and extraction remain real.

| Injected condition | Verified behavior |
| --- | --- |
| 404 then readable second locator | Requests follow locator order; the second HTML file is extracted and matched. |
| 503 or 429, then 200 | Exactly three attempts; recorded delays [1000, 4000] ms; indexed status. |
| Persistent 503; later 200 | Failed after three attempts; next index run fetches once more and recovers. |
| Response stalls / connection disconnects | Three attempts; failed status; good metadata still matches. Timeout is 100 ms in the harness. |
| Unsupported format / audio with transcription off | Skipped; no file fetch; metadata remains usable. |
| Declared size 200,000 bytes; limit 100,000 | Skipped before download; zero file requests. |
| Chunked response exceeds 100,000 bytes | One file request; skipped after enforcing the body limit. |
| Invalid PDF bytes | Skipped during real extraction; indexing continues. |

A 404 fallback is distinct from an exhausted server/network failure: the current downloader stops trying lower-priority locators after the latter. The tests preserve that policy.


---


ISSUE 55  /  05

MCP and provider results

| Scenario | Result demonstrated |
| --- | --- |
| Invalid journey / options | Missing patient ID, no events, invalid date, absent label, 501 events, early as_of, limits 0/51 and unsupported content type return isError. A valid call then works. |
| Unavailable algorithm / empty source ID | graph is rejected; an empty source ID fails validation. |
| Missing keyword index | Search is degraded before indexing; indexing restores successful matching. |
| Valid no-match journey | Empty results with degraded: false. |
| Unknown source ID | isError: true with SOURCE_NOT_FOUND in the text response. |
| Real source query failure | Temporarily renamed documents table yields INTERNAL_ERROR; the response omits the renamed table. Table is restored in finally and matching resumes. |
| File disappears after indexing | get_source still returns its stored link; the client sees HTTP 404; matching remains usable. |

Additional provider workflows

PubMed / PMC: real XML parsing collects pubmed:301 and cited pubmed:302 at reference depth one. The cited row retains found_by provenance naming pubmed:301. PMC version metadata supplies an XML locator; pubmed:302 is indexed, returned by MCP and retrievable through the mapped file fetch.

Podcast: a real RSS parser stores an episode with a WebVTT transcript. Its transcript contributes Olaparib to matching and its URL appears in get_source. The audio URL is not fetched.

Partial collection: one search keeps failing with 503 while another succeeds. The good record persists; one failure and crawl_runs.ok = false are recorded. The surviving record is still indexed and matched.

Success payloads are parsed using matchResultSchema and sourceDownloadsSchema. Validation errors can be plain text; known tool errors use JSON text. The graph scenario checks rejection rather than asserting the exact NOT_AVAILABLE code.


---


ISSUE 55  /  06

Fixes, scope and evidence

Changes made while building the suite

| Area | Finding and resulting change |
| --- | --- |
| Unknown thrown values | The search catch path used a type assertion that could not protect against null. It now normalizes unknown values. Focused tests cover null, undefined, numbers, strings and marker-bearing objects. |
| Ordinary error logs | Exception names/codes can contain arbitrary data. Ordinary logs now use fixed messages; private marker tests check result and log sanitization. Deliberate developer tracing remains separate. |
| HTTP route | Production and tests now share createMcpHttpServer(). Rejected handler promises receive a generic 500 or response termination. |
| Database lifecycle | The helper exposes its generated URL to the Python subprocess and cleans up initialization failures. template0 with C locale avoids the observed local template collation mismatch. |
| Test fixture compatibility | The public URL schema rejected numeric loopback download URLs. Synthetic hostnames are stored and explicitly mapped to loopback by fixture adapters. |

What this evidence does not establish

These are deterministic workflow and recovery tests. They do not establish live-provider compatibility, clinical relevance, medical correctness, ranking quality, production latency or load capacity. Valid PDF extraction is not part of this workflow suite; the PDF case uses corrupt bytes. Whisper inference and compare_algorithms are excluded.

Error assertions vary in depth: the suite checks validation rejection and subsequent usability, but it does not assert detailed validation-message wording for every case. Cleanup is implemented and succeeds during these runs; this is not exhaustive fault injection into every cleanup action. CI execution is configured, but hosted CI was not run in this session.

Reproduce: start the project database with make db; provide TEST_DATABASE_URL; run make test-integration. make test also runs crawler and ordinary matcher checks. Dependency installation may use the network; fixture scenarios use local HTTP mappings.

Evidence files: matcher/mcp-server/src/integration/{workflow,providers,errors}.test.ts; harness.ts; providers.ts; crawler/tests/integration_support/crawl.py; matcher/mcp-server/src/match.test.ts. The adjacent execution log records the fresh integration run.
