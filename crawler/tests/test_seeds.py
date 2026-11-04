from datetime import date
from pathlib import Path

import pytest

from crawler.models import SourceName
from crawler.seeds import (
    TOPICS_DIR,
    TopicFileError,
    load_topic,
    seed_requests,
    topic_path,
    topic_terms,
)

DEMO_TOPIC = """
id: demo_topic
label: Demo topic
terms: [prostate cancer, mCRPC]
queries: [prostate cancer, prostate cancer biopsy]
channels:
  - name: Demo channel
    url: https://www.youtube.com/channel/UCdemo
icd_prefixes: [C61]
aliases: [prostatakrebs]
"""


def write_topic(directory: Path, name: str, content: str) -> Path:
    path = directory / f"{name}.yaml"
    path.write_text(content, encoding="utf-8")
    return path


def test_load_topic_reads_a_topic_file(tmp_path: Path) -> None:
    topic = load_topic(write_topic(tmp_path, "demo_topic", DEMO_TOPIC))

    assert topic.id == "demo_topic"
    assert topic.terms == ["prostate cancer", "mCRPC"]
    assert topic.queries == ["prostate cancer", "prostate cancer biopsy"]
    assert [channel.url for channel in topic.channels] == ["https://www.youtube.com/channel/UCdemo"]
    assert topic.icd_prefixes == ["C61"]


@pytest.mark.parametrize(
    ("name", "content", "message"),
    [
        ("other_name", DEMO_TOPIC, "does not match the file name"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\n", "at least one query or channel"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\nqueries: [a]\n", "needs terms"),
        ("demo_topic", DEMO_TOPIC + "keywords: [a]\n", "Extra inputs are not permitted"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\nterms: [a]\nqueries: [a, ' ']\n", "blank"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\nterms: [a]\nqueries: [a, a]\n", "duplicates"),
        ("demo_topic", "id: Demo Topic\nlabel: Demo\nterms: [a]\nqueries: [a]\n", "lower case"),
        ("demo_topic", "id: [unclosed\n", "invalid YAML"),
        (
            "demo_topic",
            "id: demo_topic\nlabel: Demo\nchannels:\n"
            "  - {name: A, url: https://youtube.com/channel/UC1}\n"
            "  - {name: B, url: https://youtube.com/channel/UC1}\n",
            "duplicate URLs",
        ),
    ],
)
def test_load_topic_rejects_invalid_files(
    tmp_path: Path, name: str, content: str, message: str
) -> None:
    with pytest.raises(TopicFileError, match=message):
        load_topic(write_topic(tmp_path, name, content))


def test_load_topic_reports_a_missing_file(tmp_path: Path) -> None:
    with pytest.raises(TopicFileError, match="not found"):
        load_topic(tmp_path / "missing.yaml")


def test_topic_ids_resolve_to_the_bundled_files() -> None:
    assert topic_path("prostate_cancer") == TOPICS_DIR / "prostate_cancer.yaml"
    assert topic_path("custom/prostate_cancer.yaml") == Path("custom/prostate_cancer.yaml")
    assert load_topic("prostate_cancer").label == "Prostate cancer"


@pytest.mark.parametrize("path", sorted(TOPICS_DIR.glob("*.yaml")), ids=lambda path: path.stem)
def test_every_bundled_topic_file_is_valid(path: Path) -> None:
    topic = load_topic(path)

    assert topic.id == path.stem
    for query in topic.queries:
        assert query == query.strip()


def test_seed_requests_merge_queries_that_topics_share(tmp_path: Path) -> None:
    first = load_topic(write_topic(tmp_path, "demo_topic", DEMO_TOPIC))
    second = load_topic(
        write_topic(
            tmp_path,
            "second_topic",
            "id: second_topic\nlabel: Second\nterms: [psa]\nqueries: [prostate cancer, psa]\n",
        )
    )

    requests = seed_requests(
        [first, second], SourceName.PUBMED, max_results=5, since=date(2026, 1, 1)
    )

    assert [(request.query, request.topics) for request in requests] == [
        ("prostate cancer", ["demo_topic", "second_topic"]),
        ("prostate cancer biopsy", ["demo_topic"]),
        ("psa", ["second_topic"]),
    ]
    assert all(request.max_results == 5 for request in requests)
    assert all(request.since == date(2026, 1, 1) for request in requests)
    assert topic_terms([first, second]) == ["prostate cancer", "mCRPC", "psa"]


def test_seed_requests_use_channels_for_youtube(tmp_path: Path) -> None:
    topic = load_topic(write_topic(tmp_path, "demo_topic", DEMO_TOPIC))

    [request] = seed_requests([topic], SourceName.YOUTUBE, max_results=3)

    assert request.source is SourceName.YOUTUBE
    assert request.channel == "https://www.youtube.com/channel/UCdemo"
    assert request.topics == ["demo_topic"]


def test_seed_requests_fail_when_a_topic_has_no_seeds_for_the_source() -> None:
    with pytest.raises(TopicFileError, match="no pubmed seeds"):
        seed_requests([load_topic("general_cancer")], SourceName.PUBMED)
