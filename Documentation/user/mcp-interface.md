# MCP interface

How a client uses the Patient Journey Matcher: the two MCP tools, their inputs and outputs, and the errors. The server is `patient-journey-matcher` version 0.1.0. The schemas in [`matcher/mcp-server/src/contract.ts`](../../matcher/mcp-server/src/contract.ts) are the source of truth for field names and limits. `match_journey` works with the `keyword` approach ([keyword matching](../design/keyword-matching.md)) and, when enabled, `ai_summary` ([semantic setup](../../matcher/README.md#semantic-matching)). Graph and disabled or unbuilt semantic indexes answer with `NOT_AVAILABLE`.

All fields use `snake_case`, like the journey generator.

## Connection

The server speaks MCP over Streamable HTTP at `POST /mcp`. It listens on `127.0.0.1` only, because it has no authentication yet. It keeps no sessions, and the tools keep no state, so a client can call them whenever a patient profile changes. Start it locally with `make start` ([build and run](../build-deploy/build.md#run-the-matcher-locally)); reach the server on the VM through an SSH tunnel ([deployment](../build-deploy/deployment.md#use-the-server)).

| Environment variable | Default | Meaning |
|---|---|---|
| `MCP_PORT` | `3000` | Port of the server |
| `DATABASE_URL` | none, required | The database with `documents` and the indexes; `make start` sets it from the root `.env` |

## Try it

With the server running, open the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) in a second terminal:

```sh
npx @modelcontextprotocol/inspector --transport http --server-url http://127.0.0.1:3000/mcp
```

In the browser, connect to the server, open **Tools** and pick `match_journey`. Turn on **Edit as JSON**, paste these arguments and click **Execute Tool**:

```json
{
  "journey": {
    "patient_id": "demo-1",
    "events": [
      { "id": "e1", "type": "surgery", "label": "Radikale Prostatektomie", "date": "2027-01-22" },
      { "id": "e2", "type": "progression", "label": "PSA-Anstieg – Biochemisches Rezidiv", "date": "2028-12-25" }
    ]
  },
  "algorithm": "keyword",
  "limit": 10
}
```

The answer names the focus event `e2` and lists papers on biochemical recurrence after prostatectomy. The Matcher screen of the [debug UI](../../debug/README.md) takes the same JSON and shows how an answer came about. The synthetic journeys in [`patientdata/`](../../patientdata/patientdata.md) can be sent unchanged.

The same without a browser:

```sh
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http --method tools/list
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3000/mcp --transport http \
  --method tools/call --tool-name match_journey \
  --tool-args-json '{"journey":{"patient_id":"demo-1","events":[{"id":"e1","type":"progression","label":"PSA-Anstieg – Biochemisches Rezidiv","date":"2028-12-25"}]},"limit":3}'
```

## Tools

| Tool | Purpose |
|---|---|
| `match_journey` | Returns the sources most relevant to the most recent event of a patient journey. Takes either a `journey` or a `graph`, not both |
| `get_source` | Returns the links to the files of one matched source at its origin. The client downloads them itself |

Set `algorithm` to choose an approach. It defaults to `keyword`.

### `match_journey` input

| Field | Type | Required | Notes |
|---|---|---|---|
| `journey` | object | one of the two | The patient as a list of events, see below |
| `graph` | object | one of the two | The patient as the patient graph, see [graph input](#graph-input) |
| `algorithm` | `keyword`, `graph`, `ai_summary` | no | One approach; without it the server chooses, today `keyword` |
| `limit` | integer, 1 to 50 | no | Default 10 |
| `content_types` | list of `content_type` values, at least one, see [output](#match_journey-output) | no | Default: all types |

`journey` has the format of the generator's `timeline.json`, so a generated journey can be sent unchanged. The AIlixir app is expected to send its patient graph as `graph` instead. A request with both or with neither is rejected. Other fields, such as `pathway_id`, `start_date` and `documents`, are dropped.

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

### Graph input

`graph` is the [patient graph](#patient-graph) as JSON, in Graphiti's field names. A generated `graph.json` can be sent unchanged. The table lists the fields that the server reads. All other fields are dropped without a check, such as `patient`, `documents`, `summary` and `attributes`, and `name`, `fact` and `invalid_at` of an edge.

| Field | Type | Required | Notes |
|---|---|---|---|
| `as_of` | ISO date | no | The "now" of the patient, like `as_of` of a journey |
| `nodes` | list, at least 1 | yes | Exactly one node has the label `Patient` |
| `nodes[].uuid` | string | yes | Unique in the list |
| `nodes[].name` | string | yes | For the `Patient` node a pseudonym, never a real identifier |
| `nodes[].labels` | list of strings | yes | The type of the node, such as `Diagnosis` |
| `edges` | list, at least 1 | yes | |
| `edges[].uuid` | string | yes | Unique in the list |
| `edges[].source_node_uuid`, `edges[].target_node_uuid` | string | yes | Both nodes are in `nodes` |
| `edges[].valid_at` | ISO date or date-time, or `null` | no | The day the fact starts |

The server turns the graph into a journey and matches that, with the same rules as for a `journey`. How it does this is described in [reading a graph](#reading-a-graph). In the answer, `focus_event_id` is then the day of the most recent event, such as `2030-12-16`, because the events of this journey are days.

### `match_journey` output

| Field | Type | Required | Notes |
|---|---|---|---|
| `algorithm` | string | yes | The approach that produced the list |
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
| `content_type` | `journal_article`, `preprint`, `conference_paper`, `poster`, `presentation`, `report`, `book`, `video`, `podcast_episode` | yes | As stored, see [storage](../design/storage.md#documents) |
| `url` | URL | yes | Link to the original |
| `summary` | string | no | Abstract or description of the source, for the card in the app. Cut after 5,000 characters. Missing only if the source has none |
| `image_url` | URL | no | Picture for the card. So far only YouTube videos have one, their thumbnail |
| `published_date` | string | no | As precise as the source provides it |
| `authors` | list of strings | no | |
| `licence` | string | no | |
| `score` | number, 0 to 1 | no | Only comparable within one list, not between approaches |
| `matched_terms` | list of strings | no | Why this source matched |
| `explanation` | string | no | Reserved for a short text for the same purpose; not set yet |

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
| `downloads` | list | yes | In the order to try them, for example the HTML page of an arXiv paper before its PDF. At most 20; `url` leads to the rest. Entries whose URL is not `http` or `https` are left out. Empty if the source has no file, as for YouTube videos and PubMed records without a full text in PMC; then `url` is the only link |
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

## Patient graph

The patient graph is what the SS26 pipeline builds from a patient's documents with Graphiti: one `Patient` node, nodes for findings such as diagnoses, procedures and lab tests, and edges that hold one fact each with the times `valid_at` and `invalid_at`. The node and edge types are defined in [`medical_schema.py`](../../tools/patient-graph/workers/pipeline/graph/medical_schema.py); the [patient graph tool](../../tools/patient-graph/README.md) builds such a graph from the PDFs of a synthetic patient (`make graph`). The SS26 file export (`graph.cypher`) drops these times, so it cannot be the input; send the nodes and edges as JSON, as in a generated `graph.json` (`make graph`, see [build](../build-deploy/build.md#make-targets)).

### Reading a graph

[`graph.ts`](../../matcher/mcp-server/src/graph.ts) turns a [`graph`](#graph-input) into a journey:

- **Checked:** every node has `uuid`, `name` and `labels`; every edge has `uuid` and the IDs of its two nodes, and both nodes are in the graph; no two nodes and no two edges share a `uuid`; there is exactly one `Patient` node; `valid_at` is an ISO date or date-time, `null` or left out, and an empty string is rejected. A graph that fails a check is rejected with the place of the error.
- **Not checked:** fields the reader does not use, such as `name`, `fact` and `invalid_at` of an edge. They are dropped, because Graphiti takes the times of a fact from an LLM and one odd fact would otherwise reject the whole graph.
- **The day of a time** is the day as it is written: `2027-01-22T00:30:00+02:00` counts as 22 January.
- **One event per day:** the facts whose `valid_at` is that day. The event `id` is the date; its `label` lists the names of the nodes of these facts, each once, in alphabetical order and without the patient.
- **Left out:** facts without `valid_at`, facts about a `Provider`, and facts that name only the patient.
- **Replaced facts stay:** a fact with `invalid_at` still happened on its day.
- **The fact sentences are not passed on:** the matcher sees which concepts a day names, not their values or whether a finding was confirmed or ruled out.
- **`patient_id`** is the name of the `Patient` node.
- **The journey has to pass the contract** like any other: a graph without a dated fact or with facts on more than 500 days is rejected, and so is an `as_of` before the first event.

Every synthetic patient has a generated graph to try this with, e.g. [`patientdata/Patient-5/graph.json`](../../patientdata/Patient-5/graph.json).
