from datetime import date
from pathlib import Path

import pytest

from crawler.models import SourceName
from crawler.seeds import (
    TOPICS_DIR,
    TopicFileError,
    bundled_topics,
    find_podcast,
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
    url: https://www.youtube.com/channel/UCdemo0000000000000000ab
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
    assert [channel.url for channel in topic.channels] == [
        "https://www.youtube.com/channel/UCdemo0000000000000000ab"
    ]


@pytest.mark.parametrize(
    ("name", "content", "message"),
    [
        ("other_name", DEMO_TOPIC, "does not match the file name"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\n", "at least one query, channel or podcast"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\nqueries: [a]\n", "needs terms"),
        ("demo_topic", DEMO_TOPIC + "keywords: [a]\n", "Extra inputs are not permitted"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\nterms: [a]\nqueries: [a, ' ']\n", "blank"),
        ("demo_topic", "id: demo_topic\nlabel: Demo\nterms: [a]\nqueries: [a, a]\n", "duplicates"),
        ("demo_topic", "id: Demo Topic\nlabel: Demo\nterms: [a]\nqueries: [a]\n", "lower case"),
        ("demo_topic", "id: [unclosed\n", "invalid YAML"),
        (
            "demo_topic",
            "id: demo_topic\nlabel: Demo\nchannels:\n"
            "  - {name: A, url: https://youtube.com/channel/UCdemo0000000000000000ab}\n"
            "  - {name: B, url: https://youtube.com/channel/UCdemo0000000000000000ab}\n",
            "duplicate URLs",
        ),
        (
            "demo_topic",
            "id: demo_topic\nlabel: Demo\nchannels:\n"
            "  - {name: A, url: 'https://www.youtube.com/watch?v=VC4g2l47rzc'}\n",
            "not a channel URL",
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
    assert request.channel == "https://www.youtube.com/channel/UCdemo0000000000000000ab"
    assert request.topics == ["demo_topic"]


def test_seed_requests_fail_when_a_topic_has_no_seeds_for_the_source() -> None:
    with pytest.raises(TopicFileError, match="no pubmed seeds"):
        seed_requests([load_topic("general_cancer")], SourceName.PUBMED)


PODCAST_TOPIC = """
id: podcast_topic
label: Podcasts
podcasts:
  - key: jco
    name: JCO Podcast
    url: https://jcopodcast.libsyn.com/rss
    publisher: ASCO
    audience: clinicians
"""


def test_seed_requests_use_feeds_for_podcasts(tmp_path: Path) -> None:
    first = load_topic(write_topic(tmp_path, "podcast_topic", PODCAST_TOPIC))
    second = load_topic(
        write_topic(tmp_path, "other_topic", PODCAST_TOPIC.replace("podcast_topic", "other_topic"))
    )

    [request] = seed_requests([first, second], SourceName.PODCAST, since=date(2026, 1, 1))

    assert request.feed is not None
    assert request.feed.key == "jco"
    assert request.topics == ["podcast_topic", "other_topic"]
    assert request.since == date(2026, 1, 1)


def test_one_podcast_key_cannot_name_two_feeds_across_topic_files(tmp_path: Path) -> None:
    first = load_topic(write_topic(tmp_path, "podcast_topic", PODCAST_TOPIC))
    other = PODCAST_TOPIC.replace("podcast_topic", "other_topic").replace(
        "https://jcopodcast.libsyn.com/rss", "https://podcast.nejm.org/feed.xml"
    )
    second = load_topic(write_topic(tmp_path, "other_topic", other))

    with pytest.raises(TopicFileError, match="'jco' names two feeds: .*libsyn.* and .*nejm"):
        seed_requests([first, second], SourceName.PODCAST)


def test_the_same_feed_with_other_details_is_still_one_feed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    # The README's example entry next to a bundled topic: same URL, shorter publisher name.
    first = load_topic(write_topic(tmp_path, "podcast_topic", PODCAST_TOPIC))
    other = PODCAST_TOPIC.replace("podcast_topic", "other_topic").replace(
        "publisher: ASCO", "publisher: American Society of Clinical Oncology (ASCO)"
    )
    second = load_topic(write_topic(tmp_path, "other_topic", other))

    [request] = seed_requests([first, second], SourceName.PODCAST)

    assert request.feed is not None
    assert request.feed.publisher == "ASCO"
    assert request.topics == ["podcast_topic", "other_topic"]
    assert "'jco': publisher differ" in caplog.text


def test_topic_requests_that_are_invalid_name_their_topic_and_query(tmp_path: Path) -> None:
    content = "id: demo_topic\nlabel: Demo\nterms: [a]\nqueries: [prostate, '\"']\n"
    topic = load_topic(write_topic(tmp_path, "demo_topic", content))

    with pytest.raises(TopicFileError, match="topic demo_topic, '\"': query has no words"):
        seed_requests([topic], SourceName.ARXIV)


def test_unreadable_topic_files_are_topic_errors(tmp_path: Path) -> None:
    (tmp_path / "folder.yaml").mkdir()
    latin = tmp_path / "latin_topic.yaml"
    latin.write_bytes("id: latin_topic\nlabel: Caf\xe9\n".encode("latin-1"))

    with pytest.raises(TopicFileError, match="cannot read topic file"):
        load_topic(tmp_path / "folder.yaml")
    with pytest.raises(TopicFileError, match="cannot read topic file"):
        load_topic(latin)


def test_schema_errors_in_topic_files_have_no_pydantic_dump(tmp_path: Path) -> None:
    with pytest.raises(TopicFileError) as error_info:
        load_topic(write_topic(tmp_path, "demo_topic", "id: demo_topic\nqueries: [a]\n"))

    message = str(error_info.value)
    assert "label: Field required" in message
    assert "input_value" not in message and "pydantic.dev" not in message


def test_podcast_keys_must_be_unique_and_valid(tmp_path: Path) -> None:
    duplicate = PODCAST_TOPIC + PODCAST_TOPIC.split("podcasts:\n", 1)[1]
    with pytest.raises(TopicFileError, match="duplicate keys"):
        load_topic(write_topic(tmp_path, "podcast_topic", duplicate))
    with pytest.raises(TopicFileError, match="key"):
        load_topic(
            write_topic(
                tmp_path, "podcast_topic", PODCAST_TOPIC.replace("key: jco", "key: JCO Podcast")
            )
        )


def test_bundled_podcast_keys_and_urls_are_one_to_one() -> None:
    # Two keys for one feed would store every episode twice, under two IDs.
    feeds = [feed for topic in bundled_topics() for feed in topic.podcasts]

    urls: dict[str, set[str]] = {}
    keys: dict[str, set[str]] = {}
    for feed in feeds:
        urls.setdefault(feed.key, set()).add(feed.url)
        keys.setdefault(feed.url, set()).add(feed.key)
    assert feeds
    assert all(len(feed_urls) == 1 for feed_urls in urls.values())
    assert all(len(feed_keys) == 1 for feed_keys in keys.values())
    feed, topic_ids = find_podcast("nejm_this_week")
    assert feed.publisher == "NEJM Group"
    assert topic_ids == ["general_medicine"]
