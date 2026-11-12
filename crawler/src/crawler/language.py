"""The language of a document's metadata: its title and abstract or description.

Sources give a language for only some records (Zenodo misses it on about 60 %, arXiv has
none), and PubMed's is the article's, not the abstract's: a German article often has an
English abstract. So the crawler detects the language of the text it stores, offline with
py3langid (BSD-3-Clause), and leaves the source's `language` as it is.
"""

from functools import cache
from typing import Any

from py3langid.langid import MODEL_FILE, LanguageIdentifier

from crawler.models import SourceDocument

LANGUAGES = (
    "en", "de", "fr", "es", "it", "pt", "nl", "pl", "cs", "sv", "da", "no", "fi", "hu",
    "ro", "el", "tr", "ru", "uk", "ar", "fa", "he", "zh", "ja", "ko",
)  # fmt: skip
"""Candidate languages; fewer candidates make short English texts less often a rare one."""
MIN_CONFIDENCE = 0.8
"""Below this the text is too short or too mixed to tell; such a text gets no language."""
MIN_LETTERS = 20
"""Fewer letters (a title such as `PSA` or `Prostate MRI`) are not enough to tell."""
METADATA_LANGUAGE = "metadata_language"
"""The key in `SourceDocument.extra`: the detected language of title and abstract."""


@cache
def _identifier() -> Any:
    identifier = LanguageIdentifier.from_model_file(MODEL_FILE, norm_probs=True)
    identifier.set_languages(list(LANGUAGES))
    return identifier


def detect_language(*texts: str | None) -> str | None:
    """The language of the joined texts as a BCP 47 tag, e.g. `en`; None if unsure."""
    text = " ".join(part.strip() for part in texts if part and part.strip())
    if sum(character.isalpha() for character in text) < MIN_LETTERS:
        return None
    language, confidence = _identifier().classify(text)
    return str(language) if confidence >= MIN_CONFIDENCE else None


def with_metadata_language(document: SourceDocument) -> SourceDocument:
    """The document with `extra.metadata_language`; its `language` stays the source's.

    Without a confident detection, `extra` keeps no such key: unknown counts as matchable.
    """
    detected = detect_language(document.title, document.abstract or document.description)
    extra = {key: value for key, value in document.extra.items() if key != METADATA_LANGUAGE}
    if detected is not None:
        extra[METADATA_LANGUAGE] = detected
    return document.model_copy(update={"extra": extra})
