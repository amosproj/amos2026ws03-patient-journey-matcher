# Source crawler

Collects metadata from PubMed, arXiv, Zenodo, YouTube and podcast feeds and follows the
references of the papers it finds. Writes JSON Lines to stdout; with `--store` it also
upserts them into PostgreSQL ([storage and retrieval](../Documentation/storage.md)).

## Setup

```sh
cd crawler
uv sync --locked
cp .env.example .env   # fill in the keys you need
```

## Run

```sh
uv run crawler pubmed "prostate cancer" --max-results 10
uv run crawler pubmed --topic prostate_cancer
uv run crawler pubmed --topic prostate_cancer --store   # needs DATABASE_URL and `make db`
```

Sources: `pubmed`, `arxiv`, `zenodo`, `youtube`, `podcast`. `uv run crawler <source> --help`
lists the options. Each output line is a `SourceDocument` (`src/crawler/models.py`).

Cited papers are kept only if they match the topic filter: the topic's `terms`, or for a
single arXiv query its words (all of them; any with `--query-mode or`). Single PubMed and
`raw` queries keep every cited paper.

## Topic files

One YAML file per disease area in `topics/`; the file name is the ID.

```yaml
id: prostate_cancer
label: Prostate cancer
terms: [prostate cancer, prostatic neoplasm]        # topic filter for cited papers
queries: [prostate cancer, prostate cancer biopsy]  # PubMed, arXiv, Zenodo
channels:                                           # YouTube
  - name: ZERO Prostate Cancer
    url: https://www.youtube.com/channel/UC5TTkqc3lQcej4XnTXz4MqQ
podcasts:                                           # RSS feeds; key is part of the IDs
  - {key: jco, name: JCO Podcast, url: https://jcopodcast.libsyn.com/rss,
     publisher: ASCO, audience: clinicians}
```

## Check

```sh
uv run ruff check . && uv run ruff format --check . && uv run mypy src && uv run pytest
```

The store tests are skipped unless `TEST_DATABASE_URL` points to a PostgreSQL database, e.g.
the local one; each test uses its own schema and drops it afterwards.
