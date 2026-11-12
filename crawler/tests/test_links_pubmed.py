from typing import Any

from crawler.links.pubmed import REFERENCES_LINK, PubMedLinkExtractor
from crawler.sources.pubmed import NcbiThrottle


class FakeHandle:
    def __init__(self, payload: Any) -> None:
        self.payload = payload

    def close(self) -> None:
        pass


class FakeEntrez:
    def __init__(self, link_sets: list[dict[str, Any]]) -> None:
        self.link_sets = link_sets
        self.calls: list[dict[str, Any]] = []
        self.email: str | None = None
        self.tool: str | None = None
        self.api_key: str | None = None
        self.max_tries = 3

    def elink(self, **arguments: Any) -> FakeHandle:
        self.calls.append(arguments)
        return FakeHandle(self.link_sets)

    def read(self, handle: FakeHandle) -> Any:
        return handle.payload


def link_set(pmid: str, *references: str, name: str = REFERENCES_LINK) -> dict[str, Any]:
    return {
        "IdList": [pmid],
        "LinkSetDb": [{"LinkName": name, "Link": [{"Id": value} for value in references]}],
    }


def test_elink_gets_a_list_so_every_pmid_keeps_its_own_references() -> None:
    entrez = FakeEntrez(
        [
            link_set("1", "10", "11", "10", "1"),
            link_set("2", "20", name="pubmed_pubmed_citedin"),
            {"IdList": ["3"], "LinkSetDb": []},
        ]
    )
    extractor = PubMedLinkExtractor(email="team@example.test", api_key="key", entrez=entrez)

    cited = extractor.cited_ids(["1", "2", "3", "4"])

    assert entrez.calls == [
        {
            "dbfrom": "pubmed",
            "db": "pubmed",
            "linkname": REFERENCES_LINK,
            "id": ["1", "2", "3", "4"],
        }
    ]
    assert cited == {"1": ["10", "11"], "2": [], "3": [], "4": []}
    assert (entrez.email, entrez.tool, entrez.api_key, entrez.max_tries) == (
        "team@example.test",
        "patient-journey-matcher",
        "key",
        1,
    )


def test_no_ids_means_no_request() -> None:
    entrez = FakeEntrez([])

    assert PubMedLinkExtractor(entrez=entrez).cited_ids([]) == {}
    assert entrez.calls == []


def test_elink_waits_for_the_throttle_at_the_configured_rate() -> None:
    class RecordingThrottle(NcbiThrottle):
        def __init__(self) -> None:
            super().__init__()
            self.rates: list[float] = []

        def wait(self, requests_per_second: float) -> None:
            self.rates.append(requests_per_second)

    throttle = RecordingThrottle()
    extractor = PubMedLinkExtractor(entrez=FakeEntrez([]), requests_per_second=2, throttle=throttle)

    extractor.cited_ids(["1"])

    assert throttle.rates == [2]
