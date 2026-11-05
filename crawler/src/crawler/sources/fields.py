"""Field conversions that several sources share."""

import html
import re

_LINE_BREAK = re.compile(r"<\s*(?:br|/p|/div|/li|/h[1-6])\b[^>]*>", re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")
_ORCID = re.compile(r"[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{3}[0-9X]")
_ISO_DURATION = re.compile(
    r"P(?:(?P<days>[0-9]+)D)?(?:T(?:(?P<hours>[0-9]+)H)?(?:(?P<minutes>[0-9]+)M)?"
    r"(?:(?P<seconds>[0-9]+)S)?)?"
)
_CC_URL = re.compile(
    r"creativecommons\.org/(?:licenses/(?P<terms>[a-z-]+)|publicdomain/(?P<domain>zero|mark))"
    r"/(?P<version>[0-9.]+)"
)
_DOI_PREFIX = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:)\s*", re.IGNORECASE)

# ISO 639-2 (bibliographic and terminology) and ISO 639-3 codes that have a two-letter tag.
_TWO_LETTER = {
    "afr": "af",
    "ara": "ar",
    "baq": "eu",
    "ben": "bn",
    "bul": "bg",
    "cat": "ca",
    "ces": "cs",
    "chi": "zh",
    "cym": "cy",
    "cze": "cs",
    "dan": "da",
    "deu": "de",
    "dut": "nl",
    "ell": "el",
    "eng": "en",
    "est": "et",
    "eus": "eu",
    "fas": "fa",
    "fin": "fi",
    "fra": "fr",
    "fre": "fr",
    "ger": "de",
    "gle": "ga",
    "glg": "gl",
    "gre": "el",
    "heb": "he",
    "hin": "hi",
    "hrv": "hr",
    "hun": "hu",
    "ice": "is",
    "ind": "id",
    "isl": "is",
    "ita": "it",
    "jpn": "ja",
    "kor": "ko",
    "lav": "lv",
    "lit": "lt",
    "may": "ms",
    "msa": "ms",
    "nld": "nl",
    "nob": "nb",
    "nor": "no",
    "per": "fa",
    "pol": "pl",
    "por": "pt",
    "ron": "ro",
    "rum": "ro",
    "rus": "ru",
    "slk": "sk",
    "slo": "sk",
    "slv": "sl",
    "spa": "es",
    "srp": "sr",
    "swe": "sv",
    "tam": "ta",
    "tha": "th",
    "tur": "tr",
    "ukr": "uk",
    "urd": "ur",
    "vie": "vi",
    "wel": "cy",
    "zho": "zh",
}


def plain_text(value: object) -> str | None:
    """Turn HTML into plain text, one paragraph per line."""
    if not value:
        return None
    text = html.unescape(_TAG.sub(" ", _LINE_BREAK.sub("\n", str(value))))
    lines = (" ".join(line.split()) for line in text.splitlines())
    return "\n".join(line for line in lines if line) or None


def truncate(text: str, limit: int) -> str:
    """Cut text at a word boundary so that it has at most `limit` characters."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip()
    return f"{cut}…"


def language_tag(code: object) -> str | None:
    """Turn `eng`, `en-us` or `en_GB` into a BCP 47 tag such as `en` or `en-US`."""
    if not code:
        return None
    parts = str(code).strip().replace("_", "-").split("-")
    primary = parts[0].lower()
    if primary in {"", "und", "mul", "zxx"}:
        return None
    primary = _TWO_LETTER.get(primary, primary)
    region = [part.upper() if len(part) == 2 else part for part in parts[1:] if part]
    return "-".join([primary, *region])


def creative_commons_licence(url: object) -> str | None:
    """Turn a Creative Commons URL into an SPDX ID, e.g. `CC-BY-NC-ND-4.0`."""
    match = _CC_URL.search(str(url or ""))
    if match is None:
        return None
    if match["domain"] == "zero":
        return f"CC0-{match['version']}"
    if match["domain"] == "mark":
        return "PDM-1.0"
    return f"CC-{match['terms'].upper()}-{match['version']}"


def normalize_doi(value: object) -> str | None:
    """`https://doi.org/10.1000/ABC` → `10.1000/abc`; DOIs ignore case, so compare them lower."""
    doi = _DOI_PREFIX.sub("", str(value or "").strip()).strip().lower()
    return doi or None


def bare_orcid(value: object) -> str | None:
    """Extract `0000-0002-1825-0097` from a bare ID or an orcid.org URL."""
    match = _ORCID.search(str(value or ""))
    return match.group(0) if match else None


def iso8601_duration_seconds(value: object) -> int | None:
    """`PT1H2M3S` → 3723."""
    match = _ISO_DURATION.fullmatch(str(value or "").strip())
    if match is None or not any(match.groupdict().values()):
        return None
    days, hours, minutes, seconds = (
        int(match[name] or 0) for name in ("days", "hours", "minutes", "seconds")
    )
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds


def clock_duration_seconds(value: object) -> int | None:
    """`401`, `22:15` or `1:02:03` → seconds."""
    parts = str(value or "").strip().split(":")
    if not parts or not all(part.isdigit() for part in parts) or len(parts) > 3:
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds
