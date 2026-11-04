import json
import urllib.request
from datetime import date
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from pydantic import ValidationError

from crawler.models import ScrapeRequest, SourceName, SourceType
from crawler.sources.zenodo import ZenodoScraper


def record(
    record_id: str, resource_type: str = "publication-article", **metadata: Any
) -> dict[str, Any]:
    """Shaped like a hit of the InvenioRDM search API (application/vnd.inveniordm.v1+json)."""
    return {
        "id": record_id,
        "parent": {
            "id": f"{record_id}0",
            "pids": {"doi": {"identifier": f"10.5281/zenodo.{record_id}0"}},
        },
        "pids": {"doi": {"identifier": f"10.5281/ZENODO.{record_id}", "provider": "datacite"}},
        "links": {"self_html": f"https://zenodo.org/records/{record_id}"},
        "custom_fields": {
            "journal:journal": {"title": "International Journal of Clinical Research"}
        },
        "metadata": {
            "title": " Serum phosphorus in prostate cancer ",
            "resource_type": {"id": resource_type, "title": {"en": "Journal article"}},
            "publication_date": "2022-08-31",
            "creators": [
                {"person_or_org": {"type": "personal", "name": "Rakhi Pareek"}},
                {"person_or_org": {"type": "organizational", "name": "Study Group"}},
                {"person_or_org": {"name": ""}},
            ],
            "description": (
                "<p><strong>Background:&nbsp;</strong>Prostate cancer is common.</p>"
                "<p>Results &amp; outlook</p>"
            ),
            "subjects": [
                {"subject": "Prostatic Neoplasms", "id": "mesh:D011471"},
                {"subject": "Calcium"},
                {"subject": "Calcium"},
            ],
            **metadata,
        },
    }


class FakeZenodo:
    def __init__(self, pages: list[list[dict[str, Any]]]) -> None:
        self.pages = pages
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> bytes:
        self.requests.append(request)
        page = int(parse_qs(urlparse(request.full_url).query)["page"][0])
        hits = self.pages[page - 1] if page <= len(self.pages) else []
        return json.dumps({"hits": {"hits": hits, "total": 9999}}).encode()

    def parameters(self, index: int) -> dict[str, str]:
        return {
            key: values[0]
            for key, values in parse_qs(urlparse(self.requests[index].full_url).query).items()
        }


def no_sleep(_seconds: float) -> None:
    pass


def search(query: str = "prostate cancer", **arguments: Any) -> ScrapeRequest:
    return ScrapeRequest(source=SourceName.ZENODO, query=query, **arguments)


def test_parse_record_uses_the_concept_id_and_keeps_the_version() -> None:
    document = ZenodoScraper.parse_record(record("13363178"))

    assert document.id == "zenodo:133631780"
    assert document.source_id == "133631780"
    assert document.version == "13363178"
    assert document.source is SourceName.ZENODO
    assert document.source_type is SourceType.PAPER
    assert document.content_type == "journal_article"
    assert document.url == "https://zenodo.org/records/13363178"
    assert document.title == "Serum phosphorus in prostate cancer"
    assert document.authors == ["Rakhi Pareek", "Study Group"]
    assert document.description == "Background: Prostate cancer is common.\nResults & outlook"
    assert document.abstract is None
    assert document.keywords == ["Prostatic Neoplasms", "Calcium"]
    assert document.doi == "10.5281/zenodo.13363178"
    assert document.journal == "International Journal of Clinical Research"
    assert document.published_on == date(2022, 8, 31)


def test_videos_are_videos() -> None:
    document = ZenodoScraper.parse_record(record("1", resource_type="video"))

    assert document.source_type is SourceType.VIDEO
    assert document.content_type == "video"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2026", "2026"),
        ("2026-09", "2026-09"),
        ("2020/2021", "2020"),
        ("2020-01-15/2020-06-30", "2020-01-15"),
        ("2026?", "2026"),
        ("2026-13", None),
        ("spring 2026", None),
        (None, None),
    ],
)
def test_publication_dates_follow_edtf_without_failing_the_search(
    value: str | None, expected: str | None
) -> None:
    document = ZenodoScraper.parse_record(record("1", publication_date=value))

    assert document.published_at == expected


def test_queries_join_terms_with_and_and_keep_only_useful_types() -> None:
    query = ZenodoScraper.build_query('prostate "cancer" biopsy', "and", date(2026, 1, 2))

    assert query.startswith(
        '("prostate" AND "cancer" AND "biopsy") AND metadata.resource_type.id:('
    )
    assert "publication-preprint OR " in query and "dataset" not in query
    assert query.endswith(" AND metadata.publication_date:[2026-01-02 TO *]")
    assert ZenodoScraper.build_query("a b", "or", None).startswith('("a" OR "b") AND')
    assert ZenodoScraper.build_query("metadata.title:prostate", "raw", None).startswith(
        "(metadata.title:prostate) AND"
    )


def test_search_pages_through_results_with_at_most_25_per_page() -> None:
    api = FakeZenodo([[record(str(n)) for n in range(25)], [record(str(n)) for n in range(25, 50)]])
    scraper = ZenodoScraper(fetch=api, sleep=no_sleep)

    documents = scraper.scrape(search(max_results=30))

    assert len(documents) == 30
    assert [api.parameters(i)["page"] for i in range(len(api.requests))] == ["1", "2"]
    assert {api.parameters(i)["size"] for i in range(len(api.requests))} == {"25"}
    assert api.parameters(0)["sort"] == "bestmatch"
    assert api.requests[0].get_header("User-agent", "").startswith("patient-journey-matcher")
    assert api.requests[0].get_header("Accept") == "application/vnd.inveniordm.v1+json"


def test_search_stops_when_zenodo_has_no_more_results() -> None:
    api = FakeZenodo([[record("1"), record("2"), {"metadata": {}}]])

    documents = ZenodoScraper(fetch=api, sleep=no_sleep).scrape(
        search(max_results=10, since=date(2026, 1, 1))
    )

    assert [document.version for document in documents] == ["1", "2"]
    assert len(api.requests) == 1
    assert api.parameters(0)["size"] == "10"
    assert api.parameters(0)["sort"] == "newest"


def test_searches_are_at_least_two_seconds_apart() -> None:
    sleeps: list[float] = []
    api = FakeZenodo([[record(str(n)) for n in range(25)]] * 3)

    ZenodoScraper(fetch=api, sleep=sleeps.append, clock=lambda: 100.0).scrape(
        search(max_results=75)
    )

    assert sleeps == [2.0, 2.0]


def test_zenodo_requests_take_a_query_only() -> None:
    with pytest.raises(ValidationError, match="Zenodo requests take a query only"):
        ScrapeRequest(source=SourceName.ZENODO, ids=["123"])
