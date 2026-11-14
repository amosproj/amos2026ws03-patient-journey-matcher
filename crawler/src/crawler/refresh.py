"""Backfill language markers and OpenAlex locators without recrawling source metadata."""

import asyncio
import json
import logging

from dotenv import load_dotenv
from pydantic import BaseModel

from crawler.language import METADATA_LANGUAGE, detect_language
from crawler.models import SourceName
from crawler.runner import ENV_FILE
from crawler.sources.base import redact_secrets
from crawler.sources.openalex import OpenAlexClient, downloadable
from crawler.store import STORE_LOCK, _connect

logger = logging.getLogger(__name__)


class RefreshReport(BaseModel):
    scanned: int = 0
    changed: int = 0
    unchanged: int = 0
    conflicts: int = 0
    lookup_failures: int = 0


async def refresh_documents(
    url: str,
    *,
    source: SourceName | None = None,
    limit: int | None = None,
    batch_size: int = 50,
    open_access: OpenAlexClient | None = None,
) -> RefreshReport:
    """Refresh enrichment only, in bounded batches. Concurrent content changes are not overwritten.

    Does not modify retrieved_at, expiry, provenance, citations, or crawl resume dates.
    Failed OpenAlex batches retain valid previous links; known blocked links are removed.
    """
    if batch_size < 1 or batch_size > 50 or (limit is not None and limit < 1):
        raise ValueError("batch_size must be 1..50 and limit must be positive")
    load_dotenv(ENV_FILE)
    client = open_access if open_access is not None else OpenAlexClient.from_env()
    report = RefreshReport()
    after = ""
    async with _connect(url) as connection:
        # A fixed upper bound prevents concurrent insertions from extending the run forever.
        last = await connection.fetchval(
            "SELECT max(id) FROM documents WHERE ($1::text IS NULL OR source = $1)", source
        )
        while last and (limit is None or report.scanned < limit):
            size = min(batch_size, limit - report.scanned) if limit is not None else batch_size
            rows = await connection.fetch(
                "SELECT id, source, title, summary, doi, full_text, licence, external_ids, extra,"
                " changed_at FROM documents WHERE id > $1 AND id <= $2"
                " AND ($3::text IS NULL OR source = $3) ORDER BY id LIMIT $4",
                after,
                last,
                source,
                size,
            )
            if not rows:
                break
            dois = [
                row["doi"]
                for row in rows
                if row["source"] == "pubmed" and row["doi"] and not json.loads(row["full_text"])
            ]
            # Also replace old OpenAlex locators that are now known to block downloads.
            for row in rows:
                if (
                    row["source"] == "pubmed"
                    and row["doi"]
                    and "openalex" in json.loads(row["external_ids"])
                    and json.loads(row["full_text"])
                    and not any(downloadable(item["url"]) for item in json.loads(row["full_text"]))
                ):
                    dois.append(row["doi"])
            copies = {}
            if dois:
                try:
                    copies = await asyncio.to_thread(client.open_access, dois)
                except (OSError, ValueError) as error:
                    report.lookup_failures += 1
                    logger.warning("OpenAlex refresh failed: %s", redact_secrets(str(error)))
            async with connection.transaction():
                await connection.execute("SELECT pg_advisory_xact_lock($1)", STORE_LOCK)
                for row in rows:
                    extra = json.loads(row["extra"])
                    extra.pop(METADATA_LANGUAGE, None)
                    detected = detect_language(row["title"], row["summary"])
                    if detected:
                        extra[METADATA_LANGUAGE] = detected
                    links = json.loads(row["full_text"])
                    external_ids = json.loads(row["external_ids"])
                    if "openalex" in external_ids:
                        links = [link for link in links if downloadable(link["url"])]
                    licence = row["licence"]
                    copy = (
                        copies.get(row["doi"]) if row["source"] == "pubmed" and not links else None
                    )
                    if copy:
                        links = [locator.model_dump(mode="json") for locator in copy.full_text]
                        licence = licence or copy.licence
                        if copy.openalex_id:
                            external_ids["openalex"] = copy.openalex_id
                    values = (extra, links, licence, external_ids)
                    previous = (
                        json.loads(row["extra"]),
                        json.loads(row["full_text"]),
                        row["licence"],
                        json.loads(row["external_ids"]),
                    )
                    report.scanned += 1
                    if values == previous:
                        report.unchanged += 1
                        continue
                    updated = await connection.fetchval(
                        "UPDATE documents SET extra = $1::jsonb, full_text = $2::jsonb,"
                        " licence = $3, external_ids = $4::jsonb, changed_at = now()"
                        " WHERE id = $5 AND changed_at = $6 RETURNING id",
                        json.dumps(extra),
                        json.dumps(links),
                        licence,
                        json.dumps(external_ids),
                        row["id"],
                        row["changed_at"],
                    )
                    if updated:
                        report.changed += 1
                    else:
                        report.conflicts += 1
            after = rows[-1]["id"]
    return report
