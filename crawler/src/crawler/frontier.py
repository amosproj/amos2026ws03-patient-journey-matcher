"""Request queue rules of the crawler architecture: dedup, topic filter, depth and provenance.

Crawlee's request queue runs the requests and retries them. This module decides which
requests to add. It is plain synchronous code, so it can be tested without Crawlee.
"""

import re
from collections.abc import Iterable, Mapping, Sequence
from collections.abc import Set as AbstractSet

from crawler.models import (
    CitationProvenance,
    CollectionResult,
    CollectionStats,
    ContentType,
    FoundBy,
    QueryProvenance,
    RequestFailure,
    ScrapeRequest,
    SourceDocument,
    SourceName,
    source_document_id,
)
from crawler.sources.arxiv import is_arxiv_id
from crawler.sources.pubmed import is_pmid

REFERENCES_BATCH_SIZE = 100
"""Citing papers per reference request unless the source sets its own; one ELink call."""
PAPER_TYPES: frozenset[ContentType] = frozenset(
    {"journal_article", "preprint", "conference_paper", "report"}
)
"""Content types whose references are followed."""

_NON_WORD = re.compile(r"[\W_]+")


def normalize_text(value: str) -> str:
    """Lower case, with every run of punctuation or whitespace turned into one space."""
    return " ".join(_NON_WORD.sub(" ", value.lower()).split())


def is_valid_native_id(source: SourceName, native_id: str) -> bool:
    if source is SourceName.PUBMED:
        return is_pmid(native_id)
    if source is SourceName.ARXIV:
        return is_arxiv_id(native_id)
    return False


class TopicFilter:
    """Keeps a cited document if a topic term (with `match_all`, every term) occurs in its
    title, abstract or subjects.

    Matching ignores case and punctuation, needs whole words, and accepts a plural `s` or
    `es` on the last word, so `prostatic neoplasm` matches the MeSH heading
    `Prostatic Neoplasms` and `ADT` does not match `adtech`. No terms means no filter.
    """

    def __init__(self, terms: Iterable[str], *, match_all: bool = False) -> None:
        self.terms = [term for term in dict.fromkeys(map(normalize_text, terms)) if term]
        self.match_all = match_all

    def matches(self, document: SourceDocument) -> bool:
        if not self.terms:
            return True
        fields = [
            f" {normalize_text(field)} "
            for field in (
                document.title,
                document.abstract,
                document.description,
                *(subject.label for subject in document.subjects),
            )
            if field
        ]
        found = (any(self._contains(field, term) for field in fields) for term in self.terms)
        return all(found) if self.match_all else any(found)

    @staticmethod
    def _contains(text: str, term: str) -> bool:
        return f" {term} " in text or f" {term}s " in text or f" {term}es " in text


def _batches(values: Sequence[str], size: int) -> list[list[str]]:
    return [list(values[offset : offset + size]) for offset in range(0, len(values), size)]


class Frontier:
    """Run-level state behind the request queue.

    - Each document is collected once; its `found_by` entries are merged.
    - Each paper's references are requested once (`expanded`).
    - Each cited paper is looked up once (`claimed`), unless it was already collected in
      this run or is in `known_ids` (documents stored by an earlier run).
    - Cited papers must pass the topic filter. Seed results always count.
    - References are followed until `max_depth` (seeds have depth 0).
    """

    def __init__(
        self,
        *,
        max_depth: int,
        topic_filter: TopicFilter,
        known_ids: AbstractSet[str] = frozenset(),
        lookup_batch_size: Mapping[SourceName, int] | None = None,
        references_batch_size: Mapping[SourceName, int] | None = None,
    ) -> None:
        self._max_depth = max_depth
        self._topic_filter = topic_filter
        self._known_ids = known_ids
        self._lookup_batch_size = dict(lookup_batch_size or {})
        self._references_batch_size = dict(references_batch_size or {})
        self._documents: dict[str, SourceDocument] = {}
        self._expanded: set[str] = set()
        self._claimed: set[str] = set()
        self._citations: dict[str, list[str]] = {}
        self.stats = CollectionStats()

    def add_documents(
        self,
        request: ScrapeRequest,
        depth: int,
        documents: Sequence[SourceDocument],
        *,
        expand: bool,
    ) -> list[list[str]]:
        """Merge the documents of one request.

        Returns batches of native IDs whose references should be requested next.
        """
        if request.is_lookup:
            returned = {document.source_id for document in documents}
            self.stats.lookups_missing += sum(
                1 for native_id in request.ids if native_id not in returned
            )
        provenance = self._query_provenance(request)
        to_expand: list[str] = []
        for document in documents:
            if request.is_lookup and not self._topic_filter.matches(document):
                self.stats.skipped_off_topic += 1
                continue
            self._merge(document, provenance)
            if (
                expand
                and depth < self._max_depth
                and document.content_type in PAPER_TYPES
                and document.id not in self._expanded
            ):
                self._expanded.add(document.id)
                to_expand.append(document.source_id)
        return _batches(
            to_expand, self._references_batch_size.get(request.source, REFERENCES_BATCH_SIZE)
        )

    def add_references(
        self, source: SourceName, cited: Mapping[str, Sequence[str]]
    ) -> list[list[str]]:
        """Record which paper cites which, and claim the cited papers not seen yet.

        Returns batches of native IDs to look up.
        """
        new_ids: list[str] = []
        for citing_native_id, cited_native_ids in cited.items():
            citing_id = source_document_id(source, citing_native_id)
            for native_id in cited_native_ids:
                self.stats.references_found += 1
                if native_id == citing_native_id or not is_valid_native_id(source, native_id):
                    self.stats.skipped_invalid += 1
                    continue
                cited_id = source_document_id(source, native_id)
                citing_ids = self._citations.setdefault(cited_id, [])
                if citing_id not in citing_ids:
                    citing_ids.append(citing_id)
                if cited_id in self._known_ids:
                    self.stats.skipped_known += 1
                elif cited_id in self._documents or cited_id in self._claimed:
                    self.stats.skipped_duplicate += 1
                else:
                    self._claimed.add(cited_id)
                    new_ids.append(native_id)
        self.stats.lookups_queued += len(new_ids)
        return _batches(new_ids, self._lookup_batch_size.get(source, REFERENCES_BATCH_SIZE))

    def result(
        self, failures: Sequence[RequestFailure], *, run_error: str | None = None
    ) -> CollectionResult:
        documents = []
        for document in self._documents.values():
            cited_by = [
                CitationProvenance(cited_by=citing_id)
                for citing_id in self._citations.get(document.id, [])
            ]
            found_by = list(dict.fromkeys([*document.found_by, *cited_by]))
            documents.append(document.model_copy(update={"found_by": found_by}))
        citations = {
            cited_id: list(citing_ids)
            for cited_id, citing_ids in self._citations.items()
            if cited_id in self._documents or cited_id in self._known_ids
        }
        stats = self.stats.model_copy(
            update={"documents": len(documents), "failed_requests": len(failures)}
        )
        return CollectionResult(
            documents=documents,
            failures=list(failures),
            stats=stats,
            citations=citations,
            run_error=run_error,
        )

    @staticmethod
    def _query_provenance(request: ScrapeRequest) -> list[FoundBy]:
        if request.is_lookup:
            return []
        query = request.seed_label
        if not request.topics:
            return [QueryProvenance(query=query)]
        return [QueryProvenance(topic=topic, query=query) for topic in request.topics]

    def _merge(self, document: SourceDocument, provenance: Sequence[FoundBy]) -> None:
        existing = self._documents.get(document.id)
        previous = existing.found_by if existing else []
        found_by = list(dict.fromkeys([*previous, *document.found_by, *provenance]))
        self._documents[document.id] = document.model_copy(update={"found_by": found_by})
