import json
from collections.abc import Iterable
from pathlib import Path

import pytest

from crawler import cli
from crawler.cli import main, parser, requests_from_args
from crawler.models import (
    CollectionResult,
    CollectionStats,
    RequestFailure,
    ScrapeRequest,
    SourceDocument,
    SourceName,
)
from crawler.runner import CollectionOptions

TOPIC = """
id: demo_topic
label: Demo topic
terms: [prostate cancer]
queries: [prostate cancer, prostate cancer biopsy]
channels:
  - name: Demo channel
    url: https://www.youtube.com/channel/UCdemo
"""


def test_cli_builds_pubmed_request() -> None:
    arguments = parser().parse_args(
        ["pubmed", "prostate cancer", "--max-results", "3", "--since", "2026-01-01"]
    )
    [request], options = requests_from_args(arguments)
    assert request.source is SourceName.PUBMED
    assert request.query == "prostate cancer"
    assert request.max_results == 3
    assert request.since is not None
    assert options.max_depth == 1
    assert options.topic_terms == ("prostate cancer",)


def test_cli_builds_zenodo_request_without_reference_following() -> None:
    arguments = parser().parse_args(
        ["zenodo", "prostate cancer", "--since", "2026-01-01", "--query-mode", "or"]
    )

    [request], options = requests_from_args(arguments)

    assert request.source is SourceName.ZENODO
    assert request.query_mode == "or"
    assert request.since is not None
    assert options.max_depth == 0
    for option in (["--max-depth", "1"], ["--known-ids", "known.txt"]):
        with pytest.raises(SystemExit):
            parser().parse_args(["zenodo", "prostate cancer", *option])


def test_known_ids_come_from_a_list_or_from_the_output_of_a_run(tmp_path: Path) -> None:
    known = tmp_path / "known.jsonl"
    record = json.dumps({"id": "pubmed:2", "title": "Prostate cancer"})
    known.write_text(f"# stored earlier\npubmed:1\n\n{record}\n", encoding="utf-8")

    _requests, options = requests_from_args(
        parser().parse_args(["pubmed", "prostate cancer", "--known-ids", str(known)])
    )

    assert options.known_ids == {"pubmed:1", "pubmed:2"}


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (None, "cannot read"),
        ("12345\n", "line 1: expected a document ID"),
        ('pubmed:1\n{"title": "no id"}\n', "line 2: expected a document ID"),
        ("{broken json\n", "line 1: expected a document ID"),
    ],
)
def test_a_broken_known_ids_file_is_a_usage_error(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], content: str | None, message: str
) -> None:
    known = tmp_path / "known.txt"
    if content is not None:
        known.write_text(content, encoding="utf-8")

    with pytest.raises(SystemExit) as exit_info:
        parser().parse_args(["arxiv", "prostate cancer", "--known-ids", str(known)])

    assert exit_info.value.code == 2
    assert message in capsys.readouterr().err


def test_raw_arxiv_queries_have_no_topic_filter() -> None:
    arguments = parser().parse_args(["arxiv", 'ti:"prostate"', "--query-mode", "raw"])

    _requests, options = requests_from_args(arguments)

    assert options.topic_terms == ()


@pytest.mark.parametrize(
    "argv",
    [
        ["pubmed"],
        ["pubmed", "prostate cancer", "--topic", "prostate_cancer"],
        ["youtube"],
    ],
)
def test_a_query_and_a_topic_are_mutually_exclusive_and_one_is_required(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        parser().parse_args(argv)

    assert exit_info.value.code == 2


def test_topic_runs_seed_every_query_and_use_the_topic_terms(tmp_path: Path) -> None:
    topic_file = tmp_path / "demo_topic.yaml"
    topic_file.write_text(TOPIC, encoding="utf-8")
    arguments = parser().parse_args(
        ["pubmed", "--topic", str(topic_file), "--max-depth", "2", "--max-requests", "50"]
    )

    requests, options = requests_from_args(arguments)

    assert [request.query for request in requests] == ["prostate cancer", "prostate cancer biopsy"]
    assert all(request.topics == ["demo_topic"] for request in requests)
    assert options.topic_terms == ("prostate cancer",)
    assert options.max_depth == 2
    assert options.max_requests == 50


def test_youtube_topic_runs_seed_the_channels(tmp_path: Path) -> None:
    topic_file = tmp_path / "demo_topic.yaml"
    topic_file.write_text(TOPIC, encoding="utf-8")

    requests, options = requests_from_args(
        parser().parse_args(["youtube", "--topic", str(topic_file)])
    )

    assert [request.channel for request in requests] == ["https://www.youtube.com/channel/UCdemo"]
    assert options.max_depth == 0


def document() -> SourceDocument:
    return SourceDocument(
        id="pubmed:1",
        source=SourceName.PUBMED,
        content_type="journal_article",
        source_id="1",
        title="Prostate cancer",
        url="https://pubmed.ncbi.nlm.nih.gov/1/",
    )


def fake_run(result: CollectionResult) -> object:
    async def run_requests(
        _seeds: Iterable[ScrapeRequest], *, options: CollectionOptions
    ) -> CollectionResult:
        return result

    return run_requests


def test_main_prints_json_lines_and_a_summary(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    result = CollectionResult(documents=[document()], stats=CollectionStats(documents=1))
    monkeypatch.setattr(cli, "run_requests", fake_run(result))

    exit_code = main(["pubmed", "prostate cancer"])

    output = capsys.readouterr()
    assert exit_code == 0
    assert [json.loads(line)["id"] for line in output.out.splitlines()] == ["pubmed:1"]
    assert "collected 1 document(s)" in output.err


def test_main_exits_with_1_and_lists_failures_but_still_prints_documents(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    failure = RequestFailure(
        kind="lookup",
        source=SourceName.PUBMED,
        detail="2 ID(s): 3, 4",
        depth=1,
        error="HTTPError: HTTP Error 400: Bad Request",
        retries=0,
        retryable=False,
    )
    result = CollectionResult(documents=[document()], failures=[failure])
    monkeypatch.setattr(cli, "run_requests", fake_run(result))

    exit_code = main(["pubmed", "prostate cancer"])

    output = capsys.readouterr()
    assert exit_code == 1
    assert len(output.out.splitlines()) == 1
    assert "failed lookup pubmed (depth 1) 2 ID(s): 3, 4" in output.err
    assert "without retry" in output.err


def test_main_exits_with_2_for_a_broken_topic_file(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    broken = tmp_path / "broken.yaml"
    broken.write_text("id: broken\nlabel: Broken\n", encoding="utf-8")

    with pytest.raises(SystemExit) as exit_info:
        main(["pubmed", "--topic", str(broken)])

    assert exit_info.value.code == 2
    assert "at least one query, channel or podcast" in capsys.readouterr().err


def test_podcast_runs_take_a_curated_feed_key() -> None:
    [request], options = requests_from_args(
        parser().parse_args(["podcast", "jco", "--max-results", "5", "--since", "2026-10-01"])
    )

    assert request.source is SourceName.PODCAST
    assert request.feed is not None
    assert request.feed.url == "https://jcopodcast.libsyn.com/rss"
    assert request.max_results == 5
    assert options.max_depth == 0


def test_unknown_podcast_feeds_are_a_configuration_error(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["podcast", "no_such_feed"])

    assert exit_info.value.code == 2
    assert "unknown podcast feed" in capsys.readouterr().err


def test_youtube_runs_accept_since() -> None:
    [request], _options = requests_from_args(
        parser().parse_args(["youtube", "@NationalCancerInstitute", "--since", "2026-10-01"])
    )

    assert request.since is not None
