import pytest

from crawler.sources.fields import (
    bare_orcid,
    clock_duration_seconds,
    creative_commons_licence,
    iso8601_duration_seconds,
    language_tag,
    plain_text,
    truncate,
)
from crawler.sources.podcast import _clean_doi


def test_plain_text_keeps_paragraphs_and_unescapes_entities() -> None:
    assert plain_text("<p>A&nbsp;&amp; B</p><p>C<br/>D</p>") == "A & B\nC\nD"
    assert plain_text("") is None


def test_truncate_cuts_at_a_word_boundary() -> None:
    assert truncate("short", 10) == "short"
    assert truncate("one two three four", 12) == "one two…"


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("eng", "en"),
        ("ger", "de"),
        ("deu", "de"),
        ("en-us", "en-US"),
        ("en_GB", "en-GB"),
        ("fr", "fr"),
        ("und", None),
        (None, None),
        ("xyz", "xyz"),
    ],
)
def test_language_tag(code: str | None, expected: str | None) -> None:
    assert language_tag(code) == expected


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://creativecommons.org/licenses/by-nc-sa/4.0/", "CC-BY-NC-SA-4.0"),
        ("https://creativecommons.org/licenses/by/4.0/legalcode", "CC-BY-4.0"),
        ("http://creativecommons.org/publicdomain/zero/1.0/", "CC0-1.0"),
        ("https://example.test/licence", None),
    ],
)
def test_creative_commons_licence(url: str, expected: str | None) -> None:
    assert creative_commons_licence(url) == expected


def test_bare_orcid() -> None:
    assert bare_orcid("https://orcid.org/0000-0002-1825-009X") == "0000-0002-1825-009X"
    assert bare_orcid("not an orcid") is None


@pytest.mark.parametrize(
    ("value", "expected"), [("PT1H2M3S", 3723), ("PT5M", 300), ("P1DT1S", 86401), ("P", None)]
)
def test_iso8601_duration_seconds(value: str, expected: int | None) -> None:
    assert iso8601_duration_seconds(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"), [("401", 401), ("22:15", 1335), ("1:02:03", 3723), ("", None)]
)
def test_clock_duration_seconds(value: str, expected: int | None) -> None:
    assert clock_duration_seconds(value) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("10.1016/S1470-2045(26)00001-2.", "10.1016/S1470-2045(26)00001-2"),
        ("10.1000/xyz),", "10.1000/xyz"),
        ("10.1000/a(b)", "10.1000/a(b)"),
        ("10.1200/JCO-26-00042?af=R&amp;x=1", "10.1200/JCO-26-00042"),
    ],
)
def test_clean_doi(value: str, expected: str) -> None:
    assert _clean_doi(value) == expected
