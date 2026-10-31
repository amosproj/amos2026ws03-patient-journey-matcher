from typing import Any

from scraper.models import SourceName
from scraper.sources.pubmed import PubMedScraper


class EntrezValue(str):
    def __new__(cls, value: str, **attributes: str) -> "EntrezValue":
        instance = super().__new__(cls, value)
        instance.attributes = attributes
        return instance

    attributes: dict[str, str]


def test_contact_email_is_optional_for_low_volume_requests() -> None:
    PubMedScraper()


def test_parse_article_preserves_structured_abstract_and_group_authors() -> None:
    record: dict[str, Any] = {
        "MedlineCitation": {
            "PMID": "4242",
            "Article": {
                "ArticleTitle": "A useful result.",
                "Abstract": {
                    "AbstractText": [
                        EntrezValue("How the study was run", Label="METHODS"),
                        EntrezValue("What the study found", Label="RESULTS"),
                    ]
                },
                "AuthorList": [
                    {"ForeName": "Ada", "LastName": "Lovelace"},
                    {"CollectiveName": "Study Group"},
                ],
                "ArticleDate": [{"Year": "2026", "Month": "10", "Day": "31"}],
                "Journal": {"Title": "Medical Journal", "JournalIssue": {}},
            },
            "MeshHeadingList": [
                {
                    "DescriptorName": "Prostatic Neoplasms",
                    "QualifierName": ["therapy"],
                }
            ],
            "KeywordList": [["Patient Education"]],
        },
        "PubmedData": {
            "ArticleIdList": [
                EntrezValue("4242", IdType="pubmed"),
                EntrezValue("10.1000/example", IdType="doi"),
            ]
        },
    }

    document = PubMedScraper.parse_article(record, ["prostate", "cancer"])

    assert document.id == "pubmed:4242"
    assert document.source is SourceName.PUBMED
    assert document.title == "A useful result"
    assert document.abstract == ("METHODS: How the study was run\nRESULTS: What the study found")
    assert document.authors == ["Ada Lovelace", "Study Group"]
    assert document.published_at == "2026-10-31"
    assert document.doi == "10.1000/example"
    assert document.keywords == ["Patient Education", "Prostatic Neoplasms", "therapy"]


def test_parse_article_supports_medline_year_only_dates() -> None:
    article = {"Journal": {"JournalIssue": {"PubDate": {"MedlineDate": "2024 Winter"}}}}
    assert PubMedScraper._publication_date(article) == "2024"
