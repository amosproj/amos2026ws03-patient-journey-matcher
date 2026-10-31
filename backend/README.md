# backend

Code copied from the SS26 AIlixir project for issue #13. It is the starting point for the Patient Journey Matcher, not a working service yet. What we keep and why is described in [`../Documentation/reuse/what-to-keep.md`](../Documentation/reuse/what-to-keep.md).

## Origin

- Repository: https://github.com/amosproj/amos2026ss03-ailixir-intelligence
- Commit: `88ea71a`.
- Licence: MIT, Copyright (c) 2021 The AMOS Projects, the same as this repository. See [`../NOTICE`](../NOTICE).
- Paths mirror the original `Backend/` folder, so `backend/<path>` here is `Backend/<path>` there.

## Layout

| Folder | Content | Section in what-to-keep.md |
|---|---|---|
| `api/chat_pipeline/` | Paper retrieval, AstraDB client, Vertex AI ranking client, availability and circuit breaker, patient-graph retriever, Graphiti client | Literature retrieval and reranking; patient-document processing |
| `api/` | Document endpoints, authentication, request-ID middleware, error envelope | Patient-document processing |
| `workers/` | Document event handler, document pipeline, multimodal extraction and prompts, medical ontology, graph builder, Cypher exporter, service connections | Patient-document processing; shared data and service connections |
| `shared/` | Document, extraction, journey-summary, user and error models, Firestore repositories, GCS, Pub/Sub, retryable errors | Shared data and service connections |

## Changes against the original

Everything remaining is byte-for-byte as in `88ea71a`, except:

1. `api/main.py`: the chat and voice routers are not part of the plan, so their two imports and `include_router` calls are removed.
2. Issue #27 moved `scrapers/` into the independent [`../scraper/`](../scraper/) uv project and removed the legacy copy from `backend/`.

## Not copied

The chat endpoint and its pipeline (contextualizer, answerer, titler), voice and ElevenLabs, Firebase functions, the mobile app, OCR (`workers/pipeline/ocr/`), the legacy graph prompt, the `LiteraturePaper` model and repository, Terraform, Dockerfiles, CI workflows, and the scraper state files (`scrapers/data/*/index.json`).

## Status

- Not runnable as is. It needs credentials for Firebase and Firestore, GCS, Pub/Sub, Vertex AI, OpenAI, AstraDB and Neo4j; see `.env.example`. There are no tests or CI yet.
- The adaptation work is listed under "What needs adaptation" in what-to-keep.md. Known issues found while reviewing the code:
  - `workers/pipeline/graph/builder.py` uses the current time when a document date cannot be parsed.
  - `workers/pipeline/graph/exporter.py` is optional; what-to-keep.md suggests removing it together with its fields.
- For the SBOM: the Neo4j server is GPL-3.0.
