# MCP interface

Version 0.1, a proposal for #7. It is not yet confirmed by AIlixir, see [Open questions](#open-questions). The schemas in [`matcher/mcp-server/src/contract.ts`](../matcher/mcp-server/src/contract.ts) are the source of truth for field names and limits. `match_journey` works with the `keyword` algorithm ([keyword matching](keyword-matching.md)); the other algorithms answer with the error code `NOT_AVAILABLE`.

All fields use `snake_case`, like the journey generator and the SS26 retrieval code.

## Connection

The server speaks MCP over Streamable HTTP at `POST /mcp`. It listens on `127.0.0.1` only, because it has no authentication yet. It keeps no sessions. Start and try it: [build and run](build.md#run-the-matcher-locally).

| Environment variable | Default | Meaning |
|---|---|---|
| `MCP_PORT` | `3000` | Port of the server |
| `DATABASE_URL` | none, required | The database with `documents` and the indexes; `make start` sets it from the root `.env` |

## Tools

| Tool | Purpose |
|---|---|
| `match_journey` | Returns the sources most relevant to the most recent event of a patient journey |
| `get_source` | Returns the links to the files of one matched source at its origin. The client downloads them itself |

To compare the three algorithms, a client calls `match_journey` once per algorithm with the same journey.

### `match_journey` input

| Field | Type | Required | Notes |
|---|---|---|---|
| `journey` | object | yes | See below |
| `algorithm` | `keyword`, `graph`, `ai_summary` | no | Default `keyword` |
| `limit` | integer, 1 to 50 | no | Default 10 |
| `content_types` | list of `content_type` values, see [output](#match_journey-output) | no | Default: all types |

`journey` has the format of the generator's `timeline.json`, so a generated journey can be sent unchanged. The real app will send its patient graph instead, see [Review with AIlixir](#review-with-ailixir). Other fields, such as `pathway_id`, `start_date` and `documents`, are dropped.

| Field | Type | Required | Notes |
|---|---|---|---|
| `patient_id` | string | yes | A pseudonym, never a real identifier |
| `as_of` | ISO date | no | The "now" of the journey, see below |
| `events` | list, 1 to 500 | yes | |
| `events[].id` | string | yes | |
| `events[].type` | string | yes | The generator uses values such as `surgery` and `followup`. Not an enum, because the format of the real app is still open |
| `events[].label` | string | yes | German free text in the generated journeys |
| `events[].date` | ISO date | yes | |
| `events[].specialist` | string | no | |
| `events[].parameters` | object | no | Event details such as `psa_value` or `decision` |

**Most recent event.** This is the last event dated on or before `as_of`. If several events share that date, the last one in the list counts. Without `as_of`, it is the last event of the whole journey. An `as_of` earlier than every event is rejected, because then there is no most recent event. `as_of` exists because generated journeys run years into the future, so a client may want to match against a point in the middle of a journey.

### `match_journey` output

| Field | Type | Required | Notes |
|---|---|---|---|
| `algorithm` | string | yes | The algorithm that produced the list |
| `focus_event_id` | string | yes | The event treated as most recent |
| `results` | list | yes | Best match first. Empty if nothing fits |
| `degraded` | boolean | yes | `true` if a search could not run, so an empty list does not mean "nothing relevant" |
| `degraded_reason` | string | no | |

Each result holds the source reference and optional relevance information:

| Field | Type | Required | Notes |
|---|---|---|---|
| `rank` | integer | yes | Starts at 1 |
| `source_id` | string | yes | Stable ID, for example `pubmed:42745507`. Input of `get_source` |
| `title` | string | yes | |
| `source` | string | yes | Where the entry comes from, for example `pubmed`, `arxiv`, `zenodo`, `youtube` |
| `content_type` | `journal_article`, `preprint`, `conference_paper`, `poster`, `presentation`, `report`, `book`, `video`, `podcast_episode` | yes | As stored, see [sources §2](sources/README.md#2-metadata-schema) |
| `url` | URL | yes | Link to the original |
| `summary` | string | no | Abstract or description of the source, in full, for the card in the app. Missing only if the source has none |
| `image_url` | URL | no | Picture for the card. So far only YouTube videos have one, their thumbnail |
| `published_date` | string | no | As precise as the source provides it |
| `authors` | list of strings | no | |
| `licence` | string | no | |
| `score` | number, 0 to 1 | no | Only comparable within one list, not between algorithms |
| `matched_terms` | list of strings | no | Why this source matched |
| `explanation` | string | no | Short text for the same purpose |

Example:

```json
{
  "algorithm": "keyword",
  "focus_event_id": "e14",
  "results": [
    {
      "rank": 1,
      "source_id": "pubmed:42745507",
      "title": "Salvage radiotherapy after radical prostatectomy",
      "source": "pubmed",
      "content_type": "journal_article",
      "url": "https://pubmed.ncbi.nlm.nih.gov/42745507/",
      "summary": "When radiotherapy helps after PSA rises again.",
      "score": 1,
      "matched_terms": ["biochemical recurrence"]
    }
  ],
  "degraded": false
}
```

### `get_source`

The input is `{ "source_id": "pubmed:42745507" }`. The output holds the fields of the source reference plus `downloads`, the files of the source at its origin. The server downloads and stores nothing: the client fetches a file itself and has to follow the `licence` of the source.

| Field | Type | Required | Notes |
|---|---|---|---|
| `downloads` | list | yes | In the order to try them, for example the HTML page of an arXiv paper before its PDF. Empty if the source has no file, as for YouTube videos and PubMed records without a full text in PMC; then `url` is the only link |
| `downloads[].url` | URL | yes | |
| `downloads[].kind` | string | yes | `jats`, `html`, `pdf`, `file`, `transcript` or `audio` |
| `downloads[].media_type` | string | no | Says how to read the file: the PMC bucket and Zenodo serve every file as `application/octet-stream` |
| `downloads[].size` | integer | no | In bytes |

Example:

```json
{
  "source_id": "arxiv:2007.05098",
  "title": "Optimal control of cytotoxic and antiangiogenic therapies on prostate cancer growth",
  "source": "arxiv",
  "content_type": "preprint",
  "url": "https://arxiv.org/abs/2007.05098",
  "licence": "CC-BY-4.0",
  "downloads": [
    { "url": "https://arxiv.org/html/2007.05098v1", "kind": "html", "media_type": "text/html" },
    { "url": "https://arxiv.org/pdf/2007.05098v1", "kind": "pdf", "media_type": "application/pdf" }
  ]
}
```

## Errors

Failures inside a tool return an MCP result with `isError: true` and this text:

```json
{ "error_code": "SOURCE_NOT_FOUND", "message": "Unknown source pubmed:1." }
```

| Code | Meaning |
|---|---|
| `NOT_AVAILABLE` | The requested algorithm is not available |
| `SOURCE_NOT_FOUND` | `get_source` got an unknown ID |
| `INTERNAL_ERROR` | An unexpected failure. The result always has the same message, without any details |

The SDK checks the input before a tool runs and the output after it. When a check fails, the result has `isError: true`, but its text is a plain sentence, such as `Input validation error: ...`, without an `error_code`. A client must not parse every error text as JSON.

## Health data

The server does not store or log the journey. It also does not log the message of an unexpected failure, because the message can contain journey data. Development uses synthetic journeys only.

## Review with AIlixir

Results of the partner meeting on 06.11.2026:

- **Matching runs offline, not live.** AIlixir calls `match_journey` when a patient profile changes, for example when a new report comes in, or on a schedule. The tools keep no state, so this needs no change here.
- **Input is the whole patient graph.** AIlixir will send the complete patient profile graph with entities, relationships and history, not `timeline.json`. Older events can stay relevant depending on the medical context and trends over time. The graph format is described in [Patient graph](#patient-graph). Until a graph input exists, `timeline.json` stays the input for generated journeys and tests.
- **Output is a card.** Each result needs at least a title, a link and a short summary or abstract, and a picture if possible. That is why `summary` and `image_url` were added.

Result of the data request in #44 (Slack, 09.11.2026):

- **AIlixir shared the input of the graph, not the graph.** Their Drive holds the PDF reports of ten generated patients, Patient-1 to Patient-10, made with the same generator we use. It has no `timeline.json` and no graph.
- **There is no separate transfer format.** The graph is what the SS26 pipeline builds from these PDFs. AIlixir suggests that we set the pipeline up and run it ourselves, so we do not depend on a static snapshot.

## Patient graph

This is the graph that the SS26 pipeline builds. We have the code in [`backend/workers/pipeline/graph/`](../backend/workers/pipeline/graph/), and [`medical_schema.py`](../backend/workers/pipeline/graph/medical_schema.py) is the source of truth for the types.

**How it is built.** Each uploaded PDF is turned into a short clinical text by an LLM (Gemini). Graphiti reads this text and stores it as one episode in Neo4j. Every patient has an own graph, separated by `group_id`. The date of the document is the time of the episode, not the time of the upload.

**Nodes.** One `Patient` node and nodes of 14 more types. Each node has a `name`, a `summary` and the fields of its type.

| Group | Types | Fields with a date |
|---|---|---|
| Core | `Patient`, `Diagnosis`, `Medication`, `LabTest`, `Procedure`, `Provider` | `date_confirmed`, `start_date`, `end_date`, `test_date`, `procedure_date` |
| Oncology | `PathologyResult`, `TumorMarker`, `TreatmentPlan` | `pathology_date`, `test_date`, `planned_start`, `decision_date` |
| Other | `ImagingResult`, `Symptom`, `Allergy`, `VitalSigns`, `Referral`, `Appointment` | `imaging_date`, `onset_date`, `documented_date`, `measurement_date`, `referral_date`, `appointment_date` |

**Edges.** 21 types. From the patient: `HAS_DIAGNOSIS`, `UNDERWENT`, `PRESCRIBED`, `HAD_LAB_TEST`, `HAS_TUMOR_MARKER`, `HAS_PATHOLOGY`, `HAS_IMAGING`, `HAS_SYMPTOM`, `HAS_ALLERGY`, `HAS_VITAL_SIGNS`, `WAS_REFERRED`, `HAS_APPOINTMENT`, `MANAGED_AT`, `HAS_TREATMENT_PLAN`. Between findings: `TREATED_BY`, `CONFIRMED_BY`, `INDICATES`, `PERFORMED_BY`, `REFERRED_TO`, `SYMPTOM_OF`, and `RELATES_TO` as fallback. Each edge holds a `fact`, which is one sentence, and the times `valid_at` and `invalid_at`. When a newer document replaces a fact, for example a new PSA value, Graphiti sets `invalid_at` on the old edge.

**Dates.** The graph in Neo4j keeps the dates: the episode has the document date, the edges have `valid_at` and `invalid_at`, and the nodes have the date fields above. The file export of SS26 does not keep them. [`exporter.py`](../backend/workers/pipeline/graph/exporter.py) writes a `graph.cypher` file that only holds a query to show the graph, and it removes `valid_at` and `invalid_at` from the data it reads. So this file cannot be the input of the matcher.

**What this means for `match_journey`.**

- A graph input needs the nodes and edges with their dates, read from Neo4j or sent as JSON. The Cypher export is not enough.
- The most recent event is then the newest document on or before `as_of`, with the facts that are still valid at that time.
- To get real graphs for tests we have to run the SS26 pipeline on the generated PDFs. This needs a Gemini key and Neo4j. Until then the generated `timeline.json` covers the same patients and events.

## Check against AIlixir's integration needs

| Need | Basis | Status |
|---|---|---|
| Show a list of sources | `PaperReference` in the SS26 code (`title`, `source`, `source_type`, `published_date`, `url`) | Same field names, except `content_type` instead of `source_type`. `url` is required here because we store only links to the originals |
| Tell "nothing relevant" from "search failed" | `degraded` and `degraded_reason` in the SS26 `PaperRetrievalResult` | Same field names |
| Match when the profile changes, not live | Partner meeting 06.11. | No state in the server, AIlixir decides when to call |
| Send generated journeys | Generator `timeline.json` | Checked with one generated journey for each of the 10 pathways |
| Send journeys of the real app | Partner meeting 06.11.: the whole patient graph | Format known, see [Patient graph](#patient-graph). The graph input itself is not built yet |

## Open questions

For AIlixir:

1. Can the app send the graph as JSON with `valid_at` and `invalid_at`, or should the matcher read it from Neo4j? The format and the dates are answered in [Patient graph](#patient-graph).
2. Is it enough that `get_source` returns the download links, so that the app fetches a source itself?
3. Does the app need an `error_code` for invalid input too, or is the plain text enough?

For the team:

4. How does the AIlixir backend reach the server, and how does it authenticate? We decide this with the deployment (#42).
5. Is `keyword` the right default until the evaluation in #11 has results?
