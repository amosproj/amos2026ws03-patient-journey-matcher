# What to keep for the next repository

This plan is based on the four selected sections of [myNotes.md](myNotes.md). The goal is an independent **Patient Journey Matcher** that retrieves relevant medical information from a patient's dated clinical history.

Keep the reusable responsibilities and selected code below, adapting their boundaries for the new project. This document is a migration plan; it does not copy code or change infrastructure. Paths are relative to `amos2026ss03-ailixir-intelligence/` in this workspace. Implementation details come from the notes' review of commit `88ea71a`; they have not been independently reverified here or tested against live services.

# Patient-document processing

## Which code part should we keep?

- **Document upload and lifecycle:** document-related endpoints in `Backend/api/main.py`, plus the relevant helpers in `Backend/shared/gcs.py` and `Backend/shared/pubsub.py`.
- **Background processing:** document event handling in `Backend/workers/main.py` and orchestration in `Backend/workers/pipeline/document_pipeline.py`.
- **Multimodal extraction:** `Backend/workers/pipeline/llm/extractor.py` and `prompts.py`, which turn uploaded PDFs and images into clinical narratives and update journey summaries.
- **Persistence contracts:** document, extraction, and journey-summary models in `Backend/shared/models/`, with their matching repositories.
- **Medical history representation:** `Backend/workers/pipeline/graph/medical_schema.py`, `builder.py`, and the patient-graph retrieval logic in `Backend/api/chat_pipeline/retriever.py`, if the new project retains Graphiti/Neo4j.

The current pipeline uploads files to GCS, publishes a document event, analyzes verified uploaded files, saves a merged extraction, builds a patient-scoped graph episode, and updates a narrative journey summary. Graphiti extracts entities and relationships from the narrative; the initial Gemini analyzer does not directly produce the typed graph.

## Why is it useful for the Patient Journey Matcher?

This supplies the patient-side evidence: diagnoses, treatments, measurements, and their timing across documents. Keep source document identifiers so a matched result can be traced back to the patient facts that motivated it.

The matcher should receive a **versioned, structured journey snapshot** through a journey-provider interface. That snapshot and integration are proposed additions. The existing Firestore summary supports later document extraction; it is not already a structured matcher input. Graph access currently uses the Firebase UID as its group identifier.

## What needs adaptation?

- Define dated journey facts with source references, extraction versions, and rules for current, historical, and conflicting facts.
- Preserve per-file provenance when multiple files become one extraction and graph episode.
- Represent unknown clinical dates explicitly. The current graph builder falls back to the current time when a document date cannot be parsed; that must not become evidence that a clinical event happened today.
- Add durable work claims, recoverable stage checkpoints, and idempotent processing. The current status guard can skip a document left in `processing` after a crash, and retries can repeat completed writes.
- Prevent concurrent summary updates from losing contributions, and address the gap between saving upload state and publishing its event.
- Keep document processing and graph clients behind adapters, outside the ranking core. Preserve authentication, ownership checks, and patient scoping when extracting endpoints from the old API.

Retain upload and extraction when raw documents are required; a first milestone using structured synthetic journeys can defer their runtime setup. If the graph is deferred, retain an explicit dated-event representation with provenance and conflict handling.

## What does it use?

FastAPI, Firebase Authentication, GCS, Firestore, Pub/Sub, Gemini through Vertex AI, Pydantic, and optionally Graphiti/Neo4j. Model clients and embeddings are configurable; keep worker-specific pacing and timeout behavior where needed.

## What are the alternatives?

A structured journey input can avoid document processing initially. Dated relational events or a document/event store can replace the graph, provided chronology, provenance, and conflicting facts remain explicit. Separate OCR followed by extraction is an option if recognized text or OCR-quality checks become requirements.

The legacy `Backend/workers/pipeline/ocr/` and Cypher exporter are not required for the initial retained flow. Remove export calls and associated fields/configuration together if export is omitted; export currently sits on the processing path and can fail after graph writes succeed.

# Source Ingestion in AIlixir

## Which code part should we keep?

Under `Backend/scrapers/`, retain:

- **PubMed discovery and parsing:** `src/backend/Scrapers/PubMed/pub_med.py`.
- **Reusable ingestion behavior:** selected logic from `src/backend/Scrapers/BaseScraper/base_scraper.py` for raw records, stable identifiers, deduplication, chunking, embeddings, and indexing.
- **Batch coordination:** selected logic from `src/backend/Orchestrator/orchestrator.py` and `run_monthly.py`, adapted to the new project's sources and execution environment.
- **Source provenance:** identifiers, titles, dates, URLs, source types, and domain metadata carried into indexed chunks.

The current flow is discovery → fetching → raw JSON storage → chunking → embedding → AstraDB indexing → processing-index updates. It builds an external corpus separately from patient-document processing.

## Why is it useful for the Patient Journey Matcher?

It supplies the medical-information corpus searched against a patient's journey. Keep ingestion independent of matcher requests: the matcher should search an existing index through a retrieval adapter.

Start with PubMed to keep the initial corpus and evaluation manageable, consistent with the notes' omit plan. Preserve the arXiv connector (`Scrapers/Archive/`) and YouTube connector (`Scrapers/YouTube/`) as references for later expansion; they need not run in the first version.

## What needs adaptation?

- Separate fetching/parsing from chunking, embedding, and indexing; these responsibilities are currently coupled in `BaseScraper`.
- Replace shared JSON processing state with durable checkpoints before allowing overlapping ingestion jobs. GCS synchronization does not make JSON updates transactional.
- Preserve stable vector IDs, retry behavior, and provenance during the refactor.
- Track corpus/index versions and ingestion configuration so results and evaluations are reproducible.
- Review chunk size against clinical retrieval needs. The current splitter uses **512 characters with 25 characters of overlap**; these are not token counts.
- Keep ingestion and query embeddings compatible. Changing the embedding model requires a compatible index, usually through rebuilding or a separately versioned index.

## What does it use?

PubMed ingestion uses Biopython Entrez, `paperscraper`, and `pypdf`. Shared indexing uses LangChain's recursive character splitter, OpenAI `text-embedding-3-small`, and AstraDB through `langchain-astradb`. Batch execution uses a Cloud Run Job and Cloud Scheduler, with local JSON state optionally persisted to GCS.

## What are the alternatives?

Metadata/abstract-only ingestion reduces fetching complexity but provides less text. A relational database with vector search could consolidate metadata and vectors. A durable queue and transactional checkpoints can replace shared batch-state files when independent retries or concurrency are needed. These are proposed options, not existing behavior.

# Literature retrieval and reranking

## Which code part should we keep?

- `Backend/api/chat_pipeline/paper_retriever.py`: vector retrieval, reranking orchestration, passages, and distinct source references.
- `Backend/api/chat_pipeline/astra_client.py`: vector-store access and query embeddings.
- `Backend/api/chat_pipeline/reranker_client.py`: Vertex AI Ranking configuration.
- Relevant availability and circuit-breaker conventions from `Backend/api/chat_pipeline/availability.py`.

The existing flow is contextualized question → query embedding → AstraDB similarity search → Vertex reranking → passages and references. Defaults retrieve **four chunks and retain two**, with global `domain=medical` and `sub_domain=oncology` filters. These settings are not derived from a patient's journey.

## Why is it useful for the Patient Journey Matcher?

This is the main reusable search adapter. It already returns passages with available source IDs, titles, types, dates, URLs, and scores. References deduplicate by source ID, falling back to normalized title; URLs can come from metadata or a DOI.

Extract this responsibility from the chat package into an independently callable retrieval service. Add journey-derived queries and per-request filters. Return ranked passages, citations, and the patient facts associated with each match; generated answers can be added later.

Current chat retrieves graph facts and literature in parallel using a shared question. It does not first assemble a structured journey and use that journey to drive literature retrieval. Journey-based matching still needs implementation and evaluation.

## What needs adaptation?

- Define query construction from structured journey facts and an optional information need.
- Replace process-wide clinical filters with validated request-level filtering where appropriate.
- Evaluate candidate counts and ranking against patient-specific relevance judgments, comparing results with the existing question-only baseline.
- Preserve source types and provenance; the current corpus can include preprints and video transcripts as well as papers.
- Define unavailable-service behavior explicitly. Vector search and ranking each default to an eight-second timeout; reranking failure currently returns a degraded empty result. Returning vector candidates as a fallback would be a new policy.
- Keep embedding configuration aligned with ingestion. Similarity and reranking scores must not be presented as clinical confidence or evidence-quality scores.

## What does it use?

AstraDB, LangChain AstraDB/OpenAI integrations, OpenAI query embeddings (default `text-embedding-3-small`), Vertex AI Ranking through `google-cloud-discoveryengine`, Python dataclasses, and asyncio timeouts.

## What are the alternatives?

Keyword retrieval provides a useful evaluation baseline. Hybrid keyword/vector retrieval may improve exact-term coverage. A local reranker can replace hosted ranking if its operating cost and relevance are acceptable. Keep each option behind a retrieval or ranking interface so it can be evaluated separately.

# Shared data and service connections

## Which code part should we keep?

- **Shared models:** relevant document, extraction, journey-summary, and error models from `Backend/shared/models/`.
- **Repository boundaries:** relevant Firestore operations from `Backend/shared/repositories/`.
- **Infrastructure helpers:** selected code from `Backend/shared/firestore.py`, `gcs.py`, `pubsub.py`, and `retryable_errors.py`.
- **Worker connections:** needed clients from `Backend/workers/connections/`, including GCS, Gemini, Graphiti/Neo4j, and paced model access.
- **Retrieval connections:** needed `*_client.py` modules from `Backend/api/chat_pipeline/`, especially AstraDB, query embeddings, and reranking clients.

Keep stable identifiers: Firebase UID scopes ownership and graph access, document IDs link files/extractions/episodes, and literature source IDs identify external content. Review each model's fields and consumers before carrying it over.

## Why is it useful for the Patient Journey Matcher?

These boundaries let the matcher use patient context and literature without embedding database calls in ranking logic. Add explicit contracts for journey snapshots, retrieval requests, and match results, including journey/index versions and source references.

Provide in-memory implementations so the core can run with synthetic journeys and a fixed corpus. Keep verified identity and ownership enforcement at patient-data access boundaries; user-facing requests must not trust an arbitrary client-supplied patient identifier.

## What needs adaptation?

- Centralize shared configuration while retaining separate worker and API clients where workload and pacing needs differ.
- Initialize only the services needed for the selected runtime; importing matcher logic should not require every cloud connection.
- Keep secrets and environment-specific identifiers out of copied code and define configuration for the new repository.
- Preserve structured errors, retry classification, and dependency-availability reporting where relevant.
- Do not assume the existing `LiteraturePaper` model and Firestore literature ledger control ingestion. The notes found no ingestion callers; active scrapers use their own JSON state.

The current storage responsibilities are:

| Store | Responsibility | Retention decision |
|---|---|---|
| Firestore | Patient-document metadata, extractions, summaries, profiles | Keep repositories needed by retained patient processing |
| GCS | Uploaded files and graph exports | Keep file storage when uploads remain; exports are optional |
| Pub/Sub | Document-processing events | Keep when asynchronous document processing remains |
| Neo4j/Graphiti | Patient-scoped clinical graph | Keep behind a journey-provider adapter if graph history is required |
| AstraDB | External-content vectors | Keep behind a corpus-retrieval adapter initially |
| Firebase Realtime Database | Conversations and titles | Defer with chat persistence; not required by the matcher core |

## What does it use?

Pydantic, Firebase Admin/Firestore, GCS and Pub/Sub SDKs, Neo4j/Graphiti, Google Gen AI, and LangChain vector-store/embedding clients. Retain only dependencies used by the chosen adapters.

## What are the alternatives?

Repository interfaces with in-memory implementations support offline development. A relational database could consolidate metadata and dated events. A shared configuration layer can reduce drift without forcing ingestion and interactive requests to use identical clients.

The proposed first retained flow is **structured synthetic journey → journey-derived query → PubMed corpus retrieval → reranked passages with citations and matched facts**. Validate ranking, provenance, patient isolation, missing/conflicting dates, repeated processing, and unavailable dependencies. Connect document extraction and graph-backed journey construction through the same journey contract when those capabilities are needed. This flow and its evaluation suite are proposed work, not existing matcher functionality.
