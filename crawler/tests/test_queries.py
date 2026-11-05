import pytest

from crawler.queries import query_words, raw_query_error


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        ("prostate cancer", ["prostate", "cancer"]),
        ('"breast cancer" mammography', ["breast", "cancer", "mammography"]),
        ("prostate\\", ["prostate"]),
        ('" \\ "', []),
        ("   ", []),
        ("breast & cancer", ["breast", "cancer"]),
        ("mammography - tomosynthesis *", ["mammography", "tomosynthesis"]),
        ("C++ -", ["C++"]),
    ],
)
def test_query_words_drop_quotes_and_backslashes(query: str, expected: list[str]) -> None:
    assert query_words(query) == expected


@pytest.mark.parametrize(
    ("query", "problem"),
    [
        ('ti:"breast cancer" AND (cat:q-bio* OR cat:cs.CV)', None),
        ('title:"a \\" quote"', None),
        ('title:"(not a group"', None),
        ("title:(prostate", "unclosed '('"),
        ("a) OR (b", "')' without '('"),
        ('title:"prostate', "unclosed quote"),
        ("prostate\\", "backslash at the end"),
    ],
)
def test_raw_query_error_finds_unbalanced_quotes_and_parentheses(
    query: str, problem: str | None
) -> None:
    assert raw_query_error(query) == problem
