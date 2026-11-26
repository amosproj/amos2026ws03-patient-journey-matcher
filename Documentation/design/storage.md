# Storage and retrieval

The crawler stores what it collects in PostgreSQL; the indexer and the MCP server read it from there ([runtime view](architecture.md#1-runtime-components)). Local setup: [database](../build-deploy/database.md).

| Table | Written by | Read by |
|---|---|---|
| `documents` | crawler | indexer, MCP server |
| `crawl_runs` | crawler | crawler (`--since auto`, `--resume`), people |
| `transcripts` | transcription job; the indexer drops the text once every index has read it | indexer (as a full text), transcription job |
| `transcription` | transcription job (its report), debug UI (how many files at once) | transcription job, debug UI |
| index tables, e.g. `keyword.documents` and `keyword.full_texts` ([keyword matching](keyword-matching.md)) | indexer, transcription job | MCP server |

## Storing

```sh
cd crawler
uv run crawler pubmed --topic prostate_cancer --store
```

`--store` needs `DATABASE_URL` (see [`crawler/.env.example`](../../crawler/.env.example)) and the schema (`make db`); the crawler checks both before the crawl and exits with 2 if one is missing. Cited papers that are already stored are not fetched again. The JSON Lines on stdout stay the same.

A command over several topics crawls and stores them one after another, each as a run of its own with its own row in `crawl_runs`; a query that topics share runs for each of them. So a crawl that is stopped or crashes loses only the topic it was working on, and `--resume` continues with it.

After the crawl, a YouTube run refreshes the stored videos of its channels that expire within 15 days. Then one transaction:

1. upserts each document, refreshed videos included, by `id`: columns get the new values, `found_by` gains the new entries, `changed_at` moves only if the content changed;
2. adds the run's `cited_by` entries to stored documents it did not fetch again;
3. deletes rows whose `expires_at` has passed (YouTube: 30 days after retrieval); a command over several topics does so only with its last topic, when each has refreshed its videos;
4. writes the run to `crawl_runs`.

Storing is tried again for two minutes, so a database that restarts costs nothing. If it still fails, nothing of the run is stored, the crawl stops, `storing failed` goes to stderr and the exit code is 1.

## Documents

[`db/init/02-documents.sql`](../../db/init/02-documents.sql) defines `documents`, one row per record; [`03-crawl-runs.sql`](../../db/init/03-crawl-runs.sql) defines the run log. PMC and OpenAlex have no rows of their own; they add full-text links to PubMed rows ([data sources](sources.md)).

| Column | Meaning |
|---|---|
| `id` | `<source>:<native_id>`, stable across versions; the MCP `source_id` |
| `source` | `pubmed`, `arxiv`, `zenodo`, `youtube`, `podcast` |
| `native_id`, `version` | ID in the source without a version suffix (arXiv without `vN`, Zenodo concept ID), and the version the row describes |
| `content_type` | `journal_article`, `preprint`, `conference_paper`, `poster`, `presentation`, `report`, `book`, `video`, `podcast_episode` |
| `publication_types` | Labels of the source, e.g. PubMed `Review` |
| `title`, `summary` | Plain text; `summary` is the abstract or description, podcast show notes cut to 1,000 characters |
| `authors` | `[{name, orcid, affiliation}]`; channel or host for media |
| `venue` | Journal, channel or show |
| `language` | The source's value (BCP 47); see [languages](#languages) |
| `subjects` | `[{scheme, id, label, major}]`, e.g. MeSH |
| `published_at`, `published_precision` | First public date and `year`, `month` or `day`; both empty if the record has no valid date |
| `source_updated_at`, `duration_seconds` | Last change reported by the source; length of videos and episodes |
| `canonical_url`, `doi` | Page shown to users; DOI in lower case without `https://doi.org/` |
| `external_ids` | e.g. `pmcid`, `pmc_version`, `nihms`, `bookshelf_id`, `openalex`, `concept_doi`, `channel_id`, `feed_key` |
| `licence` | SPDX ID, PMC's CC code without version (`CC-BY-NC`), or an own code (`arxiv-nonexclusive-1.0`, `pmc-tdm`, `youtube-standard`, `all-rights-reserved`); empty means unknown |
| `full_text` | Links to the full text in fetch order: `[{kind, url, media_type, size, checksum, language}]`, `kind` one of `jats`, `html`, `pdf`, `file`, `transcript`, `audio` |
| `found_by` | `[{topic, query}]` or `[{cited_by: <id>}]` |
| `retrieved_at`, `expires_at` | Last successful fetch; YouTube only: `retrieved_at` + 30 days |
| `extra` | Source-specific fields, and `metadata_language`, the detected language of title and summary ([languages](#languages)) |
| `created_at`, `changed_at` | First stored; last change of any column except `found_by`, `retrieved_at` and `expires_at` |

Lists and objects are `[]` or `{}`, never null. The crawler's JSON Lines use other names for some fields: `source_id` → `native_id`, `journal` → `venue`, `abstract` (else `description`) → `summary`, `url` → `canonical_url`, `published_on` → `published_at`, `refresh_after` → `expires_at`, `channel_id` → `external_ids`.

## Languages

The crawler detects the language of each document's title and summary offline with [py3langid](https://github.com/adbar/py3langid) ([`crawler/src/crawler/language.py`](../../crawler/src/crawler/language.py)) and stores it as `extra.metadata_language` (BCP 47, e.g. `en`). A source's `language` can name something else: PubMed gives the article's language, and a German article often has an English abstract. So `language` keeps the source's value.

- Missing `metadata_language` means unknown, not "not English": short titles such as `PSA` are too short to tell, and stored cited papers keep their old row until a run fetches them again. An indexer that skips non-English metadata should treat unknown as matchable.
- Ordinary runs do not fetch stored cited papers again. Backfill their language markers and [OpenAlex](../../research/sources/openalex.md) links with `cd crawler && uv run crawler refresh`; no database reset is needed.
- Non-English documents are stored like the others, so they stay findable and their citations stay complete.

### Refresh stored enrichment

`crawler refresh` reads stored titles/summaries to detect metadata languages and asks OpenAlex for PubMed DOIs without a full-text link. It also removes OpenAlex locators on hosts now listed in `NO_AUTOMATED_DOWNLOAD`, looking for another copy when none remains. It does not recrawl source metadata or use NCBI. Existing PMC locators and source language values are preserved.

```sh
cd crawler
uv run crawler refresh                         # all stored documents
uv run crawler refresh --source pubmed          # one source only
uv run crawler refresh --source pubmed --limit 50  # bounded trial
```

The command uses `DATABASE_URL` from the environment or `crawler/.env`, processes batches of 50 (`--batch-size` can lower this), and reports changed/unchanged records, concurrent changes skipped, and failed OpenAlex batches. A failed lookup or concurrent update gives exit code 1; rerunning is safe. `--limit` always scans from the beginning, so omit it for a complete backfill.

Only enrichment fields and `changed_at` change. Provenance, citations, `retrieved_at`, expiry, and crawl resume dates stay intact. Concurrent content changes are left for another run. Run `make index APPROACHES=keyword` afterwards to update the index.

## Reading

The schema is the only contract between the crawler (Python) and the matcher (TypeScript). The matcher reads through [`@matcher/db`](../../matcher/db/src/documents.ts), which treats rows past `expires_at` as gone:

```ts
import { createDocumentStore, createPool } from "@matcher/db";

const store = createDocumentStore(createPool()); // DATABASE_URL, as for the crawler
const hits = await store.getDocuments(ids); // in the order of ids, e.g. ranked index hits
const next = await store.documentsToIndex("keyword.documents", 500);
```

`toSourceReference` in [`mcp-server/src/sources.ts`](../../matcher/mcp-server/src/sources.ts) turns a document into the fields of a tool result ([MCP interface](../user/mcp-interface.md#match_journey-output)).

Index tables reference their document, so deleting it removes them, and keep the `changed_at` they indexed (as read, in milliseconds; the time a transcript of the document was stored, if later). `documentsToIndex` returns the documents without a row or with a different `changed_at`, and `countToIndex` counts them; polling `changed_at > last run` instead would miss the rows of a store run that commits late.

The columns every index table needs: [adding an approach](../../matcher/algorithms/README.md).

The last run per data source: `SELECT DISTINCT ON (source) * FROM crawl_runs ORDER BY source, finished_at DESC`.

## Limits

- Expired rows are deleted by the next store run. YouTube rows stay while their channels are crawled with `--store` at least every two weeks and the videos stay public.
- Stored cited papers are not refreshed; search results are.
- YouTube rows have no `venue`, and a few rows have no `title` (shown as `Untitled`).

## Graph index

The graph approach keeps its index in the schema `graph` ([`schema.ts`](../../matcher/algorithms/graph/src/schema.ts)):

| Table or view | Holds |
|---|---|
| `graph.documents` | Per paper its normalized PubTator3 entities and relations, and its MeSH headings with their flags |
| `graph.evidence` | One row per concept of a paper and how the paper has it (title, abstract, MeSH major topic …); what a match reads |
| `graph.treats` | The `treats` relations of each paper |
| `graph.concept_names` | The names PubTator3 gives the concepts of the indexed papers, for the dictionary |

A trigger keeps `graph.evidence` and `graph.treats` in step with `graph.documents`. Raising `SCHEMA_VERSION` in `schema.ts` makes the next index run build them and the views again from `graph.documents`, without asking PubTator3; until it has, graph searches answer degraded. Raising `NORMALIZATION_VERSION` makes the index runs fetch every paper again; each keeps its old annotations until then.

## Schema changes

`db/init/` runs when an empty volume starts; `make db` applies it again, so the files must stay idempotent. Put a change into a new numbered file, e.g. `04-….sql` with `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.
