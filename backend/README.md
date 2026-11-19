# backend

Code copied from SS26, the AMOS project for AIlixir in the summer semester 2026, for issue #13. It is not part of the product and not checked in CI. [`scripts/patient_graph.py`](../scripts/patient_graph.py) (`make graph`) uses its graph steps to build patient graphs from the synthetic documents. The reuse plan and the notes on the copy: [SS26 reuse](../research/ss26-reuse.md).

- Repository: https://github.com/amosproj/amos2026ss03-ailixir-intelligence, commit `88ea71a`; paths mirror its `Backend/` folder.
- Licence: MIT, Copyright (c) 2021 The AMOS Projects, the same as this repository ([`NOTICE`](../NOTICE)).

## Setup

Python 3.12 or newer and [uv](https://docs.astral.sh/uv/). From this folder:

```sh
uv sync --locked      # install into backend/.venv
uv run pytest         # import check for every module
cp .env.example .env  # only needed to run the services
```

Running the services needs credentials for Firebase and Firestore, GCS, Pub/Sub, Vertex AI, OpenAI, AstraDB and Neo4j; see `.env.example`.

## Where the reused parts went

| SS26 code | Now |
|---|---|
| `scrapers/` for PubMed, arXiv (`Archive`) and YouTube (official API part), `BaseScraper` | Rewritten as [`crawler/src/crawler/sources/`](../crawler/src/crawler/sources/) (#27); PDF downloads, transcript scraping, chunking and embedding dropped |
| `scrapers/key_words/*.csv`, `scrapers/topics.py` | Seed queries in [`crawler/topics/`](../crawler/topics/), one YAML file per disease area (#23) |
| `api/chat_pipeline/paper_retriever.py` (`PaperReference`, `PaperRetrievalResult`) | The field names of the MCP results ([MCP interface](../Documentation/user/mcp-interface.md)) |
| `workers/pipeline/graph/` (Graphiti builder, `medical_schema.py`) | Used here by `make graph`; the types are the reference for the patient graph |
| `api/`, `workers/` document pipeline, `shared/` (Firestore, GCS, Pub/Sub) | Not used; the document pipeline stays with AIlixir |

## SBOM

`make graph` uses four packages of this folder directly, at the versions in `uv.lock`: graphiti-core (Apache-2.0), google-genai (Apache-2.0), python-dotenv (BSD-3-Clause) and kuzu (MIT), the last in the dependency group `graph`. None is copyleft; the Neo4j server that the services would need is GPL-3.0. [`scripts/dependencies.py`](../scripts/dependencies.py) lists only `crawler/` and `matcher/`, so add these four to the bill of materials by hand.
