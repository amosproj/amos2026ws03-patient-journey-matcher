import json
import urllib.request
from email.message import Message
from typing import Any
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

from crawler.models import FullTextLocator
from crawler.sources import openalex
from crawler.sources.openalex import OpenAlexClient, openalex_licence


def location(pdf_url: str | None, *, is_oa: bool = True, license: str | None = None) -> Any:
    return {
        "is_oa": is_oa,
        "pdf_url": pdf_url,
        "landing_page_url": "https://doi.org/x",
        "license": license,
        "version": "publishedVersion",
    }


def work(doi: str, *locations: Any, best: Any = None) -> dict[str, Any]:
    """Shaped like a result of `GET /works?filter=doi:…` with `select=_FIELDS`."""
    return {
        "id": "https://openalex.org/W123",
        "doi": f"https://doi.org/{doi}",
        "best_oa_location": best,
        "locations": list(locations),
    }


class FakeApi:
    def __init__(self, works: list[dict[str, Any]], error: int | None = None) -> None:
        self.works = {work["doi"].removeprefix("https://doi.org/"): work for work in works}
        self.error = error
        self.queries: list[dict[str, list[str]]] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> bytes:
        query = parse_qs(urlsplit(request.full_url).query)
        self.queries.append(query)
        if self.error is not None:
            raise HTTPError(request.full_url, self.error, "error", Message(), None)
        dois = query["filter"][0].removeprefix("doi:").split("|")
        found = [self.works[doi] for doi in dois if doi in self.works]
        return json.dumps({"meta": {"count": len(found)}, "results": found}).encode()


def client(api: FakeApi, **options: Any) -> OpenAlexClient:
    return OpenAlexClient(fetch=api, sleep=lambda _seconds: None, **options)


def test_keeps_the_direct_pdf_links_of_open_copies_best_first() -> None:
    mdpi = "https://www.mdpi.com/1422-0067/23/22/14257/pdf"
    repository = "https://repository.example.org/14257.pdf"
    api = FakeApi(
        [
            work(
                "10.3390/ijms232214257",
                location(mdpi, license="cc-by"),
                location(None, license="cc-by"),  # PMC landing page only
                location("https://closed.example.org/a.pdf", is_oa=False),
                location(repository, license="cc-by-sa"),
                best=location(mdpi, license="cc-by"),
            )
        ]
    )

    copies = client(api).open_access(["https://doi.org/10.3390/IJMS232214257"])

    copy = copies["10.3390/ijms232214257"]
    assert copy.full_text == [
        FullTextLocator(kind="pdf", url=mdpi, media_type="application/pdf"),
        FullTextLocator(kind="pdf", url=repository, media_type="application/pdf"),
    ]
    assert copy.licence == "CC-BY"
    assert copy.openalex_id == "W123"


def test_leaves_out_papers_without_an_open_pdf() -> None:
    api = FakeApi(
        [
            work("10.1/closed", location("https://x.org/a.pdf", is_oa=False)),
            work("10.1/landing", location(None)),
        ]
    )

    assert client(api).open_access(["10.1/closed", "10.1/landing", "10.1/unknown"]) == {}


def test_asks_in_batches_once_per_doi_and_skips_dois_a_filter_cannot_hold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(openalex, "BATCH_SIZE", 2)
    api = FakeApi([])

    client(api).open_access(["10.1/a", "10.1/A", "10.1/b", "10.1/c", "10.1/x|y", "10.1/x,y", ""])

    assert [query["filter"] for query in api.queries] == [["doi:10.1/a|10.1/b"], ["doi:10.1/c"]]
    assert all("api_key" not in query for query in api.queries)


def test_sends_the_api_key_if_there_is_one() -> None:
    api = FakeApi([])

    client(api, api_key="SECRET").open_access(["10.1/a"])

    assert api.queries[0]["api_key"] == ["SECRET"]


def test_asks_nothing_for_no_dois() -> None:
    api = FakeApi([])

    assert client(api).open_access([]) == {}
    assert api.queries == []


def test_raises_http_errors_for_the_caller_to_decide() -> None:
    with pytest.raises(HTTPError):
        client(FakeApi([], error=429)).open_access(["10.1/a"])


def test_keeps_at_most_three_links() -> None:
    links = [location(f"https://mirror{n}.example.org/a.pdf") for n in range(5)]

    copy = client(FakeApi([work("10.1/a", *links)])).open_access(["10.1/a"])["10.1/a"]

    assert len(copy.full_text) == 3


@pytest.mark.parametrize(
    ("code", "licence"),
    [
        ("cc-by", "CC-BY"),
        ("cc-by-nc-nd", "CC-BY-NC-ND"),
        ("cc0", "CC0-1.0"),
        ("publisher-specific-oa", None),
        ("other-oa", None),
        (None, None),
    ],
)
def test_openalex_licence(code: str | None, licence: str | None) -> None:
    assert openalex_licence(code) == licence
