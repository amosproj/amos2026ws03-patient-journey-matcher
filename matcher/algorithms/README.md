# Matching approaches

Each approach (keyword #8, AI summary #9, graph #10) is a plug-in: one package under `matcher/algorithms/<name>/`. The MCP server and the indexer job know the approaches only through the list in [`@matcher/approaches`](../approaches/src/registry.ts), so they are interchangeable: `match_journey` picks one by its `algorithm`, and `make index APPROACHES=<name>` indexes only the named ones.

## Layout

The keyword approach as the example:

| File                 | Content                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `package.json`       | `@matcher/<name>`                                                                                        |
| `src/approach.ts`    | `create<Name>Approach(dependencies)`: the `Approach` with its name, indexer and matcher; the only export |
| `src/indexer.ts`     | The `Indexer`: brings the approach's index up to date                                                    |
| `src/matcher.ts`     | The `Matcher`: ranks the indexed documents for a journey                                                 |
| `src/schema.ts`      | Its tables, in a schema named after the approach                                                         |
| `src/<name>.test.ts` | Its database tests                                                                                       |

Other files hold what only this approach needs, e.g. keyword's word lists in `data/` and the script that builds one in `scripts/`.

## Contracts

From [`@matcher/core`](../core/src/contracts.ts):

| Contract                         | Meaning                                                                                  |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `Approach`                       | `name` (its `algorithm` value), `indexer`, `matcher`                                     |
| `Indexer.index(log)`             | Indexes the new and changed documents; `log` gets progress lines                         |
| `Matcher.match(state, options)`  | The best hits for a `JourneyState`, best first; `score` from 0 to 1 relative to the best |
| `reciprocalRankFusion(rankings)` | Merges rankings whose scores are not comparable, e.g. two indexes or two approaches      |

The options of `match` also hold `trace` and `tuning`, for the [debug UI](../../debug/crawler/README.md): `trace(step, data)` gets what the matcher works out on the way, `tuning` other values for its ranking constants. A matcher that ignores both still works there.

## Shared parts

| Need                                | Use                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Index the new and changed documents | `indexChangedDocuments(db, "<schema>.<table>", index)` from `@matcher/db`. The table has `document_id` (references `documents (id)` with `ON DELETE CASCADE`) and `document_changed_at` |
| Full text                           | `downloader.fullText(document.full_text)` from [`@matcher/download`](../download/src/downloader.ts). All approaches share one downloader, so the request budgets per host hold          |
| Text when there is no full text     | `metadataText(document)` from `@matcher/db`: title, abstract, subjects                                                                                                                  |
| The journey                         | `JourneyState` (focus and context) from `@matcher/core`; the server builds it once for every matcher ([`journey.ts`](../mcp-server/src/journey.ts))                                     |
| Database tests                      | `createTestDatabase()` from `@matcher/db/testing`: a database per test file                                                                                                             |

## Rules

- An approach writes only its own schema and creates it itself (`CREATE … IF NOT EXISTS`, safe to run again).
- Indexes hold derived data only, never a full text ([sources §5](../../Documentation/sources/README.md#5-storage-limits-and-retention)).
- Each approach sets and documents its own licence rules ([sources §3](../../Documentation/sources/README.md#3-indexing)).
- Index rows reference their document, so a deleted document (YouTube after 30 days) leaves every index.
- A matcher only reads and returns document IDs; the server adds the metadata and links.
- A journey is health data: never stored or logged. Sending it to an outside service, e.g. for embeddings, needs a team decision ([open points](../../Documentation/architecture/README.md#5-open-points)).

## Add an approach

1. Create the package with the layout above; implement `Indexer` and `Matcher`. Its name must be one of the `algorithm` values in [`contract.ts`](../mcp-server/src/contract.ts) (`keyword`, `graph`, `ai_summary`).
2. Add it to `createApproaches` in [`approaches/src/registry.ts`](../approaches/src/registry.ts); add new dependencies, such as an LLM client, to `Dependencies`.
3. Run `pnpm install`, then document the approach next to [keyword matching](../../Documentation/keyword-matching.md).

The MCP server and the indexer job need no change.
