import io
import json
import sys
from collections.abc import Iterable, Sequence
from datetime import UTC, date, datetime
from pathlib import Path

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
from crawler.runner import CollectionOptions
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


@pytest.mark.parametrize(("mode", "match_all"), [("and", True), ("or", False)])
def test_the_words_of_an_arxiv_query_filter_cited_papers(mode: str, match_all: bool) -> None:
    arguments = parser().parse_args(["arxiv", "prostate cancer", "--query-mode", mode])

    _requests, options = requests_from_args(arguments)

    assert options.topic_terms == ("prostate", "cancer")
    assert options.match_all_terms is match_all


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
        prepare_error: str | None = None,
        save_error: str | None = None,
    ) -> None:
        self.result = result
        self.stored = stored
        self.last_runs = last_runs or {}
        self.prepare_error = prepare_error
        self.save_error = save_error
        self.calls: list[str] = []
        self.load_ids: bool | None = None
        self.seeds: list[ScrapeRequest] = []
        self.options: CollectionOptions | None = None
        self.run: RunInfo | None = None

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(cli, "database_url", lambda: "postgresql://test/db")
        monkeypatch.setattr(cli, "prepare_store", self.prepare_store)
        monkeypatch.setattr(cli, "last_successful_runs", self.last_successful_runs)
        monkeypatch.setattr(cli, "run_requests", self.run_requests)
        monkeypatch.setattr(cli, "save_result", self.save_result)

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

    async def run_requests(
        self, seeds: Iterable[ScrapeRequest], *, options: CollectionOptions
    ) -> CollectionResult:
        self.calls.append("run")
        self.seeds = list(seeds)
        self.options = options
        return self.result

    async def save_result(self, _url: str, _result: CollectionResult, run: RunInfo) -> StoreReport:
        self.calls.append("save")
        self.run = run
        if self.save_error is not None:
            raise StoreError(self.save_error)
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


def test_since_auto_needs_a_successful_run_of_every_topic(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    topic = tmp_path / "demo_topic.yaml"
    topic.write_text(TOPIC, encoding="utf-8")
    fake = FakeStore(CollectionResult(documents=[]))
    fake.install(monkeypatch)

    with pytest.raises(SystemExit) as exit_info:
        main(["pubmed", "--topic", str(topic), "--since", "auto", "--store"])

    assert exit_info.value.code == 2
    assert "no successful run with --store yet for demo_topic" in capsys.readouterr().err
    assert fake.calls == ["prepare", "last_runs"]


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
    assert fake.calls == ["prepare", "run", "save"]
    assert [json.loads(line)["id"] for line in output.out.splitlines()] == ["pubmed:1"]
    assert "storing failed: cannot write to the database" in output.err


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
