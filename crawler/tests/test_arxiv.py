import urllib.request
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from email.message import Message
from http.client import IncompleteRead
from types import SimpleNamespace
from typing import Any
from urllib.error import HTTPError

import arxiv
import pytest
import requests

from crawler.models import Author, FullTextLocator, ScrapeRequest, SourceName, Subject
from crawler.sources.arxiv import (
    DEFAULT_LICENCE,
    ArxivScraper,
    is_arxiv_id,
    parse_licence,
    split_version,
)


def test_default_client_delegates_retries_to_the_runner() -> None:
    scraper = ArxivScraper()

    assert scraper._client.num_retries == 0


def test_build_query_keeps_the_legacy_date_filter() -> None:
    query = ArxivScraper.build_query("prostate cancer", "and", date(2026, 1, 2))
    assert query == (
        '(all:"prostate" AND all:"cancer") AND submittedDate:[202601020000 TO 300012312359]'
    )


def test_quotes_in_a_query_do_not_break_the_quoted_words() -> None:
    query = ArxivScraper.build_query('"breast cancer" mammography\\', "and", None)

    assert query == 'all:"breast" AND all:"cancer" AND all:"mammography"'


def arxiv_result(short_id: str, title: str = "Clinical matching") -> SimpleNamespace:
    return SimpleNamespace(
        get_short_id=lambda: short_id,
        categories=["q-bio.QM"],
        doi=None,
        title=title,
        entry_id=f"http://arxiv.org/abs/{short_id}",
        authors=[],
        summary="An abstract",
        published=datetime(2026, 10, 31, tzinfo=UTC),
        journal_ref=None,
    )


def test_parse_result_returns_metadata_without_downloading_a_pdf() -> None:
    result = SimpleNamespace(
        get_short_id=lambda: "2610.12345v1",
        categories=["cs.AI", "q-bio.QM", "cs.AI"],
        primary_category="q-bio.QM",
        doi="10.1000/ArXiv.42",
        title="Clinical\n  matching",
        entry_id="https://arxiv.org/abs/2610.12345v1",
        authors=[
            SimpleNamespace(name="Ada Lovelace", affiliation=["Analytical Engine Lab"]),
            SimpleNamespace(name="Charles Babbage", affiliation=[]),
        ],
        summary="An abstract",
        comment="12 pages",
        published=datetime(2026, 10, 31, tzinfo=UTC),
        updated=datetime(2026, 11, 2, tzinfo=UTC),
        journal_ref=None,
    )

    document = ArxivScraper.parse_result(result)

    assert document.id == "arxiv:2610.12345"
    assert document.source_id == "2610.12345"
    assert document.version == "1"
    assert document.content_type == "preprint"
    assert document.source is SourceName.ARXIV
    assert document.url == "https://arxiv.org/abs/2610.12345"
    assert document.doi == "10.1000/arxiv.42"
    assert document.title == "Clinical matching"
    assert document.authors == [
        Author(name="Ada Lovelace", affiliation="Analytical Engine Lab"),
        Author(name="Charles Babbage"),
    ]
    assert document.subjects == [
        Subject(scheme="arxiv", id="cs.AI", label="cs.AI", major=False),
        Subject(scheme="arxiv", id="q-bio.QM", label="q-bio.QM", major=True),
    ]
    assert document.source_updated_at == datetime(2026, 11, 2, tzinfo=UTC)
    assert document.full_text == [
        FullTextLocator(
            kind="html", url="https://arxiv.org/html/2610.12345v1", media_type="text/html"
        ),
        FullTextLocator(
            kind="pdf", url="https://arxiv.org/pdf/2610.12345v1", media_type="application/pdf"
        ),
    ]
    assert document.extra == {"comment": "12 pages"}
    assert document.licence is None


@pytest.mark.parametrize(
    ("short_id", "expected"),
    [
        ("2610.12345v12", ("2610.12345", "12")),
        ("2610.12345", ("2610.12345", None)),
        ("hep-th/9901001v2", ("hep-th/9901001", "2")),
        ("math.GT/0309136v1", ("math.GT/0309136", "1")),
    ],
)
def test_split_version(short_id: str, expected: tuple[str, str | None]) -> None:
    assert split_version(short_id) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("2610.12345", True),
        ("0704.0001", True),
        ("hep-th/9901001", True),
        ("math.GT/0309136", True),
        ("2610.12345v1", False),
        ("10.48550/arXiv.2610.12345", False),
        ("", False),
    ],
)
def test_is_arxiv_id(value: str, expected: bool) -> None:
    assert is_arxiv_id(value) is expected


class FakeClient:
    def __init__(self, found: set[str]) -> None:
        self.found = found
        self.searches: list[Any] = []
        self.num_retries = 0

    def results(self, search: Any) -> Iterator[SimpleNamespace]:
        self.searches.append(search)
        for arxiv_id in search.id_list:
            if arxiv_id in self.found:
                yield arxiv_result(f"{arxiv_id}v2")
        if len(self.found.intersection(search.id_list)) < len(search.id_list):
            raise arxiv.UnexpectedEmptyPageError("https://export.arxiv.org", 0, None)


def test_lookup_keeps_results_when_arxiv_leaves_out_unknown_ids() -> None:
    client = FakeClient(found={"2610.00001", "2610.00003"})
    scraper = ArxivScraper(client=client, licences=False)

    documents = scraper.scrape(
        ScrapeRequest(source=SourceName.ARXIV, ids=["2610.00001", "2610.00002", "2610.00003"])
    )

    assert [search.id_list for search in client.searches] == [
        ["2610.00001", "2610.00002", "2610.00003"]
    ]
    assert [document.id for document in documents] == ["arxiv:2610.00001", "arxiv:2610.00003"]
    assert {document.version for document in documents} == {"2"}


def test_lookup_asks_for_at_most_100_ids_per_query() -> None:
    ids = [f"2610.{number:05d}" for number in range(250)]
    client = FakeClient(found=set(ids))

    documents = ArxivScraper(client=client, licences=False).scrape(
        ScrapeRequest(source=SourceName.ARXIV, ids=ids)
    )

    assert [len(search.id_list) for search in client.searches] == [100, 100, 50]
    assert len(documents) == 250


def test_default_client_sends_requests_with_a_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: dict[str, Any] = {}

    def fake_request(_session: Any, _method: str, _url: str, **arguments: Any) -> Any:
        sent.update(arguments)
        return SimpleNamespace(status_code=200)

    monkeypatch.setattr(requests.Session, "request", fake_request)

    ArxivScraper()._client._session.get("https://export.arxiv.org/api/query")

    assert sent["timeout"] == 60.0


def oai_record(licence: str | None) -> bytes:
    """Shaped like an OAI-PMH GetRecord answer with metadataPrefix=arXiv."""
    element = f"<license>{licence}</license>" if licence else ""
    return (
        '<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><GetRecord><record><metadata>'
        f'<arXiv xmlns="http://arxiv.org/OAI/arXiv/"><id>2106.15928</id>{element}</arXiv>'
        "</metadata></record></GetRecord></OAI-PMH>"
    ).encode()


@pytest.mark.parametrize(
    ("licence", "expected"),
    [
        ("http://creativecommons.org/licenses/by-nc-nd/4.0/", "CC-BY-NC-ND-4.0"),
        ("http://creativecommons.org/licenses/by/4.0/", "CC-BY-4.0"),
        ("http://creativecommons.org/publicdomain/zero/1.0/", "CC0-1.0"),
        ("http://arxiv.org/licenses/nonexclusive-distrib/1.0/", DEFAULT_LICENCE),
        (None, DEFAULT_LICENCE),
    ],
)
def test_parse_licence(licence: str | None, expected: str) -> None:
    assert parse_licence(oai_record(licence)) == expected


def test_unknown_ids_have_no_licence() -> None:
    error = (
        b'<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">'
        b'<error code="idDoesNotExist">unknown</error></OAI-PMH>'
    )
    assert parse_licence(error) is None


class FakeOai:
    def __init__(self, answers: list[bytes | Exception]) -> None:
        self.answers = answers
        self.urls: list[str] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> bytes:
        self.urls.append(request.full_url)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer


class Clock:
    def __init__(self) -> None:
        self.now = datetime(2026, 11, 4, 12, 0, 0)
        self.sleeps: list[float] = []

    def time(self) -> datetime:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += timedelta(seconds=seconds)


def scraper_with_oai(oai: FakeOai, clock: Clock) -> ArxivScraper:
    client = FakeClient(found={"2610.00001", "2610.00002"})
    return ArxivScraper(client=client, fetch=oai, sleep=clock.sleep, now=clock.time)


def test_licences_come_from_oai_pmh_three_seconds_apart() -> None:
    oai = FakeOai([oai_record("http://creativecommons.org/licenses/by/4.0/"), oai_record(None)])
    clock = Clock()

    documents = scraper_with_oai(oai, clock).scrape(
        ScrapeRequest(source=SourceName.ARXIV, ids=["2610.00001", "2610.00002"])
    )

    assert [document.licence for document in documents] == ["CC-BY-4.0", DEFAULT_LICENCE]
    assert "identifier=oai%3AarXiv.org%3A2610.00001" in oai.urls[0]
    assert clock.sleeps == [3.0]


def test_a_failed_licence_lookup_leaves_the_licence_unknown() -> None:
    busy = Message()
    busy["Retry-After"] = "5"
    oai = FakeOai(
        [
            HTTPError("https://oaipmh.arxiv.org/oai", 503, "busy", busy, None),
            oai_record("http://creativecommons.org/licenses/by/4.0/"),
            HTTPError("https://oaipmh.arxiv.org/oai", 500, "error", Message(), None),
        ]
    )
    clock = Clock()

    documents = scraper_with_oai(oai, clock).scrape(
        ScrapeRequest(source=SourceName.ARXIV, ids=["2610.00001", "2610.00002"])
    )

    assert [document.licence for document in documents] == ["CC-BY-4.0", None]
    assert 5.0 in clock.sleeps


def test_a_cut_off_licence_answer_leaves_only_the_licence_unknown() -> None:
    oai = FakeOai(
        [IncompleteRead(b"<OAI-PMH"), oai_record("http://creativecommons.org/licenses/by/4.0/")]
    )

    documents = scraper_with_oai(oai, Clock()).scrape(
        ScrapeRequest(source=SourceName.ARXIV, ids=["2610.00001", "2610.00002"])
    )

    assert [document.licence for document in documents] == [None, "CC-BY-4.0"]
