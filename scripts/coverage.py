"""Report stored links versus downloaded/read full texts after keyword indexing.

    cd crawler && uv run python ../scripts/coverage.py

Reads DATABASE_URL from the environment or crawler/.env. Does not download or change data.
"""

import asyncio
import json
import os
from pathlib import Path

import asyncpg
from dotenv import dotenv_values


async def main():
    url = os.environ.get("DATABASE_URL") or dotenv_values(
        Path(__file__).resolve().parents[1] / "crawler/.env"
    ).get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set")
    connection = await asyncpg.connect(url)
    try:
        if not await connection.fetchval("SELECT to_regclass('keyword.full_texts')"):
            raise SystemExit("Run make index APPROACHES=keyword before measuring readable coverage")
        rows = await connection.fetch("""
            SELECT d.source, count(*)::int AS documents,
              count(*) FILTER (WHERE jsonb_array_length(d.full_text) > 0)::int AS with_links,
              count(*) FILTER (WHERE jsonb_array_length(d.full_text) > 0
                AND NOT (d.source = 'pubmed' AND d.external_ids ? 'openalex'))::int
                AS with_links_without_openalex,
              count(*) FILTER (WHERE f.status = 'indexed' OR
                (f.status = 'skipped' AND f.detail IN ('not English', 'no keywords')))::int
                AS downloaded_and_read,
              count(*) FILTER (WHERE (f.status = 'indexed' OR
                (f.status = 'skipped' AND f.detail IN ('not English', 'no keywords')))
                AND NOT (d.source = 'pubmed' AND d.external_ids ? 'openalex'))::int
                AS read_without_openalex,
              count(*) FILTER (WHERE f.status = 'indexed')::int AS indexed,
              count(*) FILTER (WHERE f.status = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE f.status = 'failed')::int AS failed,
              count(*) FILTER (WHERE f.document_id IS NULL OR f.document_changed_at IS DISTINCT
                FROM date_trunc('milliseconds', d.changed_at))::int AS pending
            FROM documents d LEFT JOIN keyword.full_texts f ON f.document_id = d.id
              AND f.document_changed_at = date_trunc('milliseconds', d.changed_at)
            WHERE d.expires_at IS NULL OR d.expires_at > now()
            GROUP BY d.source ORDER BY d.source
        """)
        failures = await connection.fetch("""
            SELECT f.status, f.detail, f.url, count(*)::int AS documents
            FROM keyword.full_texts f JOIN documents d ON d.id = f.document_id
            WHERE f.status <> 'indexed' AND (d.expires_at IS NULL OR d.expires_at > now())
              AND f.document_changed_at = date_trunc('milliseconds', d.changed_at)
            GROUP BY f.status, f.detail, f.url ORDER BY f.status, f.detail, f.url
        """)
        sources = [dict(row) for row in rows]
        totals = {
            key: sum(row[key] for row in sources)
            for key in (
                "documents",
                "with_links",
                "with_links_without_openalex",
                "downloaded_and_read",
                "read_without_openalex",
                "indexed",
                "skipped",
                "failed",
                "pending",
            )
        }
        for row in [*sources, totals]:
            for column in (
                "with_links",
                "with_links_without_openalex",
                "downloaded_and_read",
                "read_without_openalex",
                "indexed",
            ):
                row[column + "_percent"] = (
                    round(100 * row[column] / row["documents"], 1) if row["documents"] else 0.0
                )
        print(
            json.dumps(
                {"sources": sources, "totals": totals, "unread": [dict(row) for row in failures]},
                indent=2,
            )
        )
    finally:
        await connection.close()


if __name__ == "__main__":
    asyncio.run(main())
