# MCP interface

Version 0.2 for #7, reviewed with AIlixir in the partner meeting on 06.11.2026, see [Review with AIlixir](#review-with-ailixir). The schemas in [`matcher/mcp-server/src/contract.ts`](../matcher/mcp-server/src/contract.ts) are the source of truth for field names and limits. No matcher exists yet, so both tools currently answer with the error code `NOT_AVAILABLE`.

All fields use `snake_case`, like the journey generator and the SS26 retrieval code.

## Connection

The server speaks MCP over Streamable HTTP at `POST /mcp`. It listens on `127.0.0.1` only, because it has no authentication yet. It keeps no sessions.

```sh
cd matcher
pnpm --filter @matcher/mcp-server start
```

| Environment variable | Default | Meaning |
|---|---|---|
| `MCP_PORT` | `3000` | Port of the server |

## Tools

| Tool | Purpose |
|---|---|
| `match_journey` | Returns the sources most relevant to the most recent event of a patient journey |
| `get_source` | Downloads one matched source again from its origin and returns its content without storing it |

To compare the three algorithms, a client calls `match_journey` once per algorithm with the same journey.

### `match_journey` input

| Field | Type | Required | Notes |
|---|---|---|---|
| `journey` | object | yes | See below |
| `algorithm` | `keyword`, `graph`, `ai_summary` | no | Default `keyword` |
| `limit` | integer, 1 to 50 | no | Default 10 |
| `source_types` | list of `paper`, `preprint`, `video`, `podcast` | no | Default: all types |

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
| `source_type` | `paper`, `preprint`, `video`, `podcast` | yes | |
| `url` | URL | yes | Link to the original |
| `summary` | string | no | Short summary, abstract or description for the card in the app. Missing only if the source has none |
| `image_url` | URL | no | Picture for the card, for example a video thumbnail |
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
      "source_type": "paper",
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

The input is `{ "source_id": "pubmed:42745507" }`. The output holds the fields of the source reference plus:

| Field | Type | Required | Notes |
|---|---|---|---|
| `content` | string | yes | Kept in memory only |
| `content_kind` | `abstract`, `full_text`, `transcript` | yes | |
| `fetched_at` | ISO date-time | yes | |

## Errors

Failures inside a tool return an MCP result with `isError: true` and this text:

```json
{ "error_code": "SOURCE_NOT_FOUND", "message": "Unknown source pubmed:1." }
```

| Code | Meaning |
|---|---|
| `NOT_AVAILABLE` | The requested algorithm or store is not available |
| `SOURCE_NOT_FOUND` | `get_source` got an unknown ID |
| `UPSTREAM_UNAVAILABLE` | The origin of a source could not be reached |
| `INTERNAL_ERROR` | An unexpected failure. The result always has the same message, without any details |

The SDK checks the input before a tool runs and the output after it. When a check fails, the result has `isError: true`, but its text is a plain sentence, such as `Input validation error: ...`, without an `error_code`. A client must not parse every error text as JSON.

## Health data

The server does not store or log the journey. It also does not log the message of an unexpected failure, because the message can contain journey data. Development uses synthetic journeys only.

## Review with AIlixir

Results of the partner meeting on 06.11.2026:

- **Matching runs offline, not live.** AIlixir calls `match_journey` when a patient profile changes, for example when a new report comes in, or on a schedule. The tools keep no state, so this needs no change here.
- **Input is the whole patient graph.** AIlixir will send the complete patient profile graph with entities, relationships and history, not `timeline.json`. Older events can stay relevant depending on the medical context and trends over time. The graph format follows from AIlixir's example data in #44. Until then `timeline.json` stays the input for generated journeys and tests.
- **Output is a card.** Each result needs at least a title, a link and a short summary or abstract, and a picture if possible. That is why `summary` and `image_url` were added.

## Check against AIlixir's integration needs

| Need | Basis | Status |
|---|---|---|
| Show a list of sources | `PaperReference` in the SS26 code (`title`, `source`, `source_type`, `published_date`, `url`) | Same field names. `url` is required here because we store only links to the originals |
| Show a card in the "For you" section | Partner meeting 06.11. | `title`, `url`, `summary` and `image_url` |
| Tell "nothing relevant" from "search failed" | `degraded` and `degraded_reason` in the SS26 `PaperRetrievalResult` | Same field names |
| Match when the profile changes, not live | Partner meeting 06.11. | No state in the server, AIlixir decides when to call |
| Send generated journeys | Generator `timeline.json` | Checked with one generated journey for each of the 10 pathways |
| Send journeys of the real app | Partner meeting 06.11.: the whole patient graph | Format follows in #44 with AIlixir's example data |

## Open questions

For AIlixir:

1. Which graph format does the app send, and does its export keep the event dates? Without dates there is no most recent event (#44).
2. May `get_source` return abstracts and full texts to the app, depending on the licence of the source?
3. Does the app need an `error_code` for invalid input too, or is the plain text enough?

For the team:

4. How does the AIlixir backend reach the server, and how does it authenticate? We decide this with the deployment (#42).
5. Is `keyword` the right default until the evaluation in #11 has results?
