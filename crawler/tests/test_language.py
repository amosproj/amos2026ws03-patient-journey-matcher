import pytest

from crawler.language import METADATA_LANGUAGE, detect_language, with_metadata_language
from crawler.models import SourceDocument, SourceName


def document(**fields: object) -> SourceDocument:
    values: dict[str, object] = {
        "id": "pubmed:1",
        "source": SourceName.PUBMED,
        "content_type": "journal_article",
        "source_id": "1",
        "title": "Olaparib in metastatic castration-resistant prostate cancer",
        "url": "https://pubmed.ncbi.nlm.nih.gov/1/",
    }
    return SourceDocument.model_validate(values | fields)


@pytest.mark.parametrize(
    ("text", "language"),
    [
        ("Olaparib in metastatic castration-resistant prostate cancer with BRCA2", "en"),
        ("Prostatakrebs: Therapie nach radikaler Prostatektomie bei Knochenmetastasen", "de"),
        ("Cáncer de próstata metastásico resistente a la castración: revisión", "es"),
        ("Le cancer de la prostate chez l'homme âgé : prise en charge", "fr"),
    ],
)
def test_detect_language_names_the_language_of_a_title(text: str, language: str) -> None:
    assert detect_language(text) == language


def test_detect_language_is_unsure_about_short_or_empty_texts() -> None:
    assert detect_language("PSA") is None
    assert detect_language("Prostate MRI") is None
    assert detect_language("", None, "   ") is None
    assert detect_language() is None


def test_detect_language_reads_title_and_abstract_together() -> None:
    title = "Prostate MRI"
    abstract = "We compared biparametric and multiparametric MRI in men with a raised PSA."

    assert detect_language(title, abstract) == "en"


def test_metadata_language_comes_from_the_abstract_not_the_article_language() -> None:
    # PubMed gives the article's language: a German article with an English abstract.
    abstract = "Radical prostatectomy remains a standard treatment for localized disease in men."
    marked = with_metadata_language(document(language="de", abstract=abstract))

    assert marked.extra[METADATA_LANGUAGE] == "en"
    assert marked.language == "de"


def test_metadata_language_leaves_a_missing_language_empty() -> None:
    marked = with_metadata_language(
        document(
            title="Prostatakrebs: Nachsorge und Therapie nach der radikalen Prostatektomie",
            language=None,
        )
    )

    assert marked.extra[METADATA_LANGUAGE] == "de"
    assert marked.language is None


def test_metadata_language_is_left_out_when_unsure() -> None:
    marked = with_metadata_language(
        document(title="PSA", language=None, extra={METADATA_LANGUAGE: "fr", "status": "x"})
    )

    assert marked.extra == {"status": "x"}
    assert marked.language is None


def test_metadata_language_uses_the_description_without_an_abstract() -> None:
    description = "Ein Gespräch über die Nachsorge nach der Bestrahlung der Prostata."
    marked = with_metadata_language(document(title="Folge 12", description=description))

    assert marked.extra[METADATA_LANGUAGE] == "de"
