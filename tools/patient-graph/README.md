# Patient graph tool

Helper tool that builds the patient graph of one synthetic patient, the second input form of `match_journey` next to the journey ([patient graph](../../Documentation/user/mcp-interface.md#patient-graph)). It is not part of the product and not checked in CI.

```sh
cp tools/patient-graph/.env.example tools/patient-graph/.env   # set GEMINI_API_KEY
make graph PATIENT=Patient-5                                    # writes patientdata/Patient-5/graph.json
```

[`patient_graph.py`](patient_graph.py) runs the two graph steps of the SS26 pipeline on the PDFs of the patient, in the order of their event numbers: Gemini reads a PDF ([`workers/pipeline/llm/`](workers/pipeline/llm/)) and Graphiti adds it to the graph ([`workers/pipeline/graph/`](workers/pipeline/graph/)). Two things differ from SS26, so that it runs without a Google Cloud project: an API key from Google AI Studio instead of Vertex AI, and an embedded Kuzu database under `out/patient-graph/` instead of Neo4j. The model is `gemini-3.5-flash-lite`, as SS26's `gemini-2.5-flash` is deprecated. Model and pacing: [options](../../Documentation/build-deploy/build.md#options).

- A free key allows only some documents per day: the run stops, and the next run goes on with the next document. With a paid key, several patients can run at the same time.
- A document that takes longer than `DOCUMENT_TIMEOUT_S` stops the run the same way, as Graphiti's calls have no time limit of their own.
- If a run stopped by force leaves a Kuzu database that no longer opens, delete the patient's files in `out/patient-graph/` and build the patient again.
- Graphiti warns that its Kuzu support is deprecated. The versions in `uv.lock` keep working; longer use would need Neo4j, like SS26.

## Origin

`workers/` is copied from SS26, the AMOS project for AIlixir in the summer semester 2026: https://github.com/amosproj/amos2026ss03-ailixir-intelligence, commit `88ea71a`, paths as in its `Backend/workers/`. The files are unchanged; only those this tool imports are kept. [`medical_schema.py`](workers/pipeline/graph/medical_schema.py) defines the node and edge types of the patient graph. The rest of the SS26 code (API, document pipeline, Firestore, GCS, Pub/Sub, retrieval) is not kept; where its reused parts went: [SS26 reuse](../../research/ss26-reuse.md#where-the-reused-parts-went).

Licence: MIT, Copyright (c) 2021 The AMOS Projects, the same as this repository ([`NOTICE`](../../NOTICE)).

## Development

Python 3.12 or newer and [uv](https://docs.astral.sh/uv/); `make graph` installs the locked dependencies. In this folder, `uv run pytest` checks that every copied module imports. Commit `uv.lock` with every dependency change.

Its four direct dependencies: graphiti-core (Apache-2.0), google-genai (Apache-2.0), python-dotenv (BSD-3-Clause) and kuzu (MIT); none is copyleft. The [SBOM](../../Documentation/build-deploy/build.md#sbom) lists them with their licences.
