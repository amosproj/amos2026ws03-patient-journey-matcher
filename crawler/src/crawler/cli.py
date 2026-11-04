import argparse
import asyncio
import json
import logging
import sys
from collections.abc import Sequence
from datetime import date

from pydantic import ValidationError

from crawler.models import CollectionResult, ScrapeRequest, SourceName
from crawler.runner import CollectionOptions, CollectionSetupError, run_requests
from crawler.seeds import TopicFileError, load_topic, seed_requests, topic_terms


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        prog="crawler",
        description=(
            "Collect source metadata as JSON Lines on stdout. A summary of the run goes to "
            "stderr. Exit code 1 means at least one request failed."
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
        seeds = paper.add_mutually_exclusive_group(required=True)
        seeds.add_argument("query", nargs="?", help="one search query")
        _add_topic_argument(seeds)
        paper.add_argument("--max-results", type=int, default=10, help="results per query")
        paper.add_argument("--since", type=date.fromisoformat, help="only records since this date")
        if source is not SourceName.ZENODO:
            paper.add_argument(
                "--max-depth",
                type=int,
                default=1,
                help="levels of references to follow; 0 collects the search results only",
            )
        _add_max_requests_argument(paper)
        if source is not SourceName.PUBMED:
            paper.add_argument("--query-mode", choices=("and", "or", "raw"), default="and")

    youtube = subcommands.add_parser(SourceName.YOUTUBE.value, help="list channel videos")
    seeds = youtube.add_mutually_exclusive_group(required=True)
    seeds.add_argument("channel", nargs="?", help="channel ID, URL, @handle, or legacy username")
    _add_topic_argument(seeds)
    youtube.add_argument("--max-results", type=int, default=10, help="videos per channel")
    _add_max_requests_argument(youtube)
    return command


def _add_topic_argument(group: argparse._MutuallyExclusiveGroup) -> None:
    group.add_argument(
        "--topic",
        action="append",
        metavar="ID_OR_PATH",
        help="topic file: an ID from crawler/topics/ or a path to a YAML file; repeatable",
    )


def _add_max_requests_argument(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--max-requests", type=int, help="stop after this many queued requests (safety cap)"
    )


def requests_from_args(
    arguments: argparse.Namespace,
) -> tuple[list[ScrapeRequest], CollectionOptions]:
    source = SourceName(arguments.source)
    query_mode: str = getattr(arguments, "query_mode", "and")
    since: date | None = getattr(arguments, "since", None)
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
                source=source, channel=arguments.channel, max_results=arguments.max_results
            )
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
        # A raw query has operators and fields, so it cannot double as a filter term.
        terms = [] if query_mode == "raw" else [arguments.query]
    options = CollectionOptions(
        max_depth=getattr(arguments, "max_depth", 0),
        topic_terms=tuple(terms),
        max_requests=arguments.max_requests,
    )
    return seeds, options


def summary(result: CollectionResult) -> str:
    stats = result.stats
    lines = [
        f"collected {stats.documents} document(s) from {stats.seed_requests} seed request(s)",
        f"references: {stats.references_found} found, {stats.lookups_queued} looked up, "
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


def main(argv: Sequence[str] | None = None) -> int:
    command = parser()
    arguments = command.parse_args(argv)
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    # Crawlee logs every failed request with a full traceback. The runner logs each retry
    # in one line and the summary lists every failure, so keep Crawlee quiet.
    logging.getLogger("crawlee").setLevel(logging.CRITICAL)
    try:
        seeds, options = requests_from_args(arguments)
        result = asyncio.run(run_requests(seeds, options=options))
    except (TopicFileError, CollectionSetupError, ValidationError) as error:
        command.error(str(error))
    for document in result.documents:
        print(json.dumps(document.model_dump(mode="json"), ensure_ascii=False))
    print(summary(result), file=sys.stderr)
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
