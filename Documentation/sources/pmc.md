# PubMed Central (PMC)

Checked 01.11.2026. Shared rules: [README](README.md).

Full-text route for [PubMed](pubmed.md) rows with a PMCID. No rows of its own; fills `licence`, `full_text` and `external_ids` of the PubMed row. Since 08.2026 one public S3 bucket with about 8 M article versions that allow text mining. FTP packages, `oa_comm`/`oa_noncomm` and the OA web service were removed in the week of 24.08.2026. Commercial and NC licences share the bucket, so check every article.

## Access

| Endpoint | Auth | Limit |
|---|---|---|
| S3 `https://pmc-oa-opendata.s3.amazonaws.com/` (`s3://pmc-oa-opendata`, us-east-1) | none | none published |
| ID Converter `https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=…&format=json&versions=yes` | `tool`, `email` | 200 IDs per request |
| `https://pmc.ncbi.nlm.nih.gov/articles/<PMCID>/` | none | User link only; automated download prohibited |

Automated retrieval only via S3, OAI-PMH, E-utilities (`db=pmc`) and BioC.

## Connectors

- **SS26:** ignores PMCID and licence; fetches publisher PDFs via the DOI.
- **crawler** `crawler/src/crawler/sources/pmc.py`: the two requests below for every PubMed record with a PMCID.

## Fields

The PubMed crawler makes two anonymous requests per PMCID:

1. `GET …/?list-type=2&prefix=PMC<n>.&delimiter=/` lists versions; none means not in the bucket.
2. `GET …/metadata/PMC<n>.<v>.json` (0.5–2 KB).

Several versions: prefer a non-manuscript with an allowed licence, then the highest number. v1 may be missing; higher is not always newer.

| Schema field | Source | Note |
|---|---|---|
| `external_ids.pmcid` | PubMed `ArticleId[@IdType="pmc"]` | Not from the reference list |
| `external_ids.pmc_version` | Listing or JSON `version` | Part of the S3 key |
| `external_ids.nihms` | JSON `mid` | Manuscripts |
| `licence` | JSON `license_code` | `CC BY-NC` → `CC-BY-NC` (PMC gives no version); `TDM` → `pmc-tdm`; `null` → empty |
| `full_text` | `PMC<n>.<v>/PMC<n>.<v>.xml`; MD5 from `?md5=` in JSON `xml_url` | JATS XML |
| `extra` | JSON `is_manuscript`, `is_retracted`, `is_historical_ocr` | |

The JSON has no authors, abstract or dates; those come from PubMed. `TDM` = author manuscript without CC licence, "available for text mining"; the AWS FAQ says these "are available for commercial reuse regardless of license".

## Indexing

1. Licence not allowed: skip.
2. `GET https://pmc-oa-opendata.s3.amazonaws.com/<key>`, no credentials. Served as `binary/octet-stream`; parse as UTF-8 JATS XML (60–275 KB).
3. Re-check `<license>`/`<ali:license_ref>`. Use `.txt` only as keyword fallback, never the PDF.
4. 404 is normal (not in the bucket yet, or version removed): retry next run.

## To be aware of

- Trust the JSON over search filters: `cc_by_license[filter]` missed a CC BY article.
- Edits change MD5 and `LastModified`, not the version. The JSON has no dates.
- Retractions and corrections are in the bucket (`article-type`).
- NLM terms: name NLM, no PMC logo.
- Not verified: S3 and ID Converter rate limits.

## Sources

- Bucket README: https://pmc-oa-opendata.s3.amazonaws.com/README.txt
- PMC on AWS: https://pmc.ncbi.nlm.nih.gov/tools/pmcaws/
- Licence groups: https://pmc.ncbi.nlm.nih.gov/tools/textmining/
- 2026 changes: https://ncbiinsights.ncbi.nlm.nih.gov/2026/02/12/pmc-article-dataset-distribution-services/
- ID Converter: https://pmc.ncbi.nlm.nih.gov/tools/id-converter-api/
