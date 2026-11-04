from typing import Any

from crawler.models import ScrapeRequest, SourceName
from crawler.sources.pubmed import PubMedScraper, is_pmid


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

    document = PubMedScraper.parse_article(record)

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


def minimal_article(pmid: str) -> dict[str, Any]:
    return {
        "MedlineCitation": {
            "PMID": pmid,
            "Article": {"ArticleTitle": f"Article {pmid}.", "Journal": {"JournalIssue": {}}},
        },
        "PubmedData": {"ArticleIdList": []},
    }


class FakeHandle:
    def __init__(self, payload: Any) -> None:
        self.payload = payload

    def close(self) -> None:
        pass


class FakeEntrez:
    def __init__(self, search_ids: list[str]) -> None:
        self.search_ids = search_ids
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.max_tries = 3

    def esearch(self, **arguments: Any) -> FakeHandle:
        self.calls.append(("esearch", arguments))
        return FakeHandle({"IdList": self.search_ids})

    def efetch(self, **arguments: Any) -> FakeHandle:
        self.calls.append(("efetch", arguments))
        ids = arguments["id"].split(",")
        return FakeHandle({"PubmedArticle": [minimal_article(pmid) for pmid in ids]})

    def read(self, handle: FakeHandle) -> Any:
        return handle.payload


def test_search_fetches_the_found_ids() -> None:
    entrez = FakeEntrez(["1", "2"])
    scraper = PubMedScraper(entrez=entrez)

    documents = scraper.scrape(ScrapeRequest(source=SourceName.PUBMED, query="prostate cancer"))

    assert [call for call, _ in entrez.calls] == ["esearch", "efetch"]
    assert [document.id for document in documents] == ["pubmed:1", "pubmed:2"]
    assert all(document.found_by == [] for document in documents)


def test_lookup_skips_the_search_and_fetches_in_batches_of_200() -> None:
    entrez = FakeEntrez([])
    scraper = PubMedScraper(entrez=entrez)
    ids = [str(number) for number in range(1, 451)]

    documents = scraper.scrape(ScrapeRequest(source=SourceName.PUBMED, ids=ids))

    assert [call for call, _ in entrez.calls] == ["efetch", "efetch", "efetch"]
    assert [len(arguments["id"].split(",")) for _, arguments in entrez.calls] == [200, 200, 50]
    assert len(documents) == 450


def test_pmid_validation() -> None:
    assert is_pmid("41000123")
    assert not is_pmid("0123")
    assert not is_pmid("PMC123")
    assert not is_pmid("")
