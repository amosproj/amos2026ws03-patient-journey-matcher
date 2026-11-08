# MCP interface

Version 0.1, a proposal for #7. It is not yet confirmed by AIlixir, see [Open questions](#open-questions). The schemas in [`matcher/mcp-server/src/contract.ts`](../matcher/mcp-server/src/contract.ts) are the source of truth for field names and limits. `match_journey` works with the `keyword` algorithm ([keyword matching](keyword-matching.md)); the other algorithms and `get_source` answer with the error code `NOT_AVAILABLE`.

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
| `DATABASE_URL` | none, required | The database with `documents` and the indexes; `make start` sets it from the root `.env` |

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
| `content_types` | list of `content_type` values, see [output](#match_journey-output) | no | Default: all types |

`journey` has the format of the generator's `timeline.json`, so a generated journey can be sent unchanged. Other fields, such as `pathway_id`, `start_date` and `documents`, are dropped.

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

## Check against AIlixir's integration needs

| Need | Basis | Status |
|---|---|---|
| Show a list of sources | `PaperReference` in the SS26 code (`title`, `source`, `source_type`, `published_date`, `url`) | Same field names, except `content_type` instead of `source_type`. `url` is required here because we store only links to the originals |
| Tell "nothing relevant" from "search failed" | `degraded` and `degraded_reason` in the SS26 `PaperRetrievalResult` | Same field names |
| Send generated journeys | Generator `timeline.json` | Checked with one generated journey for each of the 10 pathways |
| Send journeys of the real app | Unknown | Open |

## Open questions

For AIlixir:

1. Which journey format does the real app send, and does it fit `timeline.json`?
2. May `get_source` return abstracts and full texts to the app, depending on the licence of the source?
3. How does the AIlixir backend connect to the server, and how does it authenticate?
4. Does the app need an `error_code` for invalid input too, or is the plain text enough?

For the team:

5. Is `keyword` the right default until the evaluation in #11 has results?
