import argparse
import asyncio
import io
import json
import logging
import sys
import time
from collections.abc import Callable, Sequence
from contextlib import suppress
from datetime import UTC, date, datetime
from functools import cache
from pathlib import Path
from typing import NamedTuple, NoReturn

from asyncpg import PostgresError
from pydantic import ValidationError

from crawler.language import with_metadata_language
from crawler.models import (
    MAX_RESULTS,
    CollectionResult,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    source_document_id,
    validation_message,
)
from crawler.queries import query_words
from crawler.refresh import refresh_documents
from crawler.runner import (
    CollectionOptions,
    CollectionSetupError,
    link_extractor_from_env,
    run_requests,
    source_from_env,
)
from crawler.seeds import (
    Topic,
    TopicFileError,
    bundled_topics,
    find_podcast,
    load_topic,
    seed_requests,
    topic_terms,
)
from crawler.sources.arxiv import split_version
from crawler.sources.base import redact_secrets
from crawler.sources.youtube import REFRESH_WITHIN, YouTubeScraper, channel_lookup
from crawler.store import (
    RESUME_OVERLAP,
    RunInfo,
    StoreError,
    StoreReport,
    database_url,
    last_successful_runs,
    prepare_store,
    resume_date,
    save_result,
    stored_topics,
    videos_to_refresh,
)

AUTO = "auto"
"""`--since auto`: continue from the topics' last successful run with `--store`."""
SINCE_AUTO_HELP = (
    f"auto: from {RESUME_OVERLAP.days} days before the topics' last successful run with --store; "
    "topics without one get no date (needs --store and --topic or --all-topics)"
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
STORE_HELP = (
    "also upsert the documents into PostgreSQL (DATABASE_URL) and log the run; several topics "
    "are crawled and stored one after another, each as a run of its own"
)
STORE_REFERENCES_HELP = f"{STORE_HELP}; cited papers stored before are not fetched again"
STORE_VIDEOS_HELP = (
    f"{STORE_HELP}; stored videos of the channels that expire within {REFRESH_WITHIN.days} days "
    "are fetched again"
)
MIN_CITATIONS_HELP = (
    "look up a cited paper only once this many of the collected papers cite it; with --store, "
    "papers of the same topic (default 1: every cited paper)"
)
RESUME_HELP = (
    "skip the topics that a successful run with exactly these arguments has stored, whenever "
    "that was, so a crawl that was stopped continues (needs --store and --topic or "
    "--all-topics; --since auto continues on its own)"
)
STORE_RETRY_DELAYS: tuple[float, ...] = (5, 15, 30, 60)
"""Seconds before storing is tried again. The database restarts when an update changes it, and
a crawl that takes days must not lose a topic to that."""
INTERRUPTED = 130
"""Exit code after Ctrl+C."""


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


def since_date(value: str) -> date | str:
    """An argparse type for `--since`: a date (YYYY-MM-DD) or `auto`."""
    if value.strip() == AUTO:
        return AUTO
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        raise argparse.ArgumentTypeError(f"expected YYYY-MM-DD or auto, got {value!r}") from None


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        prog="crawler",
        description=(
            "Collect source metadata as JSON Lines on stdout. A summary of the run goes to "
            "stderr. Exit code 1 means at least one request failed or was not processed "
            "(--max-requests) or, with --store, storing or refreshing stored videos failed; "
            "130 that the run was stopped with Ctrl+C."
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
        _add_topic_arguments(seeds)
        _add_max_results_argument(paper, "results per query")
        _add_since_argument(paper, source)
        if source is not SourceName.ZENODO:
            paper.add_argument(
                "--max-depth",
                type=whole_number(0),
                default=1,
                help="levels of references to follow; 0 collects the search results only",
            )
            paper.add_argument(
                "--min-citations", type=whole_number(1), default=1, help=MIN_CITATIONS_HELP
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
    _add_topic_arguments(seeds)
    _add_max_results_argument(youtube, "videos per channel")
    _add_since_argument(youtube, SourceName.YOUTUBE)
    _add_max_requests_argument(youtube)
    _add_store_argument(youtube, STORE_VIDEOS_HELP)

    podcast = subcommands.add_parser(SourceName.PODCAST.value, help="list podcast episodes")
    podcast.set_defaults(subcommand=podcast)
    seeds = podcast.add_mutually_exclusive_group(required=True)
    seeds.add_argument(
        "feed", nargs="?", type=non_blank, help="feed key from a topic file, e.g. jco"
    )
    _add_topic_arguments(seeds)
    _add_max_results_argument(podcast, "episodes per feed")
    _add_since_argument(podcast, SourceName.PODCAST)
    _add_max_requests_argument(podcast)
    _add_store_argument(podcast, STORE_HELP)
    refresh = subcommands.add_parser(
        "refresh", help="backfill stored language markers and OpenAlex links; no source recrawl"
    )
    refresh.set_defaults(subcommand=refresh)
    refresh.add_argument("--source", dest="refresh_source", choices=[s.value for s in SourceName])
    refresh.add_argument("--limit", type=whole_number(1), help="maximum stored documents to scan")
    refresh.add_argument("--batch-size", type=whole_number(1, 50), default=50)
    return command


def _add_topic_arguments(group: argparse._MutuallyExclusiveGroup) -> None:
    group.add_argument(
        "--topic",
        action="append",
        metavar="ID_OR_PATH",
        help="topic file: an ID from crawler/topics/ or a path to a YAML file; repeatable",
    )
    group.add_argument(
        "--all-topics", action="store_true", help="every topic file in crawler/topics/"
    )


def _add_max_results_argument(command: argparse.ArgumentParser, help_text: str) -> None:
    command.add_argument(
        "--max-results", type=whole_number(1, MAX_RESULTS), default=10, help=help_text
    )


def _add_since_argument(command: argparse.ArgumentParser, source: SourceName) -> None:
    command.add_argument(
        "--since", type=since_date, help=f"{SINCE_HELP[source]}; {SINCE_AUTO_HELP}"
    )


def _add_max_requests_argument(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--max-requests",
        type=whole_number(1),
        help="stop after this many requests (safety cap); the run then exits with 1",
    )


def _add_store_argument(command: argparse.ArgumentParser, help_text: str) -> None:
    command.add_argument("--store", action="store_true", help=help_text)
    command.add_argument("--resume", action="store_true", help=RESUME_HELP)


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


def topics_from_args(arguments: argparse.Namespace) -> list[Topic]:
    """The topic files of `--topic` or `--all-topics`; none for one query, channel or feed."""
    if arguments.all_topics:
        return bundled_topics()
    return [load_topic(reference) for reference in arguments.topic or []]


def requests_from_args(
    arguments: argparse.Namespace, topics: Sequence[Topic] | None = None
) -> tuple[list[ScrapeRequest], CollectionOptions]:
    """The seed requests and options of a command; `topics`: its topic files, if loaded."""
    source = SourceName(arguments.source)
    query_mode: str = getattr(arguments, "query_mode", "and")
    # `auto` is resolved by `main` from the stored runs, once the topics of the seeds are known.
    since_argument = getattr(arguments, "since", None)
    since = since_argument if isinstance(since_argument, date) else None
    match_all = False
    if arguments.topic or arguments.all_topics:
        if topics is None:
            topics = topics_from_args(arguments)
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
        min_citations=getattr(arguments, "min_citations", 1),
        max_requests=arguments.max_requests,
    )
    return seeds, options


def _topics(seeds: Sequence[ScrapeRequest]) -> list[str]:
    """The topics of the seeds, in seed order and without duplicates."""
    return list(dict.fromkeys(topic for seed in seeds for topic in seed.topics))


class _Part(NamedTuple):
    """What one run crawls: the seeds of a command or, with `--store`, those of one topic."""

    seeds: list[ScrapeRequest]
    terms: tuple[str, ...]
    """The topic filter for the cited papers of the run."""


def _by_topic(seeds: Sequence[ScrapeRequest], topics: Sequence[Topic]) -> list[_Part]:
    """One part per topic with seeds, in topic order. A seed that topics share is in each of
    them, and each part keeps the cited papers with a term of its own topic."""
    terms = {topic.id: tuple(topic_terms([topic])) for topic in topics}
    return [
        _Part(
            [seed.model_copy(update={"topics": [topic]}) for seed in seeds if topic in seed.topics],
            terms[topic],
        )
        for topic in _topics(seeds)
    ]


def _since_auto_line(seeds: Sequence[ScrapeRequest]) -> str:
    """What `--since auto` resolved to: the oldest date, and the seeds without one."""
    dates = [seed.since for seed in seeds if seed.since is not None]
    if not dates:
        return "since auto: no successful run yet, so no date"
    line = f"since auto: {min(dates).isoformat()}"
    undated = len(seeds) - len(dates)
    if undated:
        line += f"; {undated} seed(s) of topics without a successful run: no date"
    return line


async def refresh_videos(
    url: str,
    seeds: Sequence[ScrapeRequest],
    result: CollectionResult,
    scraper: YouTubeScraper | None = None,
) -> tuple[int, list[SourceDocument]]:
    """Fetch the stored videos of the seeds' channels that expire within `REFRESH_WITHIN` again,
    except those the run collected.

    A run only lists the newest videos of a channel, so the older ones would expire. Returns how
    many were due and those still public; the others expire. Channels that are not found are
    skipped: the run already failed for them.
    """
    youtube = scraper or YouTubeScraper.from_env()

    def channel_ids() -> list[str]:
        ids: list[str] = []
        for seed in seeds:
            if seed.channel:
                with suppress(ValueError):
                    ids.append(youtube.resolve_channel_id(seed.channel))
        return ids

    collected = {document.id for document in result.documents}
    stored = await videos_to_refresh(url, await asyncio.to_thread(channel_ids))
    due = [
        video_id
        for video_id in stored
        if source_document_id(SourceName.YOUTUBE, video_id) not in collected
    ]
    videos = await asyncio.to_thread(youtube.video_details, due)
    return len(due), [with_metadata_language(video) for video in videos]


def _refresh(
    url: str, seeds: Sequence[ScrapeRequest], result: CollectionResult
) -> list[SourceDocument] | None:
    """`refresh_videos` with its outcome on stderr; None if it failed."""
    try:
        due, refreshed = asyncio.run(refresh_videos(url, seeds, result))
    except Exception as error:  # API, network or database: the run is stored all the same
        message = redact_secrets(f"{type(error).__name__}: {error}")
        print(f"refreshing stored videos failed: {message}", file=sys.stderr)
        return None
    print(
        f"refreshed {len(refreshed)} of {due} stored video(s) that expire within "
        f"{REFRESH_WITHIN.days} days",
        file=sys.stderr,
    )
    return refreshed


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
        f"{stats.skipped_invalid} invalid, {stats.skipped_rarely_cited} cited too rarely, "
        f"{stats.skipped_off_topic} off-topic",
        f"requests: {stats.finished_requests} finished, {stats.failed_requests} failed, "
        f"{stats.unprocessed_requests} not processed",
    ]
    for failure in result.failures:
        outcome = f"after {failure.retries} retries" if failure.retryable else "without retry"
        lines.append(
            f"failed {failure.kind} {failure.source.value} (depth {failure.depth}) "
            f"{failure.detail}: {failure.error} ({outcome})"
        )
    for seed in result.max_results_reached:
        lines.append(
            f"reached --max-results: {seed}; older results of the --since period may be missing"
        )
    if result.run_error:
        lines.append(f"run aborted: {result.run_error}")
    elif result.interrupted:
        lines.append(f"interrupted: {stats.unprocessed_requests} request(s) not processed")
    elif stats.unprocessed_requests:
        lines.append(
            f"stopped at --max-requests: {stats.unprocessed_requests} request(s) not processed"
        )
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
    if arguments.source == "refresh":
        try:
            refresh_report = asyncio.run(
                refresh_documents(
                    database_url(),
                    source=SourceName(arguments.refresh_source)
                    if arguments.refresh_source
                    else None,
                    limit=arguments.limit,
                    batch_size=arguments.batch_size,
                )
            )
        except (StoreError, ValueError, OSError, PostgresError) as error:
            print(f"refresh failed: {redact_secrets(str(error))}", file=sys.stderr)
            return 1
        print(
            f"refreshed: {refresh_report.scanned} scanned, {refresh_report.changed} changed, "
            f"{refresh_report.unchanged} unchanged, "
            f"{refresh_report.conflicts} concurrent changes skipped, "
            f"{refresh_report.lookup_failures} OpenAlex batch(es) failed",
            file=sys.stderr,
        )
        return int(bool(refresh_report.conflicts or refresh_report.lookup_failures))
    source = SourceName(arguments.source)
    since_auto = arguments.since == AUTO
    topic_run = bool(arguments.topic or arguments.all_topics)
    if since_auto and not arguments.store:
        _usage_error(command, arguments, "--since auto needs --store, whose runs it continues")
    if since_auto and not topic_run:
        _usage_error(command, arguments, "--since auto needs --topic or --all-topics")
    if arguments.resume and not arguments.store:
        _usage_error(command, arguments, "--resume needs --store, whose runs it continues")
    if arguments.resume and not topic_run:
        _usage_error(command, arguments, "--resume needs --topic or --all-topics")
    if arguments.resume and since_auto:
        _usage_error(command, arguments, "--since auto continues on its own, without --resume")
    run_arguments = list(sys.argv[1:] if argv is None else argv)
    url: str | None = None
    try:
        topics = topics_from_args(arguments) if topic_run else []
        seeds, options = requests_from_args(arguments, topics)
        parts = [_Part(seeds, options.topic_terms)]
        if arguments.store:
            # Checked before the crawl, so a missing database costs no requests.
            url = database_url()
            stored = asyncio.run(prepare_store(url, source, load_ids=options.max_depth > 0))
            options = options.model_copy(update={"known_ids": options.known_ids | stored})
            if topics:
                parts = _by_topic(seeds, topics)
            if arguments.resume:
                done = asyncio.run(stored_topics(url, source, run_arguments))
                left = [part for part in parts if part.seeds[0].topics[0] not in done]
                print(
                    f"resume: {len(parts) - len(left)} of {len(parts)} topic(s) already stored",
                    file=sys.stderr,
                )
                parts = left
            if since_auto:
                last_runs = asyncio.run(last_successful_runs(url, source, _topics(seeds)))
                # Each topic continues from its own last run, so a new topic gets its first run.
                parts = [
                    part._replace(
                        seeds=[
                            seed.model_copy(update={"since": resume_date(last_runs, seed.topics)})
                            for seed in part.seeds
                        ]
                    )
                    for part in parts
                ]
                dated = [seed for part in parts for seed in part.seeds]
                print(_since_auto_line(dated), file=sys.stderr)
        named = url is not None and len(topics) > 1
        return _crawl(parts, options, source, url, run_arguments, named=named)
    except (TopicFileError, CollectionSetupError, StoreError) as error:
        _usage_error(command, arguments, str(error))
    except ValidationError as error:
        _usage_error(command, arguments, validation_message(error))
    except KeyboardInterrupt:
        # Ctrl+C outside a crawl; during one, the crawl stops and its part is still stored.
        print("interrupted", file=sys.stderr)
        return INTERRUPTED


def _crawl(
    parts: Sequence[_Part],
    options: CollectionOptions,
    source: SourceName,
    url: str | None,
    arguments: list[str],
    *,
    named: bool = False,
) -> int:
    """Crawl the parts one after another, each printed and (with `url`) stored when it is done.

    With `--store` a part is one topic, so a crawl that is stopped or crashes loses the topic it
    was working on and nothing else, and later topics do not fetch what earlier ones stored.
    Returns the exit code.
    """
    if isinstance(sys.stdout, io.TextIOWrapper):
        # JSON Lines are UTF-8; redirected on Windows, stdout would use the ANSI code page.
        sys.stdout.reconfigure(encoding="utf-8")
    known = options.known_ids
    budget = options.max_requests
    # One scraper and one link extractor per source for all parts: each keeps the pause its
    # source asks for between two requests, and a new one would not know the last request.
    sources = cache(source_from_env)
    link_extractors = cache(link_extractor_from_env)
    crawled = failed = 0
    stopped: str | None = None
    for number, part in enumerate(parts, 1):
        if named:
            print(f"topic {number} of {len(parts)}: {part.seeds[0].topics[0]}", file=sys.stderr)
        part_options = options.model_copy(
            update={"known_ids": known, "topic_terms": part.terms, "max_requests": budget}
        )
        started_at = datetime.now(UTC)
        result = asyncio.run(
            run_requests(
                part.seeds,
                options=part_options,
                source_factory=sources,
                link_extractor_factory=link_extractors,
            )
        )
        finished_at = datetime.now(UTC)
        for document in result.documents:
            print(json.dumps(document.model_dump(mode="json"), ensure_ascii=False))
        sys.stdout.flush()
        print(summary(result), file=sys.stderr)
        ok = result.ok
        if url is not None:
            # Stored only after the output is written, so a failed store loses none of the run.
            run = RunInfo(
                source=source,
                topics=_topics(part.seeds),
                arguments=arguments,
                started_at=started_at,
                finished_at=finished_at,
            )
            refreshed = _refresh(url, part.seeds, result) if source is SourceName.YOUTUBE else []
            # Expired rows go with the last part: an earlier one would delete the expired
            # videos of the topics after it, before those fetched them again.
            report = _save(url, result, run, refreshed or [], expire=number == len(parts))
            if report is None:
                # The topics that are left could not be stored either.
                ok, stopped = False, "storing failed"
            else:
                print(store_summary(report), file=sys.stderr)
                ok = ok and refreshed is not None
                if options.max_depth > 0:
                    known = known | {document.id for document in result.documents}
        crawled += 1
        failed += not ok
        if result.interrupted:
            stopped = "interrupted"
        elif budget is not None and not stopped:
            budget -= result.stats.finished_requests + result.stats.failed_requests
            if budget <= 0 and number < len(parts):
                stopped = "--max-requests"
        if stopped:
            break
    if named and parts:
        line = f"{crawled} of {len(parts)} topic(s) crawled, {crawled - failed} without failures"
        print(f"{line}; stopped: {stopped}" if stopped else line, file=sys.stderr)
    if stopped == "interrupted":
        return INTERRUPTED
    return 1 if failed or stopped else 0


def _save(
    url: str,
    result: CollectionResult,
    run: RunInfo,
    refreshed: Sequence[SourceDocument],
    *,
    expire: bool,
) -> StoreReport | None:
    """`save_result`, tried again while the database is away; None if it stays away."""
    delays = list(STORE_RETRY_DELAYS)
    while True:
        try:
            return asyncio.run(save_result(url, result, run, refreshed=refreshed, expire=expire))
        except StoreError as error:
            if not delays:
                print(f"storing failed: {error}", file=sys.stderr)
                return None
            delay = delays.pop(0)
            print(f"storing failed: {error}; trying again in {delay:g} s", file=sys.stderr)
            time.sleep(delay)


if __name__ == "__main__":
    raise SystemExit(main())
