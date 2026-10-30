# backend

Code copied from the SS26 AIlixir project for issue #13. It is the starting point for the Patient Journey Matcher, not a working service yet. What we keep and why is described in [`../Documentation/reuse/what-to-keep.md`](../Documentation/reuse/what-to-keep.md).

## Setup

Python 3.12 or newer and [uv](https://docs.astral.sh/uv/). Run from this folder:

```sh
uv sync --locked      # install into backend/.venv
uv run pytest         # import check for every module
cp .env.example .env  # only needed to run the services
```

`api/`, `workers/` and `shared/` are imported from this folder (`uvicorn api.main:app`). The scrapers are imported as `src.backend...` from `scrapers/`, see [`scrapers/README.md`](scrapers/README.md).

## Origin

- Repository: https://github.com/amosproj/amos2026ss03-ailixir-intelligence
- Commit: `88ea71a`. `scrapers/topics.py` comes from `05b6c2c^`, because SS26 deleted it later.
- Licence: MIT, Copyright (c) 2021 The AMOS Projects, the same as this repository. See [`../NOTICE`](../NOTICE).
- Paths mirror the original `Backend/` folder, so `backend/<path>` here is `Backend/<path>` there.

## Layout

| Folder | Content | Section in what-to-keep.md |
|---|---|---|
| `scrapers/` | PubMed, arXiv and YouTube scrapers, base scraper, orchestrator, monthly runner, keyword and channel lists, disease topic map | Source ingestion |
| `api/chat_pipeline/` | Paper retrieval, AstraDB client, Vertex AI ranking client, availability and circuit breaker, patient-graph retriever, Graphiti client | Literature retrieval and reranking; patient-document processing |
| `api/` | Document endpoints, authentication, request-ID middleware, error envelope | Patient-document processing |
| `workers/` | Document event handler, document pipeline, multimodal extraction and prompts, medical ontology, graph builder, Cypher exporter, service connections | Patient-document processing; shared data and service connections |
| `shared/` | Document, extraction, journey-summary, user and error models, Firestore repositories, GCS, Pub/Sub, retryable errors | Shared data and service connections |

## Changes against the original

Everything is byte-for-byte as in `88ea71a`, except:

1. `scrapers/src/backend/Scrapers/YouTube/you_tube.py`: the hard-coded API key is removed and read from `YOUTUBE_INNERTUBE_KEY`.
2. `scrapers/src/backend/__init__.py`: the working-directory search stops at the filesystem root, where it could loop forever, and the package no longer writes a `.env` file on import.
3. `api/main.py`: the chat and voice routers are not part of the plan, so their two imports and `include_router` calls are removed.
4. Issue #27: `api/`, `workers/` and `scrapers/requirements.txt` are replaced by one `pyproject.toml` and `uv.lock`. `google-cloud-pubsub==2.27.1` needed protobuf<6 and could not be installed together with `google-cloud-storage==3.10.1`, so it is a lower bound now.
5. Issue #27: `.env.example` and `scrapers/.env.template` are merged into `.env.example`, which lists every variable the code reads. Variables of code that was not copied (OCR, ElevenLabs, test users, Firebase web key) are removed.

## Not copied

The chat endpoint and its pipeline (contextualizer, answerer, titler), voice and ElevenLabs, Firebase functions, the mobile app, OCR (`workers/pipeline/ocr/`), the legacy graph prompt, the `LiteraturePaper` model and repository, Terraform, Dockerfiles, CI workflows, and the scraper state files (`scrapers/data/*/index.json`).

## Status

- Installs with `uv sync --locked`, and every module imports without credentials (`uv run pytest`). Running the services needs credentials for Firebase and Firestore, GCS, Pub/Sub, Vertex AI, OpenAI, AstraDB and Neo4j; see `.env.example`. There are no functional tests or CI yet.
- The adaptation work is listed under "What needs adaptation" in what-to-keep.md. Known issues found while reviewing the code:
  - `scrapers/.../PubMed/pub_med.py` keeps only the first section of structured abstracts, loses the whole author list when a group author is present,.
  - `scrapers/.../Archive/archive.py` creates a new arXiv client per call, which bypasses the client's 3-second delay between requests.
  - `scrapers/.../YouTube/you_tube.py` fetches transcripts through YouTube's internal player API, which conflicts with YouTube's terms of service.
  - The documents bucket is read as `GCS_BUCKET_NAME` by `shared/gcs.py` and as `GCS_DOCUMENTS_BUCKET` by `workers/connections/gcs.py`.
  - `shared/firestore.py` and `shared/gcs.py` both read `FIREBASE_KEY_RELATIVE_PATH` but default to different files.
  - `workers/pipeline/graph/builder.py` uses the current time when a document date cannot be parsed.
  - `workers/pipeline/graph/exporter.py` is optional; what-to-keep.md suggests removing it together with its fields.
- For the SBOM: the Neo4j server is GPL-3.0, and the dependencies of `paperscraper` (PDF download in `pub_med.py`) still need a licence check.
