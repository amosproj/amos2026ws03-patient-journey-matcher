# Debug UI

Local web UI with one screen per step of the pipeline, the best way to explore what the crawler, the indexer, the transcription job and the MCP server do inside:

| Screen | Shows |
|---|---|
| **Runs** | Starts crawler runs and shows them live: source calls, retries, documents, citation graph and failures. "Store in the database" stores a run like `--store`; several topics are one run here, not one each, so a cited paper is kept with a term of any of them |
| **Database** | The stored documents, store runs and the schema of every table; a document also shows what the keyword index holds of it. Empties tables once you type the database name |
| **Index** | The [keyword index](../../Documentation/design/keyword-matching.md): per source, which full texts are done (indexed, or skipped: no usable full text, so at most the metadata is matched) and which the next run reads (failed, new or changed); why the skipped and failed ones have none, the most frequent keywords and what the journey terms find. Starts the indexer job like `make index`. Sets how many audio files the [transcription job](../../Documentation/design/keyword-matching.md#speech-to-text) reads at once and shows its workers |
| **Matcher** | `match_journey` for a synthetic journey, cut at any of its dates, with the steps of the match: how each event became search terms and which of them the query uses, the rank of each hit in both indexes, the part each index adds in rank fusion, and the terms found where. Other ranking constants can be tried without changing code. The **Example client** tab shows the answer as an app could: one card per source from the fields of `match_journey`, and its files from `get_source` |
| **Info** | Load, memory and disk of the machine; the timers of the VM with their next and last runs (live from systemd on the VM, from `deploy/vm-setup.sh` elsewhere); what runs right now; the topic files |

```sh
make debug             # then open http://127.0.0.1:8765
make debug PORT=9000   # on another port
```

API keys and `DATABASE_URL` come from `crawler/.env`. Finished crawler runs are kept in `debug/crawler/runs/` (gitignored).

The Index and Matcher screens run the matcher's own programs, so they need `make build`. The Matcher screen takes the arguments of `match_journey` as one JSON object, the same as "Edit as JSON" in the [MCP Inspector](../../Documentation/build-deploy/build.md#run-the-matcher-locally); its journey list puts one of `patientdata/*/timeline.json`, the example of the [MCP interface](../../Documentation/user/mcp-interface.md#try-it) or a file into them. It passes them on to the matcher and stores none. With "Through the MCP server" it sends them to the server of `make start` instead (on `MCP_PORT`, if set).
