# Debug UI

Local web UI with one screen per step of the pipeline, the best way to explore what the crawler, the indexer, the transcription job and the MCP server do inside:

| Screen | Shows |
|---|---|
| **Runs** | Starts crawler runs and shows them live: source calls, retries, documents, citation graph and failures. "Store in the database" stores a run like `--store`; several topics are one run here, not one each, so a cited paper is kept with a term of any of them |
| **Database** | The stored documents, store runs and the schema of every table; a document also shows what the keyword index holds of it. Empties tables once you type the database name |
| **Index › Overview** | What every index shares: starts the indexer job like `make index` and shows its log; sets how many audio files the [transcription job](../Documentation/design/keyword-matching.md#speech-to-text) reads at once and shows its workers. Above them, how far the index of each approach is |
| **Index › Keyword** | The [keyword index](../Documentation/design/keyword-matching.md): per source, which full texts are done (fully indexed, or metadata only: no usable full text, so at most the metadata is matched) and which the next run reads (retry download, new or changed); why a document has no full text, the most frequent keywords and what the journey terms find. Starts the indexer job for this index only |
| **Index › Graph** | The [graph normalization](../Documentation/design/graph-normalization.md) of a patient graph (`patientdata/*/graph.json` of `make graph`) or of the PubTator3 annotations of a test paper: each entity with its shared ID, or hollow without one, the patient facts and relations with their status, and the cue and sentence it came from. Papers take a minimum score; a patient graph can also be shown as it is, to compare. The normalization needs no database; "Index graph" starts the indexer job for this index only |
| **Index › AI** | Starts and stops the local encoder; indexes Qwen, BGE-M3 or both, with model-specific coverage and progress |
| **Matcher** | `match_journey` for a synthetic journey, cut at any of its dates, with the steps of the match. For Keyword: how each event became search terms and which of them the query uses, the rank of each hit in both indexes, the part each index adds in rank fusion, and the terms found where; its ranking constants can be tried without changing code. For Graph, the patient query: the diagnoses that pick the candidate papers, the concepts that score them and the situation that re-ranks them. The **Example client** tab shows the answer as an app could: one card per source from the fields of `match_journey`, and its files from `get_source` |
| **Info** | Load, memory and disk of the machine; the timers of the VM with their next and last runs (live from systemd on the VM, from `deploy/vm-setup.sh` elsewhere); what runs right now; the topic files |

```sh
make debug             # then open http://127.0.0.1:8765
make debug PORT=9000   # on another port
```

API keys and `DATABASE_URL` come from `crawler/.env`. Finished crawler runs are kept in `debug/runs/` (gitignored).

A new screen is a block in `web/index.html` and a script of its own there; the page needs no build step.

The Index and Matcher screens run the matcher's own programs, so they need `make build`. The Matcher screen takes the arguments of `match_journey` as one JSON object, the same as "Edit as JSON" in the [MCP Inspector](../Documentation/build-deploy/build.md#run-the-matcher-locally). Choose a synthetic patient to load their timeline or, for Graph, their graph when available. You can also use the [MCP example](../Documentation/user/mcp-interface.md#try-it) or a local `timeline.json` or `graph.json` through "Import journey". The screen passes the request to the matcher and stores none. With "Through the MCP server" it sends the request to the server of `make start` (on `MCP_PORT`, if set).

For semantic matching, see [setup](../matcher/README.md#semantic-matching). With the AI algorithm, the Matcher takes Qwen or BGE-M3 as its model and the encoder of Index › AI; through MCP it uses the model the server was started with.
