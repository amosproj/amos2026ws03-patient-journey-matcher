"""Search queries of the sources with a query mode (arXiv, Zenodo)."""


def query_words(query: str) -> list[str]:
    """The words of an `and` or `or` query.

    The sources get each word in quotes, so quotes and backslashes in the query are dropped:
    they would end the quoted word early and break the whole query. Symbols on their own
    (`&`, `-`, `*`) are no words: arXiv answers them with nothing, an error or arbitrary
    papers, and the topic filter ignores them anyway.
    """
    words = (word.replace('"', "").replace("\\", "") for word in query.split())
    return [word for word in words if any(character.isalnum() for character in word)]


def raw_query_error(query: str) -> str | None:
    """Why a raw (Lucene) query is broken, or None.

    Zenodo answers a broken query with arbitrary records instead of an error, so check the
    quotes, the parentheses and a trailing backslash before sending it.
    """
    depth = 0
    quoted = escaped = False
    for character in query:
        if escaped:
            escaped = False
        elif character == "\\":
            escaped = True
        elif character == '"':
            quoted = not quoted
        elif not quoted and character == "(":
            depth += 1
        elif not quoted and character == ")":
            depth -= 1
            if depth < 0:
                return "')' without '('"
    if escaped:
        return "backslash at the end"
    if quoted:
        return "unclosed quote"
    if depth:
        return "unclosed '('"
    return None
