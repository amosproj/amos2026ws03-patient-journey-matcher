import json
import urllib.request
from email.message import Message
from urllib.error import HTTPError

import pytest

from crawler.links.arxiv import ArxivLinkExtractor


def reference(external_ids: dict[str, object] | None) -> dict[str, object]:
    return {"citedPaper": {"paperId": "abc", "externalIds": external_ids}}


PAGES: dict[str, dict[str, object]] = {
    "2610.12345": {
        "offset": 0,
        "data": [
            reference({"ArXiv": "1706.03762v5", "DOI": "10.1000/x", "CorpusId": 1}),
            reference({"ArXiv": "hep-th/9901001"}),
            reference({"ArXiv": "1706.03762"}),
            reference({"ArXiv": "2610.12345"}),
            reference({"ArXiv": "not an id"}),
            reference({"PubMed": "123"}),
            reference(None),
            {"citedPaper": None},
        ],
    },
    "2610.00001": {"offset": 0, "data": None},
}


class FakeApi:
    def __init__(self) -> None:
        self.requests: list[urllib.request.Request] = []
        self.timeouts: list[float] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> bytes:
        self.requests.append(request)
        self.timeouts.append(timeout)
        arxiv_id = request.full_url.split("ARXIV:")[1].split("/references")[0]
        if arxiv_id == "2610.99999":
            raise HTTPError(request.full_url, 404, "Not Found", Message(), None)
        if arxiv_id == "2610.42900":
            raise HTTPError(request.full_url, 429, "Too Many Requests", Message(), None)
        return json.dumps(PAGES[arxiv_id]).encode()


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def time(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def extractor(api: FakeApi, clock: FakeClock, api_key: str | None = None) -> ArxivLinkExtractor:
    return ArxivLinkExtractor(api_key, fetch=api, sleep=clock.sleep, clock=clock.time)


def test_only_valid_version_less_arxiv_ids_are_returned() -> None:
    api = FakeApi()

    cited = extractor(api, FakeClock()).cited_ids(["2610.12345", "2610.00001", "2610.99999"])

    assert cited == {
        "2610.12345": ["1706.03762", "hep-th/9901001"],
        "2610.00001": [],
        "2610.99999": [],
    }
    assert api.requests[0].full_url == (
        "https://api.semanticscholar.org/graph/v1/paper/ARXIV:2610.12345/references"
        "?fields=externalIds&limit=1000"
    )
    assert api.timeouts == [60.0, 60.0, 60.0]


def test_the_api_key_is_only_sent_when_set() -> None:
    without_key, with_key = FakeApi(), FakeApi()

    extractor(without_key, FakeClock()).cited_ids(["2610.00001"])
    extractor(with_key, FakeClock(), api_key="secret").cited_ids(["2610.00001"])

    assert without_key.requests[0].get_header("X-api-key") is None
    assert with_key.requests[0].get_header("X-api-key") == "secret"
    assert with_key.requests[0].get_header("User-agent", "").startswith("patient-journey-matcher")


def test_calls_are_at_least_one_second_apart() -> None:
    clock = FakeClock()

    extractor(FakeApi(), clock).cited_ids(["2610.00001", "2610.00001", "2610.00001"])

    assert clock.sleeps == [1.0, 1.0]


def test_rate_limit_errors_reach_the_runner() -> None:
    with pytest.raises(HTTPError) as error:
        extractor(FakeApi(), FakeClock()).cited_ids(["2610.42900"])

    assert error.value.code == 429
