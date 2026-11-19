# Glossary

| Term | Meaning |
|---|---|
| AIlixir | The industry partner. Its app is the planned client of the MCP server. |
| Patient journey | A patient's dated clinical events, such as diagnoses, operations and follow-ups. The `journey` input of `match_journey`. |
| Patient graph | The same history as nodes and edges, as the SS26 pipeline builds it with Graphiti. The `graph` input of `match_journey`. |
| Focus, context | The latest event up to `as_of` is the focus; the older events are the context. |
| Source | One paper, preprint, video or podcast episode that the server can return, identified by `source_id`. |
| Data source | Where sources come from: PubMed, arXiv, Zenodo, YouTube or a podcast feed. The `source` field of a result. |
| Document | The stored row of a source in the table `documents`. |
| Full text | The paper, transcript or audio behind a source. Read during indexing, never stored. |
| Approach | One way of matching, with its own index: keyword today; graph-based and AI-based are researched. The MCP parameter for it is called `algorithm`. |
| Index | What an approach derives from the documents, such as BM25 term statistics; never the full text itself. |
| MCP | Model Context Protocol: the protocol in which clients call the tools of the server. |
| SS26 | The AMOS project for AIlixir in the summer semester 2026. Its graph steps are kept in [`tools/patient-graph/`](../tools/patient-graph/README.md). |
