from scraper.cli import parser, request_from_args
from scraper.models import SourceName


def test_cli_builds_pubmed_request() -> None:
    arguments = parser().parse_args(
        ["pubmed", "prostate cancer", "--max-results", "3", "--since", "2026-01-01"]
    )
    request = request_from_args(arguments)
    assert request.source is SourceName.PUBMED
    assert request.query == "prostate cancer"
    assert request.max_results == 3
    assert request.since is not None
