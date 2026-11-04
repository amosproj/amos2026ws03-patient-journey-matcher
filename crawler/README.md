# Source crawler

Collects metadata from PubMed, arXiv and YouTube with Crawlee and follows the references
of the papers it finds ([architecture](../Deliverables/sprint-02/crawler-evaluation.md)).
It writes JSON Lines to stdout and stores nothing; writing to the `documents` table is
#41. Metadata only: no PDFs, full texts or transcripts.

## Setup

```sh
cd crawler
uv sync --locked
cp .env.example .env   # fill in the keys you need
```

| Variable | Needed for |
|---|---|
| `NCBI_ENTREZ_EMAIL`, `NCBI_API_KEY` | PubMed; optional, the key raises the limit from 3 to 10 requests/s |
| `SEMANTIC_SCHOLAR_API_KEY` | arXiv references; without it most requests get HTTP 429 |
| `YOUTUBE_API_KEY` | YouTube; required |

## Run

```sh
uv run crawler pubmed "prostate cancer" --max-results 10
uv run crawler pubmed --topic prostate_cancer
uv run crawler arxiv --topic prostate_cancer --max-depth 0
uv run crawler youtube --topic prostate_cancer
```

- `--topic` takes an ID from `topics/` or a path to a YAML file and can be repeated.
- `--max-depth` sets how many levels of references are followed (default 1, 0 = none).
  `--max-requests` caps a run.
- Records go to stdout, one JSON object per line, and a summary goes to stderr.
- Exit code 0 means ok, 1 means at least one request failed (the other records are still
  written), and 2 means wrong arguments or configuration.

## Topic files

One YAML file per disease area in `topics/`. The file name is the topic ID.

```yaml
id: prostate_cancer
label: Prostate cancer
terms: [prostate cancer, prostatic neoplasm]        # topic filter for cited papers
queries: [prostate cancer, prostate cancer biopsy]  # PubMed and arXiv
channels:                                           # YouTube
  - name: ZERO Prostate Cancer
    url: https://www.youtube.com/channel/UC5TTkqc3lQcej4XnTXz4MqQ
```

## How it works

One Crawlee queue holds three kinds of request:

1. **Seeds:** one search or channel listing per query or channel.
2. **References** of the collected papers (link extractor): PubMed via NCBI ELink, arXiv
   via Semantic Scholar. YouTube has none.
3. **Lookups** of the cited papers, in batches.

The rules for what gets fetched are in `src/crawler/frontier.py`. Each paper is fetched
once per run, references are followed up to `--max-depth`, and a cited paper is kept
only if it contains one of the topic's `terms`. Papers in `CollectionOptions.known_ids`
are not fetched again; #41 fills it from the database. Each record says in `found_by`
how it was found: `{topic, query}` or `{cited_by}`.

Network errors, timeouts, HTTP 429 and HTTP 5xx are retried three times, after 2, 4 and
8 seconds or the source's `Retry-After`. Other errors are not retried. A failed request
is listed in the summary and does not discard the other records.

The record fields are defined by `SourceDocument` in `src/crawler/models.py`. YouTube
records have `refresh_after` (30 days after retrieval) for YouTube's retention rule.

## Check

```sh
uv run ruff check . && uv run ruff format --check . && uv run mypy src && uv run pytest
```

The tests use fakes and never call external APIs.
