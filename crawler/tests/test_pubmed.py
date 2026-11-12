import io
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from datetime import UTC, date, datetime
from email.message import Message
from typing import Any
from urllib.error import HTTPError

import pytest
from Bio import Entrez

from crawler.models import (
    Author,
    FullTextLocator,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    Subject,
)
from crawler.sources.openalex import OpenAccessCopy
from crawler.sources.pubmed import (
    MAX_SEARCH_RESULTS,
    NcbiThrottle,
    PubMedScraper,
    is_pmid,
    ncbi_requests_per_second,
)


class EntrezValue(str):
    def __new__(cls, value: str, **attributes: str) -> "EntrezValue":
        instance = super().__new__(cls, value)
        instance.attributes = attributes
        return instance

    attributes: dict[str, str]


def test_contact_email_is_optional_for_low_volume_requests() -> None:
    PubMedScraper()


class EntrezDict(dict[str, Any]):
    def __init__(self, values: dict[str, Any], **attributes: str) -> None:
        super().__init__(values)
        self.attributes = attributes


class EntrezList(list[Any]):
    def __init__(self, values: list[Any], **attributes: str) -> None:
        super().__init__(values)
        self.attributes = attributes


def test_parse_article_reads_every_field_we_store() -> None:
    record: dict[str, Any] = {
        "MedlineCitation": EntrezDict(
            {
                "PMID": EntrezValue("4242", Version="1"),
                "DateRevised": {"Year": "2026", "Month": "11", "Day": "02"},
                "Article": {
                    "ArticleTitle": "A useful result.",
                    "Abstract": {
                        "AbstractText": [
                            EntrezValue("How the study was run", Label="METHODS"),
                            EntrezValue("What the study found", Label="RESULTS"),
                        ],
                        "CopyrightInformation": "© 2026 The Authors.",
                    },
                    "AuthorList": [
                        {
                            "ForeName": "Ada",
                            "LastName": "Lovelace",
                            "Identifier": [
                                EntrezValue("https://orcid.org/0000-0002-1825-0097", Source="ORCID")
                            ],
                            "AffiliationInfo": [{"Affiliation": "Analytical Engine Lab, London."}],
                        },
                        {"CollectiveName": "Study Group"},
                    ],
                    "Language": ["ger"],
                    "PublicationTypeList": [
                        EntrezValue("Journal Article", UI="D016428"),
                        EntrezValue("Review", UI="D016454"),
                    ],
                    "ArticleDate": [{"Year": "2026", "Month": "10", "Day": "31"}],
                    "Journal": {"Title": "Medical Journal", "JournalIssue": {}},
                },
                "MeshHeadingList": [
                    {
                        "DescriptorName": EntrezValue(
                            "Prostatic Neoplasms", UI="D011471", MajorTopicYN="N"
                        ),
                        "QualifierName": [EntrezValue("therapy", UI="Q000628", MajorTopicYN="Y")],
                    },
                    {
                        "DescriptorName": EntrezValue("Humans", UI="D006801", MajorTopicYN="N"),
                        "QualifierName": [],
                    },
                ],
                "ChemicalList": [
                    {
                        "RegistryNumber": "0",
                        "NameOfSubstance": EntrezValue("Antineoplastic Agents", UI="D000970"),
                    }
                ],
                "KeywordList": [
                    EntrezList([EntrezValue("Patient Education", MajorTopicYN="N")], Owner="NOTNLM")
                ],
            },
            Status="MEDLINE",
        ),
        "PubmedData": {
            "ArticleIdList": [
                EntrezValue("4242", IdType="pubmed"),
                EntrezValue("10.1000/example", IdType="doi"),
                EntrezValue("PMC1234567", IdType="pmc"),
                EntrezValue("NIHMS99", IdType="mid"),
            ],
            "History": [
                EntrezDict({"Year": "2026", "Month": "10", "Day": "30"}, PubStatus="entrez"),
                EntrezDict({"Year": "2027", "Month": "10", "Day": "31"}, PubStatus="pmc-release"),
            ],
        },
    }

    document = PubMedScraper.parse_article(record)

    assert document.id == "pubmed:4242"
    assert document.version == "1"
    assert document.content_type == "journal_article"
    assert document.source is SourceName.PUBMED
    assert document.title == "A useful result"
    assert document.abstract == ("METHODS: How the study was run\nRESULTS: What the study found")
    assert document.authors == [
        Author(
            name="Ada Lovelace",
            orcid="0000-0002-1825-0097",
            affiliation="Analytical Engine Lab, London.",
        ),
        Author(name="Study Group"),
    ]
    assert document.language == "de"
    assert document.published_at == "2026-10-31"
    assert document.source_updated_at == datetime(2026, 11, 2, tzinfo=UTC)
    assert document.doi == "10.1000/example"
    assert document.publication_types == ["Journal Article", "Review"]
    assert document.subjects == [
        Subject(scheme="mesh", id="D011471", label="Prostatic Neoplasms", major=True),
        Subject(
            scheme="mesh", id="D011471Q000628", label="Prostatic Neoplasms/therapy", major=True
        ),
        Subject(scheme="mesh", id="D006801", label="Humans", major=False),
        Subject(scheme="mesh", id="D000970", label="Antineoplastic Agents"),
        Subject(scheme="keyword", label="Patient Education", major=False),
    ]
    assert document.external_ids == {"pmcid": "PMC1234567", "nihms": "NIHMS99"}
    assert document.extra == {
        "status": "MEDLINE",
        "entrez_date": "2026-10-30",
        "pmc_release_date": "2027-10-31",
        "copyright": "© 2026 The Authors.",
    }
    assert document.licence is None
    assert document.full_text == []


def test_parse_article_supports_medline_year_only_dates() -> None:
    article = {"Journal": {"JournalIssue": {"PubDate": {"MedlineDate": "2024 Winter"}}}}
    assert PubMedScraper._publication_date(article) == "2024"


ARTICLE_WITH_MARKUP = (
    b'<?xml version="1.0" ?>'
    b'<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN"'
    b' "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">'
    b"<PubmedArticleSet><PubmedArticle>"
    b'<MedlineCitation Status="MEDLINE" Owner="NLM"><PMID Version="1">4242</PMID>'
    b'<Article PubModel="Print">'
    b'<Journal><JournalIssue CitedMedium="Print"><PubDate><Year>2026</Year></PubDate>'
    b"</JournalIssue><Title>Medical Journal</Title></Journal>"
    b"<ArticleTitle>[<sup>177</sup>Lu]Lu-PSMA-617 in <i>BRCA2</i> carriers"
    b" with PSA &lt;4 vs &gt;10 ng/mL.</ArticleTitle>"
    b'<Abstract><AbstractText Label="RESULTS">Rate '
    b'<mml:math xmlns:mml="http://www.w3.org/1998/Math/MathML">'
    b"<mml:mi>x</mml:mi><mml:mo>&lt;</mml:mo><mml:mn>2</mml:mn></mml:math>"
    b" (p&lt;0.05) &amp; more.</AbstractText></Abstract>"
    b"<Language>eng</Language></Article>"
    b'<KeywordList Owner="NOTNLM"><Keyword MajorTopicYN="N"><i>BRCA2</i></Keyword></KeywordList>'
    b"</MedlineCitation>"
    b'<PubmedData><ArticleIdList><ArticleId IdType="doi">10.1016/J.EURURO.2026.01.001</ArticleId>'
    b"</ArticleIdList></PubmedData>"
    b"</PubmedArticle></PubmedArticleSet>"
)


def test_parse_article_drops_inline_markup_but_keeps_the_text_around_it() -> None:
    # Real Biopython output: tags stay raw, `&lt;` comes back as `<`. The DTD is bundled.
    record = Entrez.read(io.BytesIO(ARTICLE_WITH_MARKUP))

    document = PubMedScraper.parse_article(record["PubmedArticle"][0])

    assert document.title == "[177Lu]Lu-PSMA-617 in BRCA2 carriers with PSA <4 vs >10 ng/mL"
    assert document.abstract == "RESULTS: Rate x<2 (p<0.05) & more."
    assert document.subjects == [Subject(scheme="keyword", label="BRCA2", major=False)]
    assert document.doi == "10.1016/j.eururo.2026.01.001"


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


class FakeClock:
    def __init__(self) -> None:
        self.now = 100.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def test_throttle_keeps_the_gap_between_requests() -> None:
    clock = FakeClock()
    throttle = NcbiThrottle(clock=clock, sleep=clock.sleep)

    throttle.wait(5)
    throttle.wait(5)
    clock.now += 0.05
    throttle.wait(5)
    clock.now += 1
    throttle.wait(5)

    assert clock.sleeps == pytest.approx([0.2, 0.15])


def test_requests_per_second_default_to_the_key_limit_and_ignore_bad_values() -> None:
    assert ncbi_requests_per_second("key", None) == 5
    assert ncbi_requests_per_second(None, "") == 3
    assert ncbi_requests_per_second("key", " 2.5 ") == 2.5
    for bad in ("fast", "0", "-1", "nan", "inf"):
        assert ncbi_requests_per_second("key", bad) == 5


def test_every_ncbi_request_waits_for_the_throttle() -> None:
    class RecordingThrottle(NcbiThrottle):
        def __init__(self) -> None:
            super().__init__()
            self.rates: list[float] = []

        def wait(self, requests_per_second: float) -> None:
            self.rates.append(requests_per_second)

    throttle = RecordingThrottle()
    scraper = PubMedScraper(api_key="key", entrez=FakeEntrez(["1"]), throttle=throttle)

    scraper.scrape(ScrapeRequest(source=SourceName.PUBMED, query="q"))

    assert throttle.rates == [5, 5]  # esearch, efetch


def test_pmid_validation() -> None:
    assert is_pmid("41000123")
    assert not is_pmid("0123")
    assert not is_pmid("PMC123")
    assert not is_pmid("")


def test_searches_since_a_date_use_the_entry_date_and_stay_below_the_id_cap() -> None:
    entrez = FakeEntrez([])
    scraper = PubMedScraper(entrez=entrez)

    scraper.scrape(
        ScrapeRequest(
            source=SourceName.PUBMED, query="q", max_results=10_000, since=date(2026, 1, 2)
        )
    )

    [(_call, arguments)] = entrez.calls
    assert arguments["datetype"] == "edat"
    assert arguments["mindate"] == "2026/01/02"
    assert arguments["retmax"] == MAX_SEARCH_RESULTS
    # PubMed's default order is the newest entry first, so a capped search keeps the papers
    # indexed late; sorting by publication date would cut exactly those.
    assert "sort" not in arguments


def test_searches_without_since_rank_by_relevance() -> None:
    entrez = FakeEntrez([])

    PubMedScraper(entrez=entrez).scrape(ScrapeRequest(source=SourceName.PUBMED, query="q"))

    [(_call, arguments)] = entrez.calls
    assert arguments["sort"] == "relevance"


class FakePmc:
    def __init__(self, failing: dict[str, Exception] | None = None) -> None:
        self.enriched: list[str] = []
        self.failing = failing or {}

    def enrich(self, document: SourceDocument) -> SourceDocument:
        self.enriched.append(document.id)
        if document.id in self.failing:
            raise self.failing[document.id]
        return document.model_copy(update={"licence": "CC-BY"})


def test_pmc_enriches_every_fetched_record() -> None:
    pmc = FakePmc()
    scraper = PubMedScraper(entrez=FakeEntrez(["1", "2"]), pmc=pmc)  # type: ignore[arg-type]

    documents = scraper.scrape(ScrapeRequest(source=SourceName.PUBMED, query="q"))

    assert pmc.enriched == ["pubmed:1", "pubmed:2"]
    assert {document.licence for document in documents} == {"CC-BY"}


def test_a_broken_pmc_answer_keeps_the_record_without_licence() -> None:
    pmc = FakePmc({"pubmed:2": ET.ParseError("truncated")})
    scraper = PubMedScraper(entrez=FakeEntrez(["1", "2", "3"]), pmc=pmc)  # type: ignore[arg-type]

    documents = scraper.scrape(ScrapeRequest(source=SourceName.PUBMED, query="q"))

    assert [(document.id, document.licence) for document in documents] == [
        ("pubmed:1", "CC-BY"),
        ("pubmed:2", None),
        ("pubmed:3", "CC-BY"),
    ]


def test_a_pmc_network_error_fails_the_request_so_it_is_retried() -> None:
    # Swallowed, it would leave a record that looks as if PMC did not have it.
    pmc = FakePmc({"pubmed:1": HTTPError("https://pmc", 503, "Slow Down", Message(), None)})
    scraper = PubMedScraper(entrez=FakeEntrez(["1", "2"]), pmc=pmc)  # type: ignore[arg-type]

    with pytest.raises(HTTPError):
        scraper.scrape(ScrapeRequest(source=SourceName.PUBMED, query="q"))


PDF = FullTextLocator(
    kind="pdf", url="https://journal.example.org/2.pdf", media_type="application/pdf"
)
JATS = FullTextLocator(
    kind="jats", url="https://pmc.example.org/1.xml", media_type="application/xml"
)


class FakeOpenAlex:
    def __init__(self, error: Exception | None = None) -> None:
        self.asked: list[list[str]] = []
        self.error = error

    def open_access(self, dois: Sequence[str]) -> dict[str, OpenAccessCopy]:
        self.asked.append(list(dois))
        if self.error is not None:
            raise self.error
        return {"10.1/2": OpenAccessCopy(full_text=[PDF], licence="CC-BY", openalex_id="W2")}


class DoiPmc:
    """PMC holds pubmed:1; every record has the DOI `10.1/<pmid>`."""

    def enrich(self, document: SourceDocument) -> SourceDocument:
        update: dict[str, Any] = {"doi": f"10.1/{document.source_id}"}
        if document.id == "pubmed:1":
            update |= {"full_text": [JATS], "licence": "CC-BY-NC"}
        return document.model_copy(update=update)


def oa_scraper(open_access: FakeOpenAlex, ids: list[str]) -> PubMedScraper:
    return PubMedScraper(
        entrez=FakeEntrez(ids),
        pmc=DoiPmc(),  # type: ignore[arg-type]
        open_access=open_access,  # type: ignore[arg-type]
    )


def test_openalex_adds_open_copies_only_where_pmc_has_no_full_text() -> None:
    open_access = FakeOpenAlex()

    documents = oa_scraper(open_access, ["1", "2", "3"]).scrape(
        ScrapeRequest(source=SourceName.PUBMED, query="q")
    )

    assert open_access.asked == [["10.1/2", "10.1/3"]]
    pmc, open_copy, closed = documents
    assert (pmc.full_text, pmc.licence) == ([JATS], "CC-BY-NC")
    assert (open_copy.full_text, open_copy.licence) == ([PDF], "CC-BY")
    assert open_copy.external_ids["openalex"] == "W2"
    assert (closed.full_text, closed.licence) == ([], None)


def test_openalex_is_not_asked_when_pmc_has_every_full_text() -> None:
    open_access = FakeOpenAlex()

    oa_scraper(open_access, ["1"]).scrape(ScrapeRequest(source=SourceName.PUBMED, query="q"))

    assert open_access.asked == []


@pytest.mark.parametrize(
    "error",
    [HTTPError("https://api.openalex.org", 429, "Too Many", Message(), None), ValueError("json")],
)
def test_an_openalex_error_keeps_the_records_and_the_request(error: Exception) -> None:
    documents = oa_scraper(FakeOpenAlex(error), ["1", "2"]).scrape(
        ScrapeRequest(source=SourceName.PUBMED, query="q")
    )

    assert [document.full_text for document in documents] == [[JATS], []]


BOOK_CHAPTER = (
    b'<?xml version="1.0" ?>'
    b'<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN"'
    b' "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">'
    b"<PubmedArticleSet><PubmedBookArticle><BookDocument>"
    b'<PMID Version="1">26389471</PMID>'
    b'<ArticleIdList><ArticleId IdType="bookaccession">NBK66036</ArticleId></ArticleIdList>'
    b"<Book><Publisher><PublisherName>National Cancer Institute (US)</PublisherName>"
    b"</Publisher><BookTitle>PDQ Cancer Information Summaries</BookTitle>"
    b"<PubDate><Year>2002</Year></PubDate>"
    b'<AuthorList Type="editors"><Author><LastName>Editor</LastName><ForeName>Ed</ForeName>'
    b"</Author></AuthorList></Book>"
    b"<ArticleTitle>Prostate Cancer Treatment (PDQ&#xae;): Health Professional Version"
    b"</ArticleTitle><Language>eng</Language>"
    b'<AuthorList Type="authors"><Author><CollectiveName>PDQ Adult Treatment Editorial Board'
    b"</CollectiveName></Author></AuthorList>"
    b'<PublicationType UI="D016454">Review</PublicationType>'
    b"<Abstract><AbstractText>This PDQ summary is about prostate cancer treatment."
    b"</AbstractText><CopyrightInformation>Public domain</CopyrightInformation></Abstract>"
    b'<KeywordList Owner="NOTNLM"><Keyword MajorTopicYN="N">prostate cancer</Keyword>'
    b'</KeywordList><KeywordList Owner="NLM"><Keyword MajorTopicYN="N">prostate cancer'
    b"</Keyword></KeywordList>"
    b"<ContributionDate><Year>2025</Year><Month>2</Month><Day>13</Day></ContributionDate>"
    b"</BookDocument><PubmedBookData><History>"
    b'<PubMedPubDate PubStatus="entrez"><Year>2025</Year><Month>2</Month><Day>13</Day>'
    b"</PubMedPubDate></History><PublicationStatus>ppublish</PublicationStatus>"
    b'<ArticleIdList><ArticleId IdType="pubmed">26389471</ArticleId></ArticleIdList>'
    b"</PubmedBookData></PubmedBookArticle></PubmedArticleSet>"
)


def test_book_chapters_are_parsed_like_articles() -> None:
    # Real Biopython output, so the repeated author lists keep their `Type`.
    record = Entrez.read(io.BytesIO(BOOK_CHAPTER))

    document = PubMedScraper.parse_book(record["PubmedBookArticle"][0])

    assert document.id == "pubmed:26389471"
    assert document.content_type == "book"
    assert document.version == "1"
    assert document.title == "Prostate Cancer Treatment (PDQ®): Health Professional Version"
    assert document.url == "https://pubmed.ncbi.nlm.nih.gov/26389471/"
    assert document.authors == [Author(name="PDQ Adult Treatment Editorial Board")]
    assert document.abstract == "This PDQ summary is about prostate cancer treatment."
    assert document.language == "en"
    assert document.published_at == "2025-02-13"
    assert document.source_updated_at == datetime(2025, 2, 13, tzinfo=UTC)
    assert document.journal == "PDQ Cancer Information Summaries"
    assert document.publication_types == ["Review"]
    assert document.subjects == [Subject(scheme="keyword", label="prostate cancer", major=False)]
    assert document.external_ids == {"bookshelf_id": "NBK66036"}
    assert document.extra == {"entrez_date": "2025-02-13", "copyright": "Public domain"}


class FakeEntrezWithBooks(FakeEntrez):
    """Biopython lists articles and books apart, whatever the order of the IDs."""

    def efetch(self, **arguments: Any) -> FakeHandle:
        self.calls.append(("efetch", arguments))
        book = Entrez.read(io.BytesIO(BOOK_CHAPTER))["PubmedBookArticle"][0]
        return FakeHandle(
            {
                "PubmedArticle": [minimal_article("1"), minimal_article("2")],
                "PubmedBookArticle": [book],
            }
        )


def test_search_results_keep_books_and_the_order_of_the_ids() -> None:
    scraper = PubMedScraper(entrez=FakeEntrezWithBooks(["1", "26389471", "2"]))

    documents = scraper.scrape(ScrapeRequest(source=SourceName.PUBMED, query="q"))

    assert [(document.id, document.content_type) for document in documents] == [
        ("pubmed:1", "journal_article"),
        ("pubmed:26389471", "book"),
        ("pubmed:2", "journal_article"),
    ]
