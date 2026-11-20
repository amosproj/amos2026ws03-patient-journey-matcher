import asyncio
import io
import json
import sys
from collections.abc import Callable, Iterable, Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from crawler import cli, seeds
from crawler.cli import main, parser, requests_from_args
from crawler.models import (
    CollectionResult,
    CollectionStats,
    RequestFailure,
    ScrapeRequest,
    SourceDocument,
    SourceName,
)
from crawler.refresh import RefreshReport
from crawler.runner import CollectionOptions
from crawler.sources.youtube import YouTubeScraper
from crawler.store import RunInfo, StoreError, StoreReport

TOPIC = """
id: demo_topic
label: Demo topic
terms: [prostate cancer]
queries: [prostate cancer, prostate cancer biopsy]
channels:
  - name: Demo channel
    url: https://www.youtube.com/channel/UCdemo0000000000000000ab
"""
FIELD = """
id: demo_field
label: Demo field
channels:
  - name: Field channel
    url: https://www.youtube.com/channel/UCdemo0000000000000000cd
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
    assert options.topic_terms == ()


def test_refresh_command_backfills_stored_enrichment_without_crawling(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    calls = []

    async def refresh(url: str, **options: object) -> RefreshReport:
        calls.append((url, options))
        return RefreshReport(scanned=2, changed=1, unchanged=1)

    monkeypatch.setattr(cli, "database_url", lambda: "test-db")
    monkeypatch.setattr(cli, "refresh_documents", refresh)
    assert main(["refresh", "--source", "pubmed", "--limit", "2", "--batch-size", "1"]) == 0
    assert calls == [("test-db", {"source": SourceName.PUBMED, "limit": 2, "batch_size": 1})]
    assert "2 scanned, 1 changed, 1 unchanged" in capsys.readouterr().err


def test_refresh_command_reports_partial_lookup_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    async def refresh(*args: object, **options: object) -> RefreshReport:
        return RefreshReport(scanned=1, changed=1, lookup_failures=1)

    monkeypatch.setattr(cli, "database_url", lambda: "test-db")
    monkeypatch.setattr(cli, "refresh_documents", refresh)
    assert main(["refresh"]) == 1


@pytest.mark.parametrize(("mode", "match_all"), [("and", True), ("or", False)])
def test_the_words_of_an_arxiv_query_filter_cited_papers(mode: str, match_all: bool) -> None:
    arguments = parser().parse_args(["arxiv", "prostate cancer", "--query-mode", mode])

    _requests, options = requests_from_args(arguments)

    assert options.topic_terms == ("prostate", "cancer")
    assert options.match_all_terms is match_all


def test_min_citations_is_one_unless_asked_for() -> None:
    _seeds, options = requests_from_args(parser().parse_args(["pubmed", "prostate cancer"]))
    assert options.min_citations == 1

    _seeds, options = requests_from_args(
        parser().parse_args(["arxiv", "prostate cancer", "--min-citations", "2"])
    )
    assert options.min_citations == 2


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


def test_known_arxiv_ids_lose_their_version(tmp_path: Path) -> None:
    known = tmp_path / "known.jsonl"
    record = json.dumps({"id": "arxiv:hep-th/9901001v1"})
    known.write_text(f"arxiv:2101.00001v2\narxiv:2101.00002\n{record}\n", encoding="utf-8")

    _requests, options = requests_from_args(
        parser().parse_args(["arxiv", "prostate cancer", "--known-ids", str(known)])
    )

    assert options.known_ids == {"arxiv:2101.00001", "arxiv:2101.00002", "arxiv:hep-th/9901001"}


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


def test_quotes_in_an_arxiv_query_are_not_part_of_the_filter_words() -> None:
    arguments = parser().parse_args(["arxiv", '"prostate cancer" biopsy'])

    _requests, options = requests_from_args(arguments)

    assert options.topic_terms == ("prostate", "cancer", "biopsy")


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["pubmed", "q", "--max-results", "0"], "--max-results: must be from 1 to 10000, got 0"),
        (["pubmed", "q", "--max-results", "abc"], "--max-results: not a whole number: 'abc'"),
        (["arxiv", "q", "--max-depth", "-1"], "--max-depth: must be >= 0, got -1"),
        (["zenodo", "q", "--max-requests", "0"], "--max-requests: must be >= 1, got 0"),
        (["zenodo", "   "], "argument query: must not be blank"),
        (["youtube", " "], "argument channel: not a YouTube channel: ' '"),
        (["youtube", "https://www.youtube.com/watch?v=x"], "argument channel: not a channel URL"),
        (["pubmed", "q", "--since", "5.11.2026"], "--since: expected YYYY-MM-DD or auto"),
    ],
)
def test_bad_numbers_and_blank_inputs_are_usage_errors(
    capsys: pytest.CaptureFixture[str], argv: list[str], message: str
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        parser().parse_args(argv)

    assert exit_info.value.code == 2
    assert message in capsys.readouterr().err


def test_invalid_requests_are_usage_errors_without_the_pydantic_dump(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["zenodo", "title:(prostate", "--query-mode", "raw"])

    assert exit_info.value.code == 2
    error = capsys.readouterr().err
    assert "crawler zenodo: error: broken raw query: unclosed '('" in error
    assert "pydantic" not in error and "input_value" not in error


def test_a_query_of_lone_symbols_is_a_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["arxiv", "- &"])

    assert exit_info.value.code == 2
    assert "crawler arxiv: error: query has no words to search for" in capsys.readouterr().err


def test_known_ids_files_may_start_with_a_byte_order_mark(tmp_path: Path) -> None:
    known = tmp_path / "known.txt"
    known.write_text("\ufeffpubmed:1\npubmed:2\n", encoding="utf-8")

    _requests, options = requests_from_args(
        parser().parse_args(["pubmed", "prostate cancer", "--known-ids", str(known)])
    )

    assert options.known_ids == {"pubmed:1", "pubmed:2"}


def test_raw_arxiv_queries_have_no_topic_filter() -> None:
    arguments = parser().parse_args(["arxiv", 'ti:"prostate"', "--query-mode", "raw"])

    _requests, options = requests_from_args(arguments)

    assert options.topic_terms == ()


@pytest.mark.parametrize(
    "argv",
    [
        ["pubmed"],
        ["pubmed", "prostate cancer", "--topic", "prostate_cancer"],
        ["pubmed", "prostate cancer", "--all-topics"],
        ["pubmed", "--topic", "prostate_cancer", "--all-topics"],
        ["youtube"],
    ],
)
def test_a_query_and_a_topic_are_mutually_exclusive_and_one_is_required(argv: list[str]) -> None:
    with pytest.raises(SystemExit) as exit_info:
        parser().parse_args(argv)

    assert exit_info.value.code == 2


def test_all_topics_seed_every_topic_file_with_seeds_for_the_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "demo_topic.yaml").write_text(TOPIC, encoding="utf-8")
    (tmp_path / "demo_field.yaml").write_text(FIELD, encoding="utf-8")
    monkeypatch.setattr(seeds, "TOPICS_DIR", tmp_path)

    papers, options = requests_from_args(parser().parse_args(["pubmed", "--all-topics"]))
    videos, _options = requests_from_args(parser().parse_args(["youtube", "--all-topics"]))

    assert [(request.query, request.topics) for request in papers] == [
        ("prostate cancer", ["demo_topic"]),
        ("prostate cancer biopsy", ["demo_topic"]),
    ]
    assert options.topic_terms == ("prostate cancer",)
    assert [request.topics for request in videos] == [["demo_field"], ["demo_topic"]]


def test_since_takes_a_date_or_auto() -> None:
    assert parser().parse_args(["pubmed", "q", "--since", "2026-11-05"]).since == date(2026, 11, 5)
    assert parser().parse_args(["pubmed", "q", "--since", "auto"]).since == "auto"


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

    assert [request.channel for request in requests] == [
        "https://www.youtube.com/channel/UCdemo0000000000000000ab"
    ]
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
        _seeds: Iterable[ScrapeRequest], *, options: CollectionOptions, **_factories: object
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
    assert "0 queued for lookup" in output.err


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


def test_a_run_stopped_at_max_requests_exits_with_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stats = CollectionStats(documents=1, unprocessed_requests=2)
    result = CollectionResult(documents=[document()], stats=stats)
    monkeypatch.setattr(cli, "run_requests", fake_run(result))

    exit_code = main(["pubmed", "prostate cancer", "--max-requests", "1"])

    assert exit_code == 1
    assert "stopped at --max-requests: 2 request(s) not processed" in capsys.readouterr().err


def test_the_summary_counts_the_references_to_papers_cited_too_rarely(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stats = CollectionStats(documents=1, references_found=9, skipped_rarely_cited=7)
    result = CollectionResult(documents=[document()], stats=stats)
    monkeypatch.setattr(cli, "run_requests", fake_run(result))

    assert main(["pubmed", "prostate cancer", "--min-citations", "2"]) == 0
    assert "0 invalid, 7 cited too rarely, 0 off-topic" in capsys.readouterr().err


def test_seeds_that_reached_max_results_are_listed_but_do_not_fail_the_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    result = CollectionResult(
        documents=[document()],
        stats=CollectionStats(documents=1, max_results_reached=1),
        max_results_reached=["prostate cancer"],
    )
    monkeypatch.setattr(cli, "run_requests", fake_run(result))

    exit_code = main(["pubmed", "prostate cancer", "--since", "2026-11-05", "--max-results", "1"])

    assert exit_code == 0
    assert (
        "reached --max-results: prostate cancer; older results of the --since period may be "
        "missing" in capsys.readouterr().err
    )


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


class FakeStore:
    """Stands in for the database calls of `main` and records them in order."""

    def __init__(
        self,
        result: CollectionResult,
        *,
        stored: frozenset[str] = frozenset(),
        last_runs: dict[str, datetime] | None = None,
        done: frozenset[str] = frozenset(),
        prepare_error: str | None = None,
        save_error: str | None = None,
        save_errors: int | None = None,
        refresh: tuple[int, list[SourceDocument]] = (0, []),
        refresh_error: Exception | None = None,
        results: Sequence[CollectionResult] = (),
    ) -> None:
        self.result = result
        self.results = list(results)
        """The results of the first runs, one per topic; later runs return `result`."""
        self.stored = stored
        self.last_runs = last_runs or {}
        self.done = done
        self.prepare_error = prepare_error
        self.save_error = save_error
        self.save_errors = save_errors
        """How many store attempts fail with `save_error`; None: all of them."""
        self.refresh = refresh
        self.refresh_error = refresh_error
        self.calls: list[str] = []
        self.load_ids: bool | None = None
        self.resumed: list[str] | None = None
        self.sleeps: list[float] = []
        # Of every run, one per topic; `seeds`, `options` and `run` are those of the last one.
        self.parts: list[list[ScrapeRequest]] = []
        self.part_options: list[CollectionOptions] = []
        self.factories: list[tuple[Callable[[SourceName], object], ...]] = []
        """Of every run: what gives it the scraper and the link extractor of a source."""
        self.runs: list[RunInfo] = []
        self.expire: list[bool] = []
        """Of every stored run: whether its store deletes the expired rows."""
        self.refreshed: list[SourceDocument] | None = None

    @property
    def seeds(self) -> list[ScrapeRequest]:
        return self.parts[-1] if self.parts else []

    @property
    def options(self) -> CollectionOptions | None:
        return self.part_options[-1] if self.part_options else None

    @property
    def run(self) -> RunInfo | None:
        return self.runs[-1] if self.runs else None

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(cli, "database_url", lambda: "postgresql://test/db")
        monkeypatch.setattr(cli, "prepare_store", self.prepare_store)
        monkeypatch.setattr(cli, "last_successful_runs", self.last_successful_runs)
        monkeypatch.setattr(cli, "stored_topics", self.stored_topics)
        monkeypatch.setattr(cli, "run_requests", self.run_requests)
        monkeypatch.setattr(cli, "refresh_videos", self.refresh_videos)
        monkeypatch.setattr(cli, "save_result", self.save_result)
        monkeypatch.setattr(cli.time, "sleep", self.sleeps.append)

    async def prepare_store(
        self, _url: str, _source: SourceName, *, load_ids: bool
    ) -> frozenset[str]:
        self.calls.append("prepare")
        self.load_ids = load_ids
        if self.prepare_error is not None:
            raise StoreError(self.prepare_error)
        return self.stored

    async def last_successful_runs(
        self, _url: str, _source: SourceName, topics: Sequence[str]
    ) -> dict[str, datetime]:
        self.calls.append("last_runs")
        return {topic: start for topic, start in self.last_runs.items() if topic in topics}

    async def stored_topics(
        self, _url: str, _source: SourceName, arguments: Sequence[str]
    ) -> frozenset[str]:
        self.calls.append("stored_topics")
        self.resumed = list(arguments)
        return self.done

    async def run_requests(
        self,
        seeds: Iterable[ScrapeRequest],
        *,
        options: CollectionOptions,
        source_factory: Callable[[SourceName], object],
        link_extractor_factory: Callable[[SourceName], object],
    ) -> CollectionResult:
        self.calls.append("run")
        self.parts.append(list(seeds))
        self.part_options.append(options)
        self.factories.append((source_factory, link_extractor_factory))
        return self.results.pop(0) if self.results else self.result

    async def refresh_videos(
        self, _url: str, _seeds: Sequence[ScrapeRequest], _result: CollectionResult
    ) -> tuple[int, list[SourceDocument]]:
        self.calls.append("refresh")
        if self.refresh_error is not None:
            raise self.refresh_error
        return self.refresh

    async def save_result(
        self,
        _url: str,
        _result: CollectionResult,
        run: RunInfo,
        *,
        refreshed: Sequence[SourceDocument] = (),
        expire: bool = True,
    ) -> StoreReport:
        self.calls.append("save")
        self.refreshed = list(refreshed)
        if self.save_error is not None and self.save_errors != 0:
            if self.save_errors is not None:
                self.save_errors -= 1
            raise StoreError(self.save_error)
        self.runs.append(run)
        self.expire.append(expire)
        return StoreReport(run_id=7, inserted=1, changed=0, unchanged=0, cited=2, expired=0)


@pytest.mark.parametrize(
    "argv",
    [
        ["pubmed", "q"],
        ["arxiv", "q"],
        ["zenodo", "q"],
        ["youtube", "@NationalCancerInstitute"],
        ["podcast", "jco"],
    ],
)
def test_every_subcommand_takes_store(argv: list[str]) -> None:
    assert parser().parse_args([*argv, "--store"]).store
    assert not parser().parse_args(argv).store


def test_main_without_store_never_touches_the_database(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def forbidden(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("the database must not be used without --store")

    monkeypatch.setattr(cli, "run_requests", fake_run(CollectionResult(documents=[document()])))
    for name in ("database_url", "prepare_store", "last_successful_runs", "save_result"):
        monkeypatch.setattr(cli, name, forbidden)

    assert main(["pubmed", "prostate cancer"]) == 0
    assert "stored" not in capsys.readouterr().err


def test_main_with_store_checks_first_then_crawls_then_stores(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    topic = tmp_path / "demo_topic.yaml"
    topic.write_text(TOPIC, encoding="utf-8")
    fake = FakeStore(CollectionResult(documents=[document()], stats=CollectionStats(documents=1)))
    fake.install(monkeypatch)

    exit_code = main(["pubmed", "--topic", str(topic), "--store"])

    output = capsys.readouterr()
    assert exit_code == 0
    assert fake.calls == ["prepare", "run", "save"]
    assert [json.loads(line)["id"] for line in output.out.splitlines()] == ["pubmed:1"]
    assert (
        "stored (run 7): 1 new, 0 changed, 0 unchanged; 2 stored document(s) newly cited; "
        "0 expired deleted" in output.err
    )
    assert fake.run is not None
    assert fake.run.source is SourceName.PUBMED
    assert fake.run.topics == ["demo_topic"]
    assert fake.run.arguments == ["pubmed", "--topic", str(topic), "--store"]
    assert fake.run.started_at <= fake.run.finished_at
    assert fake.expire == [True]


def test_since_auto_starts_two_days_before_the_last_successful_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    topic = tmp_path / "demo_topic.yaml"
    topic.write_text(TOPIC, encoding="utf-8")
    fake = FakeStore(
        CollectionResult(documents=[]),
        last_runs={"demo_topic": datetime(2026, 11, 7, 3, 0, tzinfo=UTC)},
    )
    fake.install(monkeypatch)
    argv = ["pubmed", "--topic", str(topic), "--since", "auto", "--store"]

    assert main(argv) == 0

    assert fake.calls == ["prepare", "last_runs", "run", "save"]
    assert [seed.since for seed in fake.seeds] == [date(2026, 11, 5), date(2026, 11, 5)]
    assert fake.run is not None
    assert fake.run.arguments == argv
    assert "since auto: 2026-11-05" in capsys.readouterr().err


def test_since_auto_runs_a_topic_without_a_successful_run_without_a_date(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    topic = tmp_path / "demo_topic.yaml"
    topic.write_text(TOPIC, encoding="utf-8")
    fake = FakeStore(CollectionResult(documents=[]))
    fake.install(monkeypatch)

    assert main(["pubmed", "--topic", str(topic), "--since", "auto", "--store"]) == 0

    assert fake.calls == ["prepare", "last_runs", "run", "save"]
    assert [seed.since for seed in fake.seeds] == [None, None]
    assert "since auto: no successful run yet, so no date" in capsys.readouterr().err


def test_since_auto_dates_each_seed_by_its_own_topics(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    known = tmp_path / "demo_topic.yaml"
    known.write_text(TOPIC, encoding="utf-8")
    new = tmp_path / "new_topic.yaml"
    new.write_text(
        "id: new_topic\nlabel: New topic\nterms: [prostate cancer]\n"
        "queries: [prostate cancer, prostate cancer screening]\n",
        encoding="utf-8",
    )
    fake = FakeStore(
        CollectionResult(documents=[]),
        last_runs={"demo_topic": datetime(2026, 11, 7, 3, 0, tzinfo=UTC)},
    )
    fake.install(monkeypatch)

    argv = ["pubmed", "--topic", str(known), "--topic", str(new), "--since", "auto", "--store"]
    assert main(argv) == 0

    # The query the topics share runs once for each of them, from its own date.
    assert [{seed.query: seed.since for seed in part} for part in fake.parts] == [
        {"prostate cancer": date(2026, 11, 5), "prostate cancer biopsy": date(2026, 11, 5)},
        {"prostate cancer": None, "prostate cancer screening": None},
    ]
    assert (
        "since auto: 2026-11-05; 2 seed(s) of topics without a successful run: no date"
        in capsys.readouterr().err
    )


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["pubmed", "--all-topics", "--since", "auto"], "--since auto needs --store"),
        (["pubmed", "q", "--since", "auto", "--store"], "needs --topic or --all-topics"),
    ],
)
def test_since_auto_needs_store_and_topics(
    argv: list[str],
    message: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fake = FakeStore(CollectionResult(documents=[]))
    fake.install(monkeypatch)

    with pytest.raises(SystemExit) as exit_info:
        main(argv)

    assert exit_info.value.code == 2
    assert message in capsys.readouterr().err
    assert fake.calls == []


def test_stored_ids_join_the_known_ids_when_references_are_followed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    known = tmp_path / "known.txt"
    known.write_text("pubmed:2\n", encoding="utf-8")
    fake = FakeStore(CollectionResult(documents=[]), stored=frozenset({"pubmed:3"}))
    fake.install(monkeypatch)

    main(["pubmed", "q", "--known-ids", str(known), "--store"])

    assert fake.load_ids is True
    assert fake.options is not None
    assert fake.options.known_ids == {"pubmed:2", "pubmed:3"}


@pytest.mark.parametrize("argv", [["pubmed", "q", "--max-depth", "0"], ["podcast", "jco"]])
def test_stored_ids_are_not_loaded_without_references(
    argv: list[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeStore(CollectionResult(documents=[]))
    fake.install(monkeypatch)

    main([*argv, "--store"])

    assert fake.load_ids is False


def test_a_missing_database_url_is_a_usage_error_before_the_crawl(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(CollectionResult(documents=[]))
    fake.install(monkeypatch)

    def missing() -> str:
        raise StoreError("DATABASE_URL is not set")

    monkeypatch.setattr(cli, "database_url", missing)

    with pytest.raises(SystemExit) as exit_info:
        main(["pubmed", "q", "--store"])

    assert exit_info.value.code == 2
    assert "DATABASE_URL is not set" in capsys.readouterr().err
    assert fake.calls == []


def test_a_database_without_the_schema_is_a_usage_error_before_the_crawl(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(
        CollectionResult(documents=[]), prepare_error="the database has no documents table"
    )
    fake.install(monkeypatch)

    with pytest.raises(SystemExit) as exit_info:
        main(["pubmed", "q", "--store"])

    assert exit_info.value.code == 2
    assert "the database has no documents table" in capsys.readouterr().err
    assert fake.calls == ["prepare"]


def test_a_failed_store_still_prints_the_documents_and_exits_with_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(
        CollectionResult(documents=[document()]), save_error="cannot write to the database"
    )
    fake.install(monkeypatch)

    exit_code = main(["pubmed", "q", "--store"])

    output = capsys.readouterr()
    assert exit_code == 1
    assert fake.calls == ["prepare", "run", *["save"] * 5]
    assert fake.sleeps == [5, 15, 30, 60]
    assert [json.loads(line)["id"] for line in output.out.splitlines()] == ["pubmed:1"]
    assert "storing failed: cannot write to the database; trying again in 5 s" in output.err
    assert output.err.rstrip().endswith("storing failed: cannot write to the database")


def test_storing_is_tried_again_while_the_database_is_away(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(
        CollectionResult(documents=[document()]),
        save_error="cannot connect to the database",
        save_errors=2,
    )
    fake.install(monkeypatch)

    assert main(["pubmed", "q", "--store"]) == 0

    assert fake.calls == ["prepare", "run", "save", "save", "save"]
    assert fake.sleeps == [5, 15]
    assert "stored (run 7)" in capsys.readouterr().err


def test_runs_with_failures_are_stored_and_exit_with_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    failure = RequestFailure(
        kind="search",
        source=SourceName.PUBMED,
        detail="q",
        depth=0,
        error="HTTPError: HTTP Error 500",
        retries=3,
        retryable=True,
    )
    fake = FakeStore(CollectionResult(documents=[document()], failures=[failure]))
    fake.install(monkeypatch)

    exit_code = main(["pubmed", "q", "--store"])

    assert exit_code == 1
    assert fake.calls == ["prepare", "run", "save"]
    assert "stored (run 7)" in capsys.readouterr().err


TOPIC_FILES = {
    "alpha": "terms: [alpha]\nqueries: [alpha, shared]\n",
    "beta": "terms: [beta]\nqueries: [beta, shared]\n",
    "gamma": "terms: [gamma]\nqueries: [gamma]\n",
}


def topic_arguments(directory: Path) -> list[str]:
    """`--topic` for three topic files in `directory`; alpha and beta share a query."""
    arguments: list[str] = []
    for topic_id, content in TOPIC_FILES.items():
        path = directory / f"{topic_id}.yaml"
        path.write_text(f"id: {topic_id}\nlabel: {topic_id}\n{content}", encoding="utf-8")
        arguments += ["--topic", str(path)]
    return arguments


def test_a_store_run_over_several_topics_crawls_and_stores_them_one_by_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(CollectionResult(documents=[document()]))
    fake.install(monkeypatch)
    argv = ["pubmed", *topic_arguments(tmp_path), "--store"]

    assert main(argv) == 0

    assert fake.calls == ["prepare", "run", "save", "run", "save", "run", "save"]
    # The query two topics share runs for each of them, under that topic alone.
    assert [[(seed.query, seed.topics) for seed in part] for part in fake.parts] == [
        [("alpha", ["alpha"]), ("shared", ["alpha"])],
        [("shared", ["beta"]), ("beta", ["beta"])],
        [("gamma", ["gamma"])],
    ]
    assert [run.topics for run in fake.runs] == [["alpha"], ["beta"], ["gamma"]]
    assert all(run.arguments == argv for run in fake.runs)
    # Each topic keeps the cited papers with a term of its own.
    assert [options.topic_terms for options in fake.part_options] == [
        ("alpha",),
        ("beta",),
        ("gamma",),
    ]
    output = capsys.readouterr()
    assert len(output.out.splitlines()) == 3
    assert "topic 2 of 3: beta" in output.err
    assert output.err.rstrip().endswith("3 of 3 topic(s) crawled, 3 without failures")


def test_several_topics_without_store_stay_one_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeStore(CollectionResult(documents=[document()]))
    fake.install(monkeypatch)

    assert main(["pubmed", *topic_arguments(tmp_path)]) == 0

    assert fake.calls == ["run"]
    assert [(seed.query, seed.topics) for seed in fake.seeds] == [
        ("alpha", ["alpha"]),
        ("shared", ["alpha", "beta"]),
        ("beta", ["beta"]),
        ("gamma", ["gamma"]),
    ]
    assert fake.options is not None
    assert fake.options.topic_terms == ("alpha", "beta", "gamma")


def test_later_topics_do_not_fetch_what_earlier_ones_stored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeStore(
        CollectionResult(documents=[]),
        results=[CollectionResult(documents=[document()])],
        stored=frozenset({"pubmed:5"}),
    )
    fake.install(monkeypatch)
    argv = ["pubmed", *topic_arguments(tmp_path), "--store", "--min-citations", "2"]

    assert main(argv) == 0

    alpha, beta, gamma = fake.part_options
    assert alpha.known_ids == {"pubmed:5"}
    assert beta.known_ids == gamma.known_ids == {"pubmed:5", "pubmed:1"}
    assert [options.min_citations for options in fake.part_options] == [2, 2, 2]


def test_the_topics_of_a_store_run_share_one_scraper_which_keeps_the_pace_of_its_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeStore(CollectionResult(documents=[]))
    fake.install(monkeypatch)
    created: list[str] = []

    def creates(kind: str) -> Callable[[SourceName], object]:
        def create(_source: SourceName) -> object:
            created.append(kind)
            return object()

        return create

    monkeypatch.setattr(cli, "source_from_env", creates("scraper"))
    monkeypatch.setattr(cli, "link_extractor_from_env", creates("link extractor"))

    assert main(["arxiv", *topic_arguments(tmp_path), "--store"]) == 0

    # arXiv asks for three seconds between two requests. A scraper of its own per topic would
    # not know the last request of the topic before, and send its first one at once.
    assert len(fake.factories) == 3
    scrapers = [sources(SourceName.ARXIV) for sources, _ in fake.factories]
    link_extractors = [links(SourceName.ARXIV) for _, links in fake.factories]
    assert scrapers[0] is scrapers[1] is scrapers[2]
    assert link_extractors[0] is link_extractors[1] is link_extractors[2]
    assert created == ["scraper", "link extractor"]


def test_only_the_last_topic_of_a_store_run_deletes_the_expired_rows(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeStore(CollectionResult(documents=[document()]))
    fake.install(monkeypatch)

    assert main(["pubmed", *topic_arguments(tmp_path), "--store"]) == 0

    # An earlier topic would delete the expired videos of the topics after it, before those
    # fetched them again.
    assert fake.expire == [False, False, True]


def failed_search() -> RequestFailure:
    return RequestFailure(
        kind="search",
        source=SourceName.PUBMED,
        detail="alpha",
        depth=0,
        error="HTTPError: HTTP Error 500",
        retries=3,
        retryable=True,
    )


def test_a_topic_with_failures_does_not_stop_the_others(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(
        CollectionResult(documents=[]),
        results=[CollectionResult(documents=[document()], failures=[failed_search()])],
    )
    fake.install(monkeypatch)

    assert main(["pubmed", *topic_arguments(tmp_path), "--store"]) == 1

    assert [run.topics for run in fake.runs] == [["alpha"], ["beta"], ["gamma"]]
    assert capsys.readouterr().err.rstrip().endswith("3 of 3 topic(s) crawled, 2 without failures")


def test_resume_skips_the_topics_the_same_command_has_stored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(CollectionResult(documents=[]), done=frozenset({"alpha", "gamma"}))
    fake.install(monkeypatch)
    argv = ["pubmed", *topic_arguments(tmp_path), "--store", "--resume"]

    assert main(argv) == 0

    assert fake.calls == ["prepare", "stored_topics", "run", "save"]
    assert fake.resumed == argv
    assert [run.topics for run in fake.runs] == [["beta"]]
    output = capsys.readouterr().err
    assert "resume: 2 of 3 topic(s) already stored" in output
    assert "topic 1 of 1: beta" in output


def test_resume_with_every_topic_stored_crawls_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(CollectionResult(documents=[]), done=frozenset(TOPIC_FILES))
    fake.install(monkeypatch)

    assert main(["pubmed", *topic_arguments(tmp_path), "--store", "--resume"]) == 0

    assert fake.calls == ["prepare", "stored_topics"]
    assert capsys.readouterr().err.rstrip() == "resume: 3 of 3 topic(s) already stored"


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["pubmed", "--all-topics", "--resume"], "--resume needs --store"),
        (["pubmed", "q", "--store", "--resume"], "--resume needs --topic or --all-topics"),
        (
            ["pubmed", "--all-topics", "--store", "--resume", "--since", "auto"],
            "--since auto continues on its own",
        ),
    ],
)
def test_resume_needs_store_and_topics_and_no_since_auto(
    argv: list[str],
    message: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    fake = FakeStore(CollectionResult(documents=[]))
    fake.install(monkeypatch)

    with pytest.raises(SystemExit) as exit_info:
        main(argv)

    assert exit_info.value.code == 2
    assert message in capsys.readouterr().err
    assert fake.calls == []


def test_a_stopped_crawl_stores_its_topic_and_leaves_the_others(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    stopped = CollectionResult(
        documents=[document()],
        stats=CollectionStats(documents=1, unprocessed_requests=4),
        interrupted=True,
    )
    fake = FakeStore(CollectionResult(documents=[]), results=[stopped])
    fake.install(monkeypatch)

    exit_code = main(["pubmed", *topic_arguments(tmp_path), "--store"])

    assert exit_code == 130
    assert fake.calls == ["prepare", "run", "save"]
    assert [run.topics for run in fake.runs] == [["alpha"]]
    output = capsys.readouterr().err
    assert "interrupted: 4 request(s) not processed" in output
    assert output.rstrip().endswith(
        "1 of 3 topic(s) crawled, 0 without failures; stopped: interrupted"
    )


def test_ctrl_c_outside_a_crawl_exits_with_130(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(CollectionResult(documents=[document()]))
    fake.install(monkeypatch)

    async def save_result(*_arguments: object, **_options: object) -> StoreReport:
        raise KeyboardInterrupt

    monkeypatch.setattr(cli, "save_result", save_result)

    assert main(["pubmed", "q", "--store"]) == 130
    assert capsys.readouterr().err.rstrip().endswith("interrupted")


def test_a_database_that_stays_away_stops_the_crawl(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    fake = FakeStore(
        CollectionResult(documents=[document()]), save_error="cannot connect to the database"
    )
    fake.install(monkeypatch)

    assert main(["pubmed", *topic_arguments(tmp_path), "--store"]) == 1

    # The second topic is not crawled: it could not be stored either.
    assert fake.calls == ["prepare", "run", *["save"] * 5]
    assert (
        capsys.readouterr()
        .err.rstrip()
        .endswith("1 of 3 topic(s) crawled, 0 without failures; stopped: storing failed")
    )


def test_max_requests_caps_the_whole_crawl_not_each_topic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def requests(finished: int, failed: int = 0) -> CollectionResult:
        stats = CollectionStats(finished_requests=finished, failed_requests=failed)
        return CollectionResult(documents=[], stats=stats)

    fake = FakeStore(CollectionResult(documents=[]), results=[requests(2), requests(2, 1)])
    fake.install(monkeypatch)

    exit_code = main(["pubmed", *topic_arguments(tmp_path), "--store", "--max-requests", "5"])

    assert exit_code == 1
    assert [options.max_requests for options in fake.part_options] == [5, 3]
    assert (
        capsys.readouterr()
        .err.rstrip()
        .endswith("2 of 3 topic(s) crawled, 2 without failures; stopped: --max-requests")
    )


def video(native_id: str) -> SourceDocument:
    return SourceDocument(
        id=f"youtube:{native_id}",
        source=SourceName.YOUTUBE,
        content_type="video",
        source_id=native_id,
        title="Treatment update",
        url=f"https://www.youtube.com/watch?v={native_id}",
    )


def test_youtube_store_runs_store_the_refreshed_videos_too(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    old = video("old")
    fake = FakeStore(CollectionResult(documents=[video("new")]), refresh=(2, [old]))
    fake.install(monkeypatch)

    exit_code = main(["youtube", "@NationalCancerInstitute", "--store"])

    assert exit_code == 0
    assert fake.calls == ["prepare", "run", "refresh", "save"]
    assert fake.refreshed == [old]
    assert "refreshed 1 of 2 stored video(s) that expire within 15 days" in capsys.readouterr().err


def test_a_failed_refresh_still_stores_the_run_and_exits_with_1(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    error = RuntimeError("quotaExceeded: https://www.googleapis.com/youtube/v3/videos?key=SECRET")
    fake = FakeStore(CollectionResult(documents=[video("new")]), refresh_error=error)
    fake.install(monkeypatch)

    exit_code = main(["youtube", "@NationalCancerInstitute", "--store"])

    output = capsys.readouterr()
    assert exit_code == 1
    assert fake.calls == ["prepare", "run", "refresh", "save"]
    assert fake.refreshed == []
    assert "refreshing stored videos failed: RuntimeError: quotaExceeded" in output.err
    assert "SECRET" not in output.err
    assert "stored (run 7)" in output.err


def youtube_api(handles: dict[str, str], items: list[dict[str, Any]]) -> Any:
    """The Data API calls of `refresh_videos`: channels.list by handle, videos.list by ID."""
    by_id = {item["id"]: item for item in items}

    def channels(part: str, forHandle: str) -> SimpleNamespace:
        found = [{"id": handles[forHandle]}] if forHandle in handles else []
        return SimpleNamespace(execute=lambda: {"items": found})

    def videos(part: str, id: str) -> SimpleNamespace:
        found = [by_id[video_id] for video_id in id.split(",") if video_id in by_id]
        return SimpleNamespace(execute=lambda: {"items": found})

    return SimpleNamespace(
        channels=lambda: SimpleNamespace(list=channels),
        videos=lambda: SimpleNamespace(list=videos),
    )


def test_refresh_videos_fetches_the_due_videos_of_the_channels_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    channel_id = "UC" + "a" * 22
    asked: list[list[str]] = []

    async def videos_to_refresh(_url: str, channel_ids: Sequence[str]) -> list[str]:
        asked.append(list(channel_ids))
        return ["old", "new", "private"]

    monkeypatch.setattr(cli, "videos_to_refresh", videos_to_refresh)
    talk = "Eine Ärztin erklärt die Nachsorge nach der Bestrahlung der Prostata."
    items = [
        {
            "id": video_id,
            "snippet": {"title": video_id, "description": talk},
            "status": {"privacyStatus": privacy},
        }
        for video_id, privacy in [("old", "public"), ("new", "public"), ("private", "private")]
    ]
    scraper = YouTubeScraper("", service=youtube_api({"medical": "UCmedical"}, items))
    channels = [f"https://www.youtube.com/channel/{channel_id}", "@medical", "@gone"]
    seeds = [ScrapeRequest(source=SourceName.YOUTUBE, channel=channel) for channel in channels]
    result = CollectionResult(documents=[video("new")])

    due, refreshed = asyncio.run(cli.refresh_videos("postgresql://test/db", seeds, result, scraper))

    assert asked == [[channel_id, "UCmedical"]]
    assert due == 2
    assert [document.id for document in refreshed] == ["youtube:old"]
    # Marked like the documents of a run, so a refresh does not count as a change.
    assert refreshed[0].extra["metadata_language"] == "de"


def test_json_lines_are_utf8_whatever_the_encoding_of_stdout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    greek = document().model_copy(update={"title": "γ-H2AX foci"})
    monkeypatch.setattr(cli, "run_requests", fake_run(CollectionResult(documents=[greek])))
    buffer = io.BytesIO()
    stdout = io.TextIOWrapper(buffer, encoding="cp1252")
    monkeypatch.setattr(sys, "stdout", stdout)

    assert main(["pubmed", "q"]) == 0

    stdout.flush()
    assert json.loads(buffer.getvalue().decode("utf-8"))["title"] == "γ-H2AX foci"
