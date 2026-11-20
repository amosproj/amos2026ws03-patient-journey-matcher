PubTator3 annotations of three PubMed papers, from `https://www.ncbi.nlm.nih.gov/research/pubtator3-api/publications/export/biocjson?pmids=<pmid>` on 20.11.2026. Trimmed to what the normalization reads: the type, identifier and name of each annotation and relation role, the mention text, and the relation type and score. The passage text (title and abstract) is left out.

| PMID     | Paper                                                        | Why                                                                                      |
| -------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| 32343890 | Olaparib for metastatic castration-resistant prostate cancer | `treat`, `cause`, `Cotreatment`, `Comparison`, `olaparib treat Death`                    |
| 30345884 | Olaparib in ovarian cancer                                   | the same drug for another disease; a gene annotated as `672;675`                         |
| 35923949 | Degarelix vs. leuprorelin in prostate cancer                 | names leuprorelin, which PubTator3 does not annotate; annotates "PSA" as the gene NPEPPS |
