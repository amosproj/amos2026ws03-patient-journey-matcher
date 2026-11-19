# Source crawler

Collects metadata from PubMed, arXiv, Zenodo, YouTube and podcast feeds and follows the
references of the papers it finds. PubMed papers get their full-text links from PMC, else
open-access copies from OpenAlex. Writes JSON Lines to stdout; with `--store` it also
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
uv run crawler pubmed --all-topics --since auto --store   # continue from the last run
docker compose run --rm crawler-pubmed   # the scheduled run, from the repository root
```

The scheduled runs and their options: [deployment](../Documentation/deployment.md#scheduled-crawls).

Sources: `pubmed`, `arxiv`, `zenodo`, `youtube`, `podcast`. `uv run crawler <source> --help`
lists the options. Each output line is a `SourceDocument` (`src/crawler/models.py`).

With `--store`, several topics are crawled and stored one after another, each as a run of its
own: a crawl that is stopped or crashes loses the topic it was working on and nothing else.
`--resume` skips the topics that a successful run of the same command has stored.

`--since auto` continues from each topic's last successful `--store` run, 2 days earlier; a
topic without one runs without a date. A run with a failed request, or stopped by
`--max-requests`, does not count, so the next run covers its period again.

Each document gets `extra.metadata_language`, the language of its title and abstract or
description, detected offline; it is missing where the text is too short to tell
([languages](../Documentation/storage.md#languages)).

`uv run crawler refresh` backfills metadata languages and OpenAlex links on stored records,
including cited papers, without recrawling or resetting the database. Use `--source pubmed`
or `--limit 50` for a smaller run, then reindex ([refresh](../Documentation/storage.md#refresh-stored-enrichment)).

Cited papers are kept only if they match the topic filter: a term of the topic whose papers
cite them (without `--store`: of any topic of the command), or for a single arXiv query its
words (all of them; any with `--query-mode or`). Single PubMed and `raw` queries keep every
cited paper. `--min-citations 2` looks up only the papers that at least two of the collected
papers cite, which leaves out most of them.

## Topic files

One YAML file per disease (`lung_cancer`) or field (`general_cardiology`: channels and podcasts
only) in `topics/`; the file name is the ID. Channels and feeds come from institutions only
(societies, journals, health agencies, hospitals, patient organisations), in English and active
in the last two years; channels as `/channel/<ID>` URLs.

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
