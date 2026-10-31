import argparse
import asyncio
import json
from collections.abc import Sequence
from datetime import date

from scraper.models import ScrapeRequest, SourceName
from scraper.runner import run_requests


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(
        prog="scraper", description="Scrape source metadata as JSON Lines."
    )
    subcommands = command.add_subparsers(dest="source", required=True)

    for name in (SourceName.PUBMED.value, SourceName.ARXIV.value):
        paper = subcommands.add_parser(name)
        paper.add_argument("query")
        paper.add_argument("--max-results", type=int, default=10)
        paper.add_argument("--since", type=date.fromisoformat)
        if name == SourceName.ARXIV.value:
            paper.add_argument("--query-mode", choices=("and", "or", "raw"), default="and")

    youtube = subcommands.add_parser(SourceName.YOUTUBE.value)
    youtube.add_argument("channel", help="Channel ID, URL, @handle, or legacy username")
    youtube.add_argument("--max-results", type=int, default=10)
    return command


def request_from_args(arguments: argparse.Namespace) -> ScrapeRequest:
    source = SourceName(arguments.source)
    if source is SourceName.YOUTUBE:
        return ScrapeRequest(
            source=source,
            channel=arguments.channel,
            max_results=arguments.max_results,
        )
    return ScrapeRequest(
        source=source,
        query=arguments.query,
        max_results=arguments.max_results,
        since=arguments.since,
        query_mode=getattr(arguments, "query_mode", "and"),
    )


def main(argv: Sequence[str] | None = None) -> None:
    arguments = parser().parse_args(argv)
    documents = asyncio.run(run_requests([request_from_args(arguments)]))
    for document in documents:
        print(json.dumps(document.model_dump(mode="json"), ensure_ascii=False))


if __name__ == "__main__":
    main()
