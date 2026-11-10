from datetime import date

import pytest

from crawler.frontier import Frontier, TopicFilter
from crawler.models import (
    CitationProvenance,
    ContentType,
    QueryProvenance,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    Subject,
    source_document_id,
)


def paper(
    native_id: str,
    title: str = "Outcomes in prostate cancer",
    *,
    source: SourceName = SourceName.PUBMED,
    content_type: ContentType = "journal_article",
    abstract: str | None = None,
    subjects: list[str] | None = None,
) -> SourceDocument:
    return SourceDocument(
        id=source_document_id(source, native_id),
        source=source,
        content_type=content_type,
        source_id=native_id,
        title=title,
        url=f"https://example.test/{native_id}",
        abstract=abstract,
        subjects=[Subject(scheme="mesh", label=label) for label in subjects or []],
    )


@pytest.mark.parametrize(
    ("terms", "document", "expected"),
    [
        (["prostate cancer"], paper("1", "PROSTATE CANCER in men"), True),
        (["castration-resistant"], paper("1", "Castration resistant disease"), True),
        (["prostatic neoplasm"], paper("1", "x", subjects=["Prostatic Neoplasms"]), True),
        (["prostate cancer"], paper("1", "x", abstract="We treat prostate cancer."), True),
        (["ADT"], paper("1", "ADT and survival"), True),
        (["ADT"], paper("1", "Adtech in hospitals"), False),
        (["prostate cancer"], paper("1", "Cardiology outcomes"), False),
        (["prostate cancer"], paper("1", "x", subjects=["prostate", "cancer care"]), False),
        ([], paper("1", "Cardiology outcomes"), True),
        (["  "], paper("1", "Cardiology outcomes"), True),
    ],
)
def test_topic_filter(terms: list[str], document: SourceDocument, expected: bool) -> None:
    assert TopicFilter(terms).matches(document) is expected


@pytest.mark.parametrize(
    ("document", "expected"),
    [
        (paper("1", "Radiotherapy", abstract="Outcomes in prostate cancer"), True),
        (paper("1", "Prostate cancer outcomes"), False),
    ],
)
def test_topic_filter_can_require_every_term(document: SourceDocument, expected: bool) -> None:
    terms = ["prostate", "cancer", "radiotherapy"]

    assert TopicFilter(terms, match_all=True).matches(document) is expected
    assert TopicFilter(terms).matches(document) is True


def frontier(**overrides: object) -> Frontier:
    settings: dict[str, object] = {
        "max_depth": 1,
        "topic_filter": TopicFilter(["prostate cancer"]),
        "known_ids": frozenset(),
        "lookup_batch_size": {SourceName.PUBMED: 2},
    }
    settings.update(overrides)
    return Frontier(**settings)  # type: ignore[arg-type]


SEED = ScrapeRequest(source=SourceName.PUBMED, query="prostate cancer", topics=["prostate_cancer"])


def test_seed_documents_are_expanded_once_and_never_filtered() -> None:
    state = frontier()

    first = state.add_documents(SEED, 0, [paper("1"), paper("2", "Cardiology")], expand=True)
    again = state.add_documents(SEED, 0, [paper("1")], expand=True)

    assert first == [["1", "2"]]
    assert again == []
    assert state.stats.skipped_off_topic == 0


def test_only_papers_have_their_references_followed() -> None:
    state = frontier()

    assert state.add_documents(SEED, 0, [paper("1", content_type="video")], expand=True) == []
    assert state.add_documents(SEED, 0, [paper("2", content_type="preprint")], expand=True) == [
        ["2"]
    ]


def test_a_source_can_request_references_in_smaller_batches() -> None:
    state = frontier(references_batch_size={SourceName.ARXIV: 1})
    seed = ScrapeRequest(source=SourceName.ARXIV, query="prostate cancer")
    papers = [
        paper(native_id, source=SourceName.ARXIV, content_type="preprint")
        for native_id in ("2601.00001", "2601.00002")
    ]

    assert state.add_documents(seed, 0, papers, expand=True) == [["2601.00001"], ["2601.00002"]]


def test_documents_are_not_expanded_at_the_maximum_depth() -> None:
    state = frontier(max_depth=1)
    lookup = ScrapeRequest(source=SourceName.PUBMED, ids=["3"])

    assert state.add_documents(lookup, 1, [paper("3")], expand=True) == []
    assert state.add_documents(SEED, 0, [paper("1")], expand=False) == []


def test_references_skip_duplicates_known_invalid_and_self_citations() -> None:
    state = frontier(known_ids=frozenset({"pubmed:9"}))
    state.add_documents(SEED, 0, [paper("1"), paper("2")], expand=True)

    batches = state.add_references(
        SourceName.PUBMED,
        {"1": ["3", "4", "9", "1", "PMC123"], "2": ["3", "2", "5"]},
    )

    assert batches == [["3", "4"], ["5"]]
    assert state.stats.references_found == 8
    assert state.stats.skipped_known == 1
    assert state.stats.skipped_invalid == 3
    assert state.stats.skipped_duplicate == 1
    assert state.stats.lookups_queued == 3


def test_cited_papers_already_collected_are_not_looked_up_again() -> None:
    state = frontier()
    state.add_documents(SEED, 0, [paper("1"), paper("2")], expand=True)

    assert state.add_references(SourceName.PUBMED, {"1": ["2"]}) == []
    assert state.stats.skipped_duplicate == 1


def test_lookups_drop_off_topic_papers_and_count_missing_ones() -> None:
    state = frontier()
    lookup = ScrapeRequest(source=SourceName.PUBMED, ids=["3", "4", "5"])

    state.add_documents(lookup, 1, [paper("3"), paper("4", "Cardiology")], expand=True)
    result = state.result([])

    assert [document.id for document in result.documents] == ["pubmed:3"]
    assert result.stats.skipped_off_topic == 1
    assert result.stats.lookups_missing == 1


def test_seeds_with_since_that_return_max_results_are_noted() -> None:
    state = frontier()
    since = date(2026, 11, 1)
    full = ScrapeRequest(source=SourceName.PUBMED, query="psa", max_results=2, since=since)
    short = ScrapeRequest(source=SourceName.PUBMED, query="biopsy", max_results=3, since=since)
    relevance = ScrapeRequest(source=SourceName.PUBMED, query="gleason", max_results=1)
    lookup = ScrapeRequest(source=SourceName.PUBMED, ids=["5"], since=since)

    state.add_documents(full, 0, [paper("1"), paper("2")], expand=False)
    state.add_documents(short, 0, [paper("3")], expand=False)
    state.add_documents(relevance, 0, [paper("4")], expand=False)
    state.add_documents(lookup, 1, [paper("5")], expand=False)
    result = state.result([])

    assert result.max_results_reached == ["psa"]
    assert result.stats.max_results_reached == 1


def test_result_adds_every_citing_paper_to_found_by() -> None:
    state = frontier(known_ids=frozenset({"pubmed:9"}))
    state.add_documents(SEED, 0, [paper("1"), paper("2")], expand=True)
    state.add_references(SourceName.PUBMED, {"1": ["3", "9"], "2": ["3", "4"]})
    state.add_documents(
        ScrapeRequest(source=SourceName.PUBMED, ids=["3", "4"]),
        1,
        [paper("3"), paper("4", "Cardiology")],
        expand=True,
    )

    result = state.result([])
    documents = {document.id: document for document in result.documents}

    assert documents["pubmed:1"].found_by == [
        QueryProvenance(topic="prostate_cancer", query="prostate cancer")
    ]
    assert documents["pubmed:3"].found_by == [
        CitationProvenance(cited_by="pubmed:1"),
        CitationProvenance(cited_by="pubmed:2"),
    ]
    assert result.citations == {
        "pubmed:3": ["pubmed:1", "pubmed:2"],
        "pubmed:9": ["pubmed:1"],
    }
    assert result.stats.documents == 3
