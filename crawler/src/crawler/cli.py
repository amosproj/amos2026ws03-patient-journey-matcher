import argparse
import asyncio
import io
import json
import logging
import sys
from collections.abc import Callable, Sequence
from datetime import UTC, date, datetime
from pathlib import Path
from typing import NoReturn

from pydantic import ValidationError

from crawler.models import (
    MAX_RESULTS,
    CollectionResult,
    ScrapeRequest,
    SourceName,
    source_document_id,
    validation_message,
)
from crawler.queries import query_words
from crawler.runner import CollectionOptions, CollectionSetupError, run_requests
from crawler.seeds import TopicFileError, find_podcast, load_topic, seed_requests, topic_terms
from crawler.sources.arxiv import split_version
from crawler.sources.youtube import channel_lookup
from crawler.store import (
    RunInfo,
    StoreError,
    StoreReport,
    database_url,
    prepare_store,
    save_result,
)

SINCE_HELP = {
    SourceName.PUBMED: "only search results PubMed added since this date (YYYY-MM-DD); "
    "cited papers are not filtered",
    SourceName.ARXIV: "only search results submitted since this date (YYYY-MM-DD); "
    "cited papers are not filtered",
    SourceName.ZENODO: "only records added or changed since this date (YYYY-MM-DD)",
    SourceName.YOUTUBE: "only videos published since this date (YYYY-MM-DD)",
    SourceName.PODCAST: "only episodes published since this date (YYYY-MM-DD)",
}
KNOWN_IDS_HELP = (
    "IDs of stored documents, one per line (pubmed:12345) or the JSON Lines output of a run; "
    "cited papers among them are not fetched again"
)
QUERY_MODE_HELP = (
    "and: every word, or: any word (quotes, backslashes and lone symbols are ignored); "
    "raw: the source's own query syntax"
)
STORE_HELP = "also upsert the documents into PostgreSQL (DATABASE_URL) and log the run"
STORE_REFERENCES_HELP = f"{STORE_HELP}; cited papers stored before are not fetched again"


def whole_number(minimum: int, maximum: int | None = None) -> Callable[[str], int]:
    """An argparse type for a whole number within bounds."""

    def parse(value: str) -> int:
        try:
            number = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"not a whole number: {value!r}") from None
        if number < minimum or (maximum is not None and number > maximum):
            bounds = f"from {minimum} to {maximum}" if maximum is not None else f">= {minimum}"
            raise argparse.ArgumentTypeError(f"must be {bounds}, got {number}")
        return number

    return parse


def non_blank(value: str) -> str:
    """An argparse type for a query or feed key: not just whitespace."""
    if not value.strip():
        raise argparse.ArgumentTypeError("must not be blank")
    return value.strip()


def youtube_channel(value: str) -> str:
    """An argparse type for a channel reference that the Data API can resolve."""
    try:
        channel_lookup(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError(str(error)) from None
    return value.strip()


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        prog="crawler",
        description=(
            "Collect source metadata as JSON Lines on stdout. A summary of the run goes to "
            "stderr. Exit code 1 means at least one request failed or, with --store, storing "
            "failed."
        ),
    )
    subcommands = command.add_subparsers(dest="source", required=True)

    searches = {
        SourceName.PUBMED: "search PubMed and follow references",
        SourceName.ARXIV: "search arXiv and follow references",
        SourceName.ZENODO: "search Zenodo (papers, posters, presentations, videos)",
    }
    for source, help_text in searches.items():
        paper = subcommands.add_parser(source.value, help=help_text)
        paper.set_defaults(subcommand=paper)
        seeds = paper.add_mutually_exclusive_group(required=True)
        seeds.add_argument("query", nargs="?", type=non_blank, help="one search query")
        _add_topic_argument(seeds)
        _add_max_results_argument(paper, "results per query")
        paper.add_argument("--since", type=date.fromisoformat, help=SINCE_HELP[source])
        if source is not SourceName.ZENODO:
            paper.add_argument(
                "--max-depth",
                type=whole_number(0),
                default=1,
                help="levels of references to follow; 0 collects the search results only",
            )
            paper.add_argument(
                "--known-ids", type=known_ids_file, metavar="FILE", help=KNOWN_IDS_HELP
            )
        _add_max_requests_argument(paper)
        if source is not SourceName.PUBMED:
            paper.add_argument(
                "--query-mode", choices=("and", "or", "raw"), default="and", help=QUERY_MODE_HELP
            )
        _add_store_argument(
            paper, STORE_HELP if source is SourceName.ZENODO else STORE_REFERENCES_HELP
        )

    youtube = subcommands.add_parser(SourceName.YOUTUBE.value, help="list channel videos")
    youtube.set_defaults(subcommand=youtube)
    seeds = youtube.add_mutually_exclusive_group(required=True)
    seeds.add_argument(
        "channel",
        nargs="?",
        type=youtube_channel,
        help="channel ID, channel URL, @handle, or legacy username",
    )
    _add_topic_argument(seeds)
    _add_max_results_argument(youtube, "videos per channel")
    youtube.add_argument("--since", type=date.fromisoformat, help=SINCE_HELP[SourceName.YOUTUBE])
    _add_max_requests_argument(youtube)
    _add_store_argument(youtube, STORE_HELP)

    podcast = subcommands.add_parser(SourceName.PODCAST.value, help="list podcast episodes")
    podcast.set_defaults(subcommand=podcast)
    seeds = podcast.add_mutually_exclusive_group(required=True)
    seeds.add_argument(
        "feed", nargs="?", type=non_blank, help="feed key from a topic file, e.g. jco"
    )
    _add_topic_argument(seeds)
    _add_max_results_argument(podcast, "episodes per feed")
    podcast.add_argument("--since", type=date.fromisoformat, help=SINCE_HELP[SourceName.PODCAST])
    _add_max_requests_argument(podcast)
    _add_store_argument(podcast, STORE_HELP)
    return command


def _add_topic_argument(group: argparse._MutuallyExclusiveGroup) -> None:
    group.add_argument(
        "--topic",
        action="append",
        metavar="ID_OR_PATH",
        help="topic file: an ID from crawler/topics/ or a path to a YAML file; repeatable",
    )


def _add_max_results_argument(command: argparse.ArgumentParser, help_text: str) -> None:
    command.add_argument(
        "--max-results", type=whole_number(1, MAX_RESULTS), default=10, help=help_text
    )


def _add_max_requests_argument(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--max-requests",
        type=whole_number(1),
        help="stop after this many requests (safety cap)",
    )


def _add_store_argument(command: argparse.ArgumentParser, help_text: str) -> None:
    command.add_argument("--store", action="store_true", help=help_text)


def known_ids_file(value: str) -> frozenset[str]:
    """Read a `--known-ids` file; blank lines and lines starting with `#` are skipped."""
    path = Path(value)
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except (OSError, UnicodeDecodeError) as error:
        raise argparse.ArgumentTypeError(f"cannot read {path}: {error}") from error
    ids: set[str] = set()
    for number, line in enumerate(lines, 1):
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        document_id = _document_id(text)
        if document_id is None:
            raise argparse.ArgumentTypeError(
                f"{path}, line {number}: expected a document ID such as pubmed:12345 "
                "or a JSON record with an id"
            )
        ids.add(document_id)
    return frozenset(ids)


def _document_id(line: str) -> str | None:
    """`pubmed:12345`, or the `id` of a JSON record from the output of a run.

    arXiv IDs lose their version, as in the IDs the crawler compares them with; older runs
    wrote `arxiv:2101.00001v2`.
    """
    value: object = line
    if line.startswith("{"):
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            return None
        value = record.get("id") if isinstance(record, dict) else None
    if not isinstance(value, str):
        return None
    source, _, native_id = value.partition(":")
    if source not in SourceName or not native_id:
        return None
    if source == SourceName.ARXIV:
        return source_document_id(SourceName.ARXIV, split_version(native_id)[0])
    return value


def requests_from_args(
    arguments: argparse.Namespace,
) -> tuple[list[ScrapeRequest], CollectionOptions]:
    source = SourceName(arguments.source)
    query_mode: str = getattr(arguments, "query_mode", "and")
    since: date | None = getattr(arguments, "since", None)
    match_all = False
    if arguments.topic:
        topics = [load_topic(reference) for reference in arguments.topic]
        seeds = seed_requests(
            topics,
            source,
            max_results=arguments.max_results,
            since=since,
            query_mode=query_mode,
        )
        terms = topic_terms(topics)
    elif source is SourceName.YOUTUBE:
        seeds = [
            ScrapeRequest(
                source=source,
                channel=arguments.channel,
                max_results=arguments.max_results,
                since=since,
            )
        ]
        terms = []
    elif source is SourceName.PODCAST:
        feed, _topic_ids = find_podcast(arguments.feed)
        seeds = [
            ScrapeRequest(source=source, feed=feed, max_results=arguments.max_results, since=since)
        ]
        terms = []
    else:
        seeds = [
            ScrapeRequest(
                source=source,
                query=arguments.query,
                max_results=arguments.max_results,
                since=since,
                query_mode=query_mode,
            )
        ]
        # The query words double as the topic filter, all of them in `and` mode. Not for a
        # raw query (operators and fields) or PubMed, which maps words to MeSH headings
        # (`prostate cancer` to `Prostatic Neoplasms`): their words would drop on-topic papers.
        no_filter = source is SourceName.PUBMED or query_mode == "raw"
        terms = [] if no_filter else query_words(arguments.query)
        match_all = query_mode == "and"
    options = CollectionOptions(
        max_depth=getattr(arguments, "max_depth", 0),
        topic_terms=tuple(terms),
        match_all_terms=match_all,
        known_ids=getattr(arguments, "known_ids", None) or frozenset(),
        max_requests=arguments.max_requests,
    )
    return seeds, options


def _usage_error(
    command: argparse.ArgumentParser, arguments: argparse.Namespace, message: str
) -> NoReturn:
    """Exit 2 with the usage of the subcommand, as argparse does for its own errors."""
    subcommand: argparse.ArgumentParser = getattr(arguments, "subcommand", command)
    subcommand.error(message)


def summary(result: CollectionResult) -> str:
    stats = result.stats
    lines = [
        f"collected {stats.documents} document(s) from {stats.seed_requests} seed request(s)",
        f"references: {stats.references_found} found, {stats.lookups_queued} queued for lookup, "
        f"{stats.lookups_missing} not returned by the source",
        f"skipped: {stats.skipped_duplicate} duplicate, {stats.skipped_known} known, "
        f"{stats.skipped_invalid} invalid, {stats.skipped_off_topic} off-topic",
        f"requests: {stats.finished_requests} finished, {stats.failed_requests} failed, "
        f"{stats.unprocessed_requests} not processed",
    ]
    for failure in result.failures:
        outcome = f"after {failure.retries} retries" if failure.retryable else "without retry"
        lines.append(
            f"failed {failure.kind} {failure.source.value} (depth {failure.depth}) "
            f"{failure.detail}: {failure.error} ({outcome})"
        )
    if result.run_error:
        lines.append(f"run aborted: {result.run_error}")
    return "\n".join(lines)


def store_summary(report: StoreReport) -> str:
    return (
        f"stored (run {report.run_id}): {report.inserted} new, {report.changed} changed, "
        f"{report.unchanged} unchanged; {report.cited} stored document(s) newly cited; "
        f"{report.expired} expired deleted"
    )


def main(argv: Sequence[str] | None = None) -> int:
    command = parser()
    arguments = command.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    # Crawlee logs every failed request with a full traceback. The runner logs each retry
    # in one line and the summary lists every failure, so keep Crawlee quiet.
    logging.getLogger("crawlee").setLevel(logging.CRITICAL)
    source = SourceName(arguments.source)
    url: str | None = None
    try:
        seeds, options = requests_from_args(arguments)
        if arguments.store:
            # Checked before the crawl, so a missing database costs no requests.
            url = database_url()
            stored = asyncio.run(prepare_store(url, source, load_ids=options.max_depth > 0))
            options = options.model_copy(update={"known_ids": options.known_ids | stored})
        started_at = datetime.now(UTC)
        result = asyncio.run(run_requests(seeds, options=options))
        finished_at = datetime.now(UTC)
    except (TopicFileError, CollectionSetupError, StoreError) as error:
        _usage_error(command, arguments, str(error))
    except ValidationError as error:
        _usage_error(command, arguments, validation_message(error))
    if isinstance(sys.stdout, io.TextIOWrapper):
        # JSON Lines are UTF-8; redirected on Windows, stdout would use the ANSI code page.
        sys.stdout.reconfigure(encoding="utf-8")
    for document in result.documents:
        print(json.dumps(document.model_dump(mode="json"), ensure_ascii=False))
    print(summary(result), file=sys.stderr)
    if url is not None:
        # Stored only after the output is printed, so a failed store loses none of the run.
        run = RunInfo(
            source=source,
            topics=list(dict.fromkeys(topic for seed in seeds for topic in seed.topics)),
            arguments=list(sys.argv[1:] if argv is None else argv),
            started_at=started_at,
            finished_at=finished_at,
        )
        try:
            report = asyncio.run(save_result(url, result, run))
        except StoreError as error:
            print(f"storing failed: {error}", file=sys.stderr)
            return 1
        print(store_summary(report), file=sys.stderr)
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
