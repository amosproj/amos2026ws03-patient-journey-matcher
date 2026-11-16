# AI-based Matching Research

**Goal:** investigate whether AI improves the relevance and usefulness of the resources returned for a patient journey


-> AI-based matching means that a trained model helps determine which resources fit a patient's current situation. 
This can involve:
- semantic similarity
- a direct relevance assessment 
- previously generated summaries


## 1. What changes compared with keyword and graph matching?

A patient with prostate cancer should receive resources that fit their situation. A paper on olaparib for breast cancer shares terms with their journey but may still be irrelevant.

| Approach | What is matching based on? | Expected strength | Typical weakness |
|---|---|---|---|
| Keyword / BM25 | Shared words | Fast, explainable and effective for exact technical terms | The same words can describe different medical contexts |
| Graph | Medical concepts and their relationships | Explicit links between disease, treatment and findings | Depends on complete and correct extraction |
| Embeddings | Learned semantic similarity between texts | Synonyms, different wording and potentially multiple languages | Topical similarity does not necessarily mean a match for the patient's situation |
| AI reranking | A model assesses the patient context and resource together | Can assess the specific fit more closely | Additional computation; incorrect assessments remain possible |

Hint: The categories overlap: graph generation can also use AI. 

## 2. AI-based approaches

### A. Semantic search with embeddings

An embedding model converts text into a numerical vector. Texts with similar meanings should be close to one another.

Proposed workflow:

1. Embed the title and abstract or description of each resource
2. Express the patient's situation as a search query: the current situation plus context that remains relevant
3. Embed this query as well
4. Find the most similar resources by comparing vectors

- Resource vectors are computed in advance
- For a new journey, the main task is to generate its query vector
- use same compatible retrieval model for Query and resource encoders 
- respect model-specific input formats must be respected

Be careful: An embedding may also consider “no metastases” and “metastases” too similar. Negation, changes over time and treatment phase need dedicated test cases.

### B. Reranking a shortlist

First, BM25 or embedding search returns, for example, 50 candidates. A model then assesses each one:

> How well does this resource fit this patient's situation?

Specialized rerankers return a relevance score, while generative LLMs can also produce an explanation.

Compare: **BM25 versus BM25 plus a reranker**

Be careful: a reranker cannot recover a relevant source missing from the shortlist

### C. Matching through AI summaries

An LLM creates a compact representation of each resource's relevant content. The actual matching then uses, for example, embeddings or a reranker.

Here, summarization is a preprocessing step, not yet a complete matching algorithm.

### D. Hybrid

BM25 and embeddings search in parallel, and their result lists are merged. A reranker can optionally follow.

This fits the existing use of Reciprocal Rank Fusion: exact terms and semantic similarity can complement each other. The comparison must establish whether this helps with our journeys.

## 3. Model comparison

| Task | Candidates | Why are they relevant to the project? |
|---|---|---|
| Multilingual embeddings | BGE-M3 | Supports multilingual and cross-language search; relevant for German journeys and English sources |
| Embeddings and reranking | Qwen3-Embedding-0.6B, Qwen3-Reranker-0.6B | Small variants as a starting point for self-hosted retrieval and reranking |
| Biomedical retrieval | MedCPT | Specifically designed for biomedical literature search; includes retrieval and reranking |
| Summarization through an API | A model from the Gemini family | Builds on the project's documented use of Gemini; select the specific version based on quality, price and availability |
| Self-hosted summarization | For example, Qwen3-8B | A comparison candidate with available weights; requires our own deployment and hardware |

Sources: [BGE-M3 paper](https://arxiv.org/abs/2402.03216), [Qwen3-Embedding paper](https://arxiv.org/abs/2506.05176), [MedCPT code and models](https://github.com/ncbi/MedCPT), [Gemini model overview](https://ai.google.dev/gemini-api/docs/models), [Qwen3-8B model card](https://huggingface.co/Qwen/Qwen3-8B).

For MedCPT, we need to examine how German journeys should be prepared: biomedical specialization does not establish strong German-to-English retrieval performance. Translation would be an additional processing step that the experiment would need to account for.
-> so maybe the first prototype should use existing models. 

## 4. Role of summarization

There are three possible stages:

| Stage | What is summarized? | Purpose |
|---|---|---|
| During indexing | Paper, abstract or transcript | Represent the resource compactly for later retrieval |
| Before matching | Patient journey up to `as_of` | Highlight the current situation and history that remains relevant |
| After matching | Selected results | Explain clearly what the resource covers and why it might be relevant |

### Summarizing resources

We propose a structured summary for matching. Possible fields:

- Disease and study population
- Stage or treatment setting
- Intervention and comparator
- Main results
- Limitations and uncertainties
- Supporting source passages, where storage and usage terms permit

Rules: 
Negative study results must be preserved. “Treatment investigated” must not become “treatment effective.” Missing information remains unknown. If only an abstract or description is available, the summary must not imply knowledge of the full text.

Papers already have abstracts. A central research question is therefore:

> Does an additional AI summary improve matching compared with the title and abstract at all?

### Summarizing the patient journey

A journey summary could bring together current treatment, relevant previous procedures, trends in findings and negations. It must only use information known up to `as_of`.

For an initial comparison, the query text is generated from the existing structured events using rules. We can then test specifically whether an LLM summary provides an additional benefit.

### Summarizing results for patients

A summary can improve comprehensibility without automatically improving match quality. Ranking relevance and presentation usefulness are therefore evaluated separately. Displayed claims must remain supported by the respective source, and the original source remains linked.

