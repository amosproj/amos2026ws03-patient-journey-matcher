# Models used in the matching comparison

[Simple report](ai-matching-report.pdf) · [Detailed report](detailed/ai-matching-report-detailed.pdf)

## Matching approaches

| Approach | Exact model(s) or method | What was run |
|---|---|---|
| Keyword reference (B0) | BM25Okapi, `rank-bm25` 0.2.2; no AI model | Keyword ranking of the resource text. |
| Qwen semantic search (D1) | `Qwen/Qwen3-Embedding-0.6B` | Embed the query and resources with this model, then compare normalized vectors. |
| BGE-M3 semantic search (D2) | `BAAI/bge-m3` | Same retrieval task, using dense embeddings only. Its sparse and multi-vector modes were not used. |
| Keyword + AI reranking (R1) | BM25Okapi → `Qwen/Qwen3-Reranker-0.6B` | Retrieve up to 50 keyword candidates, then score each query/resource pair with the reranker. |
| Hybrid search (H1) | BM25Okapi + `Qwen/Qwen3-Embedding-0.6B` | Merge the two top-50 lists with equal reciprocal-rank weights; keep 50 candidates. No reranker. |
| Hybrid + AI reranking (H2) | BM25Okapi + `Qwen/Qwen3-Embedding-0.6B` → `Qwen/Qwen3-Reranker-0.6B` | Use the same hybrid shortlist, then score its query/resource pairs with the same reranker as R1. |

Both embedding models encoded the journey query and each resource's title,
abstract and subjects. Qwen queries included a matching-task instruction.
Qwen embeddings used last-token pooling; BGE-M3 used its dense CLS representation.
Both produced normalized 1,024-dimensional vectors. Reranking used the Qwen
reranker's documented yes/no pair scoring, rather than general chat generation.
The final comparison evaluated the top ten results from each approach.

## Summary readiness check

**`Qwen/Qwen3-0.6B`** generated the resource and journey summaries. This is a
separate text-generation checkpoint, not the embedding model or reranker.
Generation used non-thinking mode, greedy decoding and at most 256 new tokens.
The larger `Qwen/Qwen3-8B` was not run on the 8 GB machine. No Gemini model,
MedCPT model or hosted inference API was used. Summary effects on ranking were
not measured.

## Exact checkpoint revisions

The original run pinned these model repository commits. These identifiers
describe the measured run; they are not recommendations to follow a moving
model version.

| Role | Model repository | Pinned revision |
|---|---|---|
| Semantic search | [Qwen/Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) | `97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3` |
| Semantic search | [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3) | `5617a9f61b028005a4858fdac845db406aefb181` |
| Pair reranking | [Qwen/Qwen3-Reranker-0.6B](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B) | `e61197ed45024b0ed8a2d74b80b4d909f1255473` |
| Summary generation | [Qwen/Qwen3-0.6B](https://huggingface.co/Qwen/Qwen3-0.6B) | `c1899de289a04d12100db370d81485cdf75e47ca` |

These are exploratory results on synthetic examples and draft labels. The
keyword reference is not a reproduction of the current application matcher.
The [detailed PDF](detailed/ai-matching-report-detailed.pdf) retains the original
analysis and limitations, plus an exact-model appendix and the figures in [`detailed/figures/`](detailed/figures/); the simple PDF
omits those figures.
