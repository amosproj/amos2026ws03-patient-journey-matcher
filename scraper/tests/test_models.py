import pytest
from pydantic import ValidationError

from scraper.models import ScrapeRequest, SourceName, source_document_id


def test_source_document_id_is_stable_and_source_scoped() -> None:
    assert source_document_id(SourceName.PUBMED, "123") == "pubmed:123"
    assert source_document_id(SourceName.ARXIV, "123") == "arxiv:123"


def test_request_requires_the_source_specific_input() -> None:
    with pytest.raises(ValidationError, match="query is required"):
        ScrapeRequest(source=SourceName.PUBMED)
    with pytest.raises(ValidationError, match="channel is required"):
        ScrapeRequest(source=SourceName.YOUTUBE)
