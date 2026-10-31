# Source scraper

Standalone metadata scrapers for PubMed, arXiv, and YouTube. This component was
migrated from `backend/scrapers/` for issue #27 and has its own uv project and
lockfile.

The migration intentionally keeps source discovery, metadata parsing, stable
source IDs, retries, and request deduplication. It drops PDF downloads, full-text
and caption scraping, text chunking, OpenAI embeddings, AstraDB indexing, GCS
state synchronization, and Cloud Run deployment. Those are not scraper
responsibilities in the current architecture.

## Setup

Python 3.12 and uv 0.13 or newer are required.

```sh
cd scraper
uv sync --locked
```

Set local configuration in `scraper/.env`. The scraper loads this ignored file
automatically and does not overwrite variables already set in the process environment.

| Variable | Source | Required |
|---|---|---|
| `NCBI_ENTREZ_EMAIL` | PubMed | recommended developer contact |
| `NCBI_API_KEY` | PubMed | no; increases the NCBI rate limit |
| `YOUTUBE_API_KEY` | YouTube | yes |

The `.env` file is intentionally never committed. For compatibility during
migration, `NCBI_EMAIL` and `YOUTUBE_DATA_API_V3` are
accepted as deprecated aliases.

arXiv does not need credentials. The shared arXiv client applies the required
three-second delay and retries. Crawlee queues each scrape request, removes
duplicates, and retries failed handlers up to three times.

## Run

Each command writes one JSON object per source result to standard output:

```sh
uv run scraper pubmed "prostate cancer" --max-results 10 --since 2026-01-01
uv run scraper arxiv "prostate cancer" --max-results 10 --query-mode and
uv run scraper youtube @NationalCancerInstitute --max-results 10
```

YouTube accepts a channel ID, `/channel/` URL, `@handle`, or legacy `/user/`
URL. It uses only YouTube Data API v3 endpoints. The returned metadata includes
`refresh_after`, 30 days after retrieval, so persistence can comply with the
YouTube data-retention constraint.

The Python API exposes the same flow:

```python
import asyncio

from scraper import ScrapeRequest, SourceName, run_requests

documents = asyncio.run(
    run_requests(
        [
            ScrapeRequest(
                source=SourceName.PUBMED,
                query="prostate cancer",
                max_results=10,
            )
        ]
    )
)
```

## Check

```sh
uv run ruff check .
uv run ruff format --check .
uv run mypy src
uv run pytest
```

The unit tests use recorded-shaped in-memory responses and do not call external
APIs. Live commands require network access and the credentials listed above.
