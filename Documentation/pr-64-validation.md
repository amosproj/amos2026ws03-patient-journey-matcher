# PR #64: local validation and follow-ups

Checked 14.11.2026 on `feature/57-crawler-coverage`, using an isolated PostgreSQL 18 database with pgvector and pg_textsearch.

## Features added

- Expanded the OpenAlex blocked-host list after repeated HTTP 403 responses.
- Added `crawler refresh` for stored language markers and OpenAlex links, preserving provenance and existing PMC links.
- Fixed recovery of legacy podcast skips when transcription is enabled.
- Added non-English metadata filtering and cleanup of old indexed content; unknown stays eligible.
- Added read-only `scripts/coverage.py` for links, readable/indexed texts, pending records, and failures.

Whisper implementation and model selection are unchanged. Smaller multilingual models are documented as optional choices. API-key coordination was excluded.

## Local tests

- `make test` with `TEST_DATABASE_URL`: **520 crawler + 123 matcher tests passed**, including database tests, lint, formatting, and types. All **14 OpenAlex tests** also passed after host-list expansion.
- Live checks: 50 PubMed records, four podcasts, language persistence/refresh, and one YouTube API read. Two audio-only episodes transcribed, indexed, and appeared in search; repeat indexing left completed podcasts unchanged.
- Refresh: 47 changes on the first 50-record run, zero on repeat. Seed refresh: 577 scanned, 36 changed, no conflicts/lookup failures. Regression tests cover batching, provenance, PMC preservation, failures, and concurrent updates.
- Speech controls: medical terms, German, invalid/corrupt models. Local CLI workaround: `PYTHONPATH=src` for an editable-install import issue.

## Findings

- Seed: **1,288 records**, YouTube excluded, transcription off. Two crawl requests failed (PubMed HTTP 400; podcast certificate error).
- Before host exclusions: **74.5% linked, 56.3% readable, 53.3% usable English keywords**. Excluding OpenAlex additions gives **54.0% readable**: a gain of **29 papers** on the same dataset.
- Download failures: 33 confirmed HTTP 403s across 22 hosts, plus two server errors. Host-wide exclusions may hide working PDFs; removing broken links alone does not increase readable coverage.
- `small.en` misheard olaparib and hallucinated English from German. Multilingual controls preserved German, allowing rejection by the English keyword check. Medical-name accuracy remains limited.
- Full audio-catalogue testing, M4A/MP4 support, and delayed download retries remain outside these changes.

Per-source coverage and reproduction commands: [sources](design/sources.md#measured-readable-coverage-14112026). Optional model comparisons: [podcasts](../research/sources/podcasts.md#whisper-models).
