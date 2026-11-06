import pytest

from crawler.sources.fields import (
    bare_orcid,
    clock_duration_seconds,
    creative_commons_licence,
    iso8601_duration_seconds,
    language_tag,
    normalize_doi,
    plain_text,
    truncate,
)
from crawler.sources.podcast import _clean_doi


def test_plain_text_keeps_paragraphs_and_unescapes_entities() -> None:
    assert plain_text("<p>A&nbsp;&amp; B</p><p>C<br/>D</p>") == "A & B\nC\nD"
    assert plain_text("") is None


def test_plain_text_drops_scripts_and_styles_and_keeps_words_whole() -> None:
    html = (
        "<style>.x{color:red}</style><script>var a = 1;</script>"
        '<p><b>J</b>ournal of <a href="https://example.test">Oncology</a>, <i>bold</i>.</p>'
    )

    assert plain_text(html) == "Journal of Oncology, bold."


def test_plain_text_drops_escaped_markup_but_keeps_comparisons() -> None:
    # Zenodo 14464542: Word markup stored escaped, with broken quotes in the style attribute.
    word = '&lt;span style="font-family: ";Calisto MT";; mso-ansi-language: EN-US;"&gt;Welcome'
    escaped = f"<p>{word}&lt;/span&gt;&lt;o:p&gt;&lt;/o:p&gt;&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;</p>"

    assert plain_text(escaped) == "Welcome\nTwo"
    assert plain_text("<p>p&lt;0.05 and x&lt;i and y&gt;j</p>") == "p<0.05 and x<i and y>j"


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


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("10.1016/J.EURURO.2026.01.001", "10.1016/j.eururo.2026.01.001"),
        ("https://doi.org/10.5281/ZENODO.42", "10.5281/zenodo.42"),
        ("http://dx.doi.org/10.1000/X ", "10.1000/x"),
        ("doi: 10.1000/X", "10.1000/x"),
        ("", None),
        (None, None),
    ],
)
def test_normalize_doi(value: str | None, expected: str | None) -> None:
    assert normalize_doi(value) == expected


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
        ("10.1002/14651858.CD015385.pub2/full", "10.1002/14651858.CD015385.pub2"),
        ("10.1101/2021.12.23.21268326v1.full.pdf", "10.1101/2021.12.23.21268326"),
        ("10.1101/2020.04.23.20076042v1", "10.1101/2020.04.23.20076042"),
        ("10.3389/fonc.2021.123456/full", "10.3389/fonc.2021.123456"),
        ("10.1200/JCO-25-01693&data=05|02|someone@asco.org", "10.1200/JCO-25-01693"),
        ("10.6084/m9.figshare.123.v1", "10.6084/m9.figshare.123.v1"),
        ("10.1093/oncolo/oyae187/7718961", "10.1093/oncolo/oyae187"),
        ("10.1093/eurheartj/ehz754/5602478", "10.1093/eurheartj/ehz754"),
        ("10.1093/jnci/djw123", "10.1093/jnci/djw123"),
    ],
)
def test_clean_doi(value: str, expected: str) -> None:
    assert _clean_doi(value) == expected
