import json
import urllib.request
from email.message import Message
from urllib.error import HTTPError

import pytest

from crawler.models import FullTextLocator, SourceDocument, SourceName
from crawler.sources.pmc import PmcClient, pmc_licence

BUCKET = "https://pmc-oa-opendata.s3.amazonaws.com"


def listing(*prefixes: str) -> bytes:
    """Shaped like the S3 ListObjectsV2 answer of the PMC bucket."""
    common = "".join(
        f"<CommonPrefixes><Prefix>{prefix}</Prefix></CommonPrefixes>" for prefix in prefixes
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        f"<Name>pmc-oa-opendata</Name><KeyCount>{len(prefixes)}</KeyCount>{common}"
        "</ListBucketResult>"
    ).encode()


def metadata(pmcid: str, version: int, **fields: object) -> bytes:
    return json.dumps(
        {
            "pmcid": pmcid,
            "version": version,
            "mid": None,
            "is_manuscript": False,
            "is_retracted": False,
            "is_historical_ocr": False,
            "license_code": "CC BY",
            "xml_url": f"s3://pmc-oa-opendata/{pmcid}.{version}/{pmcid}.{version}.xml?md5=abc123",
            **fields,
        }
    ).encode()


class FakeBucket:
    def __init__(self, responses: dict[str, bytes]) -> None:
        self.responses = responses
        self.urls: list[str] = []

    def __call__(self, request: urllib.request.Request, timeout: float) -> bytes:
        self.urls.append(request.full_url)
        if request.full_url not in self.responses:
            raise HTTPError(request.full_url, 404, "Not Found", Message(), None)
        return self.responses[request.full_url]


def list_url(pmcid: str) -> str:
    return f"{BUCKET}/?list-type=2&prefix={pmcid}.&delimiter=%2F"


def paper(pmcid: str | None) -> SourceDocument:
    return SourceDocument(
        id="pubmed:1",
        source=SourceName.PUBMED,
        content_type="journal_article",
        source_id="1",
        title="Paper",
        url="https://pubmed.ncbi.nlm.nih.gov/1/",
        external_ids={"pmcid": pmcid} if pmcid else {},
    )


def client(bucket: FakeBucket) -> PmcClient:
    return PmcClient(fetch=bucket, sleep=lambda _seconds: None)


def test_enrich_adds_licence_full_text_and_pmc_ids() -> None:
    bucket = FakeBucket(
        {
            list_url("PMC123"): listing("PMC123.1/"),
            f"{BUCKET}/metadata/PMC123.1.json": metadata("PMC123", 1, mid="NIHMS9"),
        }
    )

    document = client(bucket).enrich(paper("PMC123"))

    assert document.licence == "CC-BY"
    assert document.full_text == [
        FullTextLocator(
            kind="jats",
            url=f"{BUCKET}/PMC123.1/PMC123.1.xml",
            media_type="application/xml",
            checksum="md5:abc123",
        )
    ]
    assert document.external_ids == {"pmcid": "PMC123", "pmc_version": "1", "nihms": "NIHMS9"}
    assert document.extra == {
        "is_manuscript": False,
        "is_retracted": False,
        "is_historical_ocr": False,
    }


def test_enrich_prefers_a_version_that_is_not_a_manuscript() -> None:
    bucket = FakeBucket(
        {
            list_url("PMC123"): listing("PMC123.1/", "PMC123.2/"),
            f"{BUCKET}/metadata/PMC123.2.json": metadata(
                "PMC123", 2, is_manuscript=True, license_code="TDM"
            ),
            f"{BUCKET}/metadata/PMC123.1.json": metadata("PMC123", 1),
        }
    )

    document = client(bucket).enrich(paper("PMC123"))

    assert document.external_ids["pmc_version"] == "1"
    assert document.licence == "CC-BY"


def test_records_outside_the_bucket_stay_unchanged() -> None:
    bucket = FakeBucket({list_url("PMC404"): listing()})
    original = paper("PMC404")

    without_pmcid = paper(None)

    assert client(bucket).enrich(original) == original
    assert client(bucket).enrich(without_pmcid) == without_pmcid
    assert bucket.urls == [list_url("PMC404")]


def test_server_errors_reach_the_runner_for_a_retry() -> None:
    class Failing(FakeBucket):
        def __call__(self, request: urllib.request.Request, timeout: float) -> bytes:
            raise HTTPError(request.full_url, 503, "Slow Down", Message(), None)

    with pytest.raises(HTTPError):
        client(Failing({})).enrich(paper("PMC123"))


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("CC BY", "CC-BY"),
        ("CC BY-NC-ND", "CC-BY-NC-ND"),
        ("CC0", "CC0-1.0"),
        ("TDM", "pmc-tdm"),
        (None, None),
    ],
)
def test_pmc_licence_codes(code: str | None, expected: str | None) -> None:
    assert pmc_licence(code) == expected
