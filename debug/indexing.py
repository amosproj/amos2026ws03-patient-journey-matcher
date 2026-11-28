"""Index screens: the indexer job, what the indexes hold, and the transcription job."""

import json
import os
import re
import signal
import subprocess
import threading
import time
from typing import Any

import common
from common import (
    LOCK,
    MATCHER_DIR,
    NOT_EXPIRED,
    SLOW_QUERY,
    URL_PASSWORD,
    EventLog,
    describe_error,
    fetch_json,
    first,
    full_text_state,
    has_keyword_index,
    matcher_missing,
    page,
    to_index,
)
from encoder import encoder_state, with_encoder
from info import JOB_REPORTS, transcribe_unit

from crawler.store import (
    StoreError,
    database_url,
)

NO_INDEX = (
    "(SELECT NULL::text AS document_id, NULL::timestamptz AS document_changed_at,"
    " NULL::text AS status WHERE false)"
)
"""Stands in for an index table before the first `make index`: every document is to index."""
WORD_BUCKETS = [100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 50000]
"""Keywords per full text, for the histogram; 50,000 is the indexer's limit (`MAX_WORDS`)."""
# The estimate of Index › Keyword copies two rules of matcher/download/src: the media types
# `formatOf` reads (extract.ts) and the seconds between two requests to a host (`INTERVAL_MS`
# in downloader.ts). Keep them in step; the indexer itself does not use these copies.
READABLE_TYPES = [
    "application/pdf",
    "application/xml",
    "text/xml",
    "text/html",
    "application/xhtml+xml",
    "text/vtt",
    "application/srt",
    "application/x-subrip",
    "text/srt",
    "text/plain",
]
HOST_INTERVAL = {"arxiv.org": 15, "zenodo.org": 1, "pmc-oa-opendata.s3.amazonaws.com": 0.1}
DEFAULT_INTERVAL = 3
GERMAN_TERMS = MATCHER_DIR / "algorithms" / "keyword" / "data" / "german-terms.json"
TERM_DOCUMENTS = """
WITH terms AS MATERIALIZED (
    SELECT term, plainto_tsquery('english', term) AS query FROM unnest($1::text[]) AS term),
metadata AS MATERIALIZED (
    SELECT to_tsvector('english', content) AS lexemes FROM keyword.documents)
SELECT term, numnode(query) = 0 AS stop_words,
       (SELECT count(*) FROM metadata WHERE lexemes @@ query) AS metadata,
       (SELECT count(*) FROM keyword.full_texts
        WHERE status = 'indexed' AND lexemes @@ query) AS full_text
FROM terms
"""
"""In how many documents each term is found, by the rule of the matcher's `matched_terms`."""


def matcher_environment() -> dict[str, str]:
    """The environment of the matcher's programs: this one plus the crawler's `DATABASE_URL`
    and the encoder that this server started."""
    missing = matcher_missing()
    if missing:
        raise ValueError(missing)
    try:
        return with_encoder({**os.environ, "DATABASE_URL": database_url()})
    except StoreError as error:
        raise ValueError(str(error)) from error


INDEX_TECHNIQUES = {
    "all": ([], None, "make index"),
    "keyword": (["keyword"], None, "make index APPROACHES=keyword"),
    "graph": (["graph"], None, "make index APPROACHES=graph"),
    "semantic": (["ai_summary"], "qwen,bge", "make index-ai"),
    "qwen": (["ai_summary"], "qwen", "make index-ai SEMANTIC_MODELS=qwen"),
    "bge": (["ai_summary"], "bge", "make index-ai SEMANTIC_MODELS=bge"),
}


class IndexRun(EventLog):
    """One run of the indexer job (`make index`); its output lines are the events."""

    def __init__(self, technique: str = "all") -> None:
        super().__init__()
        arguments, models, command = INDEX_TECHNIQUES[technique]
        self.arguments = arguments
        self.approach = arguments[0] if arguments else None
        self.models = models
        self.command = command
        self.process: subprocess.Popen[str] | None = None
        self.cancel_requested = False

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "command": self.command,
            "approach": self.approach,
            "started_at": self.started_at,
            "status": self.status,
            "duration": self.duration,
        }


def run_indexer(run: IndexRun, environment: dict[str, str]) -> None:
    """Runs the indexer job like `make index` and reports its output line by line."""
    run.emit("index_started", command=run.command)
    code: int | None = None
    try:
        run.process = subprocess.Popen(
            ["node", "src/main.ts", *run.arguments],
            cwd=MATCHER_DIR / "indexer",
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert run.process.stdout is not None
        for line in run.process.stdout:
            run.emit("line", text=URL_PASSWORD.sub(r"\1<redacted>@", line.rstrip()))
        code = run.process.wait()
    except OSError as error:
        run.emit("line", text=describe_error(error))
    finally:
        run.duration = round(time.monotonic() - run.started, 2)
        # Together, so that a stream never ends before the last event.
        with run.changed:
            if run.cancel_requested:
                run.status = "cancelled"
            else:
                run.status = "finished" if code == 0 else "failed"
            run.emit("index_" + run.status, code=code)


def start_indexer(technique: str = "all") -> IndexRun:
    if not isinstance(technique, str) or technique not in INDEX_TECHNIQUES:
        raise ValueError("Choose all, keyword, graph, semantic, qwen or bge")
    if INDEX_TECHNIQUES[technique][1] and encoder_state()["status"] != "running":
        raise RuntimeError("The AI index needs the encoder: start it and wait until it runs")
    environment = matcher_environment()
    with LOCK:
        if common.INDEXING is not None and common.INDEXING.status == "running":
            raise RuntimeError("The indexer is already running")
        run = common.INDEXING = IndexRun(technique)
        if run.models:
            environment["SEMANTIC_MODEL"] = run.models.split(",")[0]
            environment["SEMANTIC_MODELS"] = run.models
    threading.Thread(target=run_indexer, args=(run, environment), daemon=True).start()
    return run


def stop_indexer() -> dict[str, Any]:
    """Like Ctrl+C: the next run continues with the documents not read yet."""
    run = common.INDEXING
    if run is None or run.status != "running" or run.process is None:
        raise RuntimeError("The indexer is not running")
    run.cancel_requested = True
    run.emit("cancel_requested")
    run.process.send_signal(signal.SIGINT)
    return run.summary()


def indexer_state(*, events: bool = False) -> dict[str, Any]:
    run = common.INDEXING
    state: dict[str, Any] = {
        "missing": matcher_missing(),
        "run": run.summary() if run else None,
        "techniques": list(INDEX_TECHNIQUES),
    }
    if events and run is not None:
        state["events"] = list(run.events)
    return state


async def graph_index_stats(connection: Any) -> dict[str, Any]:
    """PubMed coverage of `graph.documents` for the Index overview."""
    exists = bool(await connection.fetchval("SELECT to_regclass('graph.documents') IS NOT NULL"))
    pubmed = int(
        await connection.fetchval(
            f"SELECT count(*) FROM documents AS d WHERE d.source = 'pubmed' AND {NOT_EXPIRED}"
        )
    )
    if not exists:
        return {
            "exists": False,
            "pubmed": pubmed,
            "indexed": 0,
            "with_entities": 0,
            "with_relations": 0,
            "retrying": 0,
        }
    [counts] = await fetch_json(
        connection,
        f"""SELECT count(g.document_id) FILTER (WHERE NOT isfinite(g.retry_at)) AS indexed,
                   count(*) FILTER (WHERE g.entities <> '{{}}'::jsonb) AS with_entities,
                   count(*) FILTER (WHERE jsonb_array_length(g.relations) > 0) AS with_relations,
                   count(g.document_id) FILTER (WHERE isfinite(g.retry_at)) AS retrying
            FROM documents AS d
            LEFT JOIN graph.documents AS g ON g.document_id = d.id
            WHERE d.source = 'pubmed' AND {NOT_EXPIRED}""",
    )
    return {"exists": True, "pubmed": pubmed, **counts}


def semantic_profiles() -> list[dict[str, Any]]:
    """Read the canonical encoder configuration and table names from the matcher."""
    script = (
        "import {configuration,indexTable} from '../algorithms/ai-summary/src/encoder.ts';"
        "console.log(JSON.stringify(['qwen','bge'].map(model=>"
        "({...configuration(model),table:indexTable(model)}))));"
    )
    done = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=MATCHER_DIR / "indexer",
        env=dict(os.environ),
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    return json.loads(done.stdout)


async def semantic_overview(connection: Any, technique: str) -> dict[str, Any]:
    profiles = semantic_profiles()
    chosen = [p for p in profiles if technique == "semantic" or p["model"] == technique]
    has_ready = await connection.fetchval("SELECT to_regclass('ai_summary.ready') IS NOT NULL")
    models = []
    for profile in chosen:
        table = profile["table"]
        if not re.fullmatch(r"ai_summary\.[a-z][a-z0-9_]+", table):
            raise ValueError("Invalid semantic index table")
        exists = bool(await connection.fetchval("SELECT to_regclass($1) IS NOT NULL", table))
        index = (
            table
            if exists
            else (
                "(SELECT NULL::text AS document_id, NULL::timestamptz AS document_changed_at,"
                " NULL::text AS embedding WHERE false)"
            )
        )
        pending = to_index("i")
        coverage = await fetch_json(
            connection,
            f"""
            SELECT d.source, d.content_type, count(*) AS documents,
                   count(*) FILTER (WHERE NOT {pending} AND i.embedding IS NOT NULL) AS indexed,
                   count(*) FILTER (WHERE {pending}) AS pending,
                   count(*) FILTER (WHERE NOT {pending} AND i.embedding IS NULL) AS empty
            FROM documents AS d LEFT JOIN {index} AS i ON i.document_id = d.id
            WHERE {NOT_EXPIRED}
            GROUP BY 1, 2 ORDER BY 1, 2
        """,
        )
        totals = {
            key: sum(row[key] for row in coverage)
            for key in ("documents", "indexed", "pending", "empty")
        }
        ready = (
            exists
            and has_ready
            and bool(
                await connection.fetchval(
                    "SELECT EXISTS (SELECT 1 FROM ai_summary.ready WHERE index_table = $1)", table
                )
            )
        )
        models.append({**profile, **totals, "ready": ready, "coverage": coverage})
    return {"technique": technique, "indexer": indexer_state(), "models": models}


async def index_overview(connection: Any, technique: str = "keyword") -> dict[str, Any]:
    if technique not in INDEX_TECHNIQUES:
        raise ValueError("Unknown indexing technique")
    if technique in ("semantic", "qwen", "bge"):
        return await semantic_overview(connection, technique)
    exists = await has_keyword_index(connection)
    metadata = "keyword.documents" if exists else NO_INDEX
    full_texts = "keyword.full_texts" if exists else NO_INDEX
    [extension] = await fetch_json(
        connection,
        """SELECT (SELECT default_version FROM pg_available_extensions
                   WHERE name = 'pg_textsearch') AS available,
                  (SELECT extversion FROM pg_extension WHERE extname = 'pg_textsearch')
                      AS installed,
                  current_setting('shared_preload_libraries') ~ '\\mpg_textsearch\\M'
                      AS preloaded""",
    )
    overview: dict[str, Any] = {
        "technique": technique,
        "exists": exists,
        "extension": extension,
        "indexer": indexer_state(),
        "graph": await graph_index_stats(connection),
        # The stacked bars: the state of each document's full text (`full_text_state`).
        "coverage": await fetch_json(
            connection,
            f"""SELECT d.source, d.content_type, count(*) AS documents,
                       count(m.document_id) AS metadata,
                       count(*) FILTER (WHERE {to_index("m")}) AS metadata_to_index,
                       count(*) FILTER (WHERE s.state = 'indexed') AS indexed,
                       count(*) FILTER (WHERE s.state = 'skipped') AS skipped,
                       count(*) FILTER (WHERE s.state = 'failed') AS failed,
                       count(*) FILTER (WHERE s.state IN ('new', 'changed')) AS unread,
                       count(*) FILTER (WHERE s.state NOT IN ('indexed', 'skipped')) AS to_read
                FROM documents AS d
                LEFT JOIN {metadata} AS m ON m.document_id = d.id
                LEFT JOIN {full_texts} AS i ON i.document_id = d.id
                CROSS JOIN LATERAL (SELECT {full_text_state("i", "d")} AS state) AS s
                WHERE {NOT_EXPIRED}
                GROUP BY 1, 2 ORDER BY 1, 2""",
        ),
        # Where the next run downloads from: the host of the first file the downloader reads.
        "hosts": await fetch_json(
            connection,
            f"""SELECT file.host, count(*) AS documents
                FROM documents AS d
                LEFT JOIN {full_texts} AS i ON i.document_id = d.id
                LEFT JOIN LATERAL (
                    SELECT substring(e.locator ->> 'url' from '^[a-z]+://([^/:?#]+)') AS host
                    FROM jsonb_array_elements(d.full_text) WITH ORDINALITY AS e (locator, position),
                         lower(trim(split_part(coalesce(e.locator ->> 'media_type', ''), ';', 1)))
                             AS media_type
                    WHERE media_type = ANY ($1::text[])
                       OR (media_type = 'application/json' AND e.locator ->> 'kind' = 'transcript')
                    ORDER BY e.position LIMIT 1
                ) AS file ON true
                WHERE {NOT_EXPIRED}
                  AND {full_text_state("i", "d")} NOT IN ('indexed', 'skipped')
                GROUP BY 1 ORDER BY 2 DESC, 1""",
            READABLE_TYPES,
        ),
    }
    for host in overview["hosts"]:
        interval = HOST_INTERVAL.get(host["host"], DEFAULT_INTERVAL)
        host["seconds"] = None if host["host"] is None else round(host["documents"] * interval)
    if not exists:
        return overview
    # Like the coverage: a changed document counts as to read, whatever its old row says.
    overview["reasons"] = await fetch_json(
        connection,
        f"""SELECT i.status, i.detail, count(*) AS documents
            FROM keyword.full_texts AS i JOIN documents AS d ON d.id = i.document_id
            WHERE {NOT_EXPIRED} AND {full_text_state("i", "d")} <> 'changed'
            GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2""",
    )
    overview["formats"] = await fetch_json(
        connection,
        "SELECT media_type, count(*) AS documents, sum(words) AS words FROM keyword.full_texts"
        " WHERE status = 'indexed' GROUP BY 1 ORDER BY 2 DESC, 1",
    )
    [words] = await fetch_json(
        connection,
        """SELECT count(*) AS documents, coalesce(sum(words), 0) AS words, min(words) AS min,
                  max(words) AS max, max(fetched_at) AS last_read,
                  percentile_disc(0.5) WITHIN GROUP (ORDER BY words) AS median
           FROM keyword.full_texts WHERE status = 'indexed'""",
    )
    counts = {
        row["bucket"]: row["documents"]
        for row in await fetch_json(
            connection,
            "SELECT width_bucket(words, $1::int[]) AS bucket, count(*) AS documents"
            " FROM keyword.full_texts WHERE status = 'indexed' GROUP BY 1",
            WORD_BUCKETS,
        )
    }
    edges = [1, *WORD_BUCKETS]
    words["buckets"] = [
        {
            "from": edge,
            "to": edges[index + 1] - 1 if index + 1 < len(edges) else None,
            "documents": counts.get(index, 0),
        }
        for index, edge in enumerate(edges)
    ]
    overview["words"] = words
    return overview


async def index_vocabulary(connection: Any, params: dict[str, list[str]]) -> dict[str, Any]:
    """The most frequent keywords of all full texts: what the keyword filter lets through."""
    if not await has_keyword_index(connection):
        raise ValueError("No keyword index yet: run make index")
    limit, _ = page(params)
    needle = first(params, "q").lower()
    return {
        "rows": await fetch_json(
            connection,
            """SELECT top.*, tsvector_to_array(to_tsvector('english', top.word)) AS stems
               FROM (SELECT word, count(*) AS count, count(DISTINCT i.document_id) AS documents
                     FROM keyword.full_texts AS i, string_to_table(i.terms, ' ') AS word
                     WHERE i.status = 'indexed' AND word <> '' AND strpos(word, $2) > 0
                     GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT $1) AS top
               ORDER BY top.count DESC, top.word""",
            limit,
            needle,
            timeout=SLOW_QUERY,
        ),
        "documents": await connection.fetchval(
            "SELECT count(*) FROM keyword.full_texts WHERE status = 'indexed'"
        ),
    }


async def term_documents(connection: Any, terms: list[str]) -> dict[str, Any]:
    """In how many documents each of `terms` is found, with the totals to compare with."""
    if not await has_keyword_index(connection):
        raise ValueError("No keyword index yet: run make index")
    [totals] = await fetch_json(
        connection,
        "SELECT (SELECT count(*) FROM keyword.documents) AS metadata,"
        " (SELECT count(*) FROM keyword.full_texts WHERE status = 'indexed') AS full_text",
    )
    rows = await fetch_json(connection, TERM_DOCUMENTS, terms, timeout=SLOW_QUERY)
    return {"totals": totals, "terms": rows}


async def journey_terms(connection: Any) -> dict[str, Any]:
    """The English terms of german-terms.json and how many documents each finds."""
    translations: dict[str, str] = json.loads(GERMAN_TERMS.read_text(encoding="utf-8"))[
        "translations"
    ]
    german: dict[str, list[str]] = {}
    for word, term in translations.items():
        german.setdefault(term, []).append(word)
    result = await term_documents(connection, list(german))
    for row in result["terms"]:
        row["german"] = german[row["term"]]
    return result


# ── Transcription job: its setting, and what it reports (the table transcription) ──

NO_SPEECH_TO_TEXT = "audio, and speech-to-text is off"
"""Why an index skipped a document whose audio has no stored transcript yet (@matcher/download)."""
# The documents that wait for the job: `WAITING` in matcher/transcriber/src/job.ts. Keep the two
# in step; the job itself does not use this copy.
WAITING_AUDIO = f"""
FROM documents AS d LEFT JOIN transcripts AS t ON t.document_id = d.id
WHERE d.full_text @> '[{{"kind": "audio"}}]' AND NOT d.full_text @> '[{{"kind": "transcript"}}]'
  AND {NOT_EXPIRED}
  AND (jsonb_typeof(d.extra -> 'metadata_language') = 'string'
       AND d.extra ->> 'metadata_language' <> ''
       AND d.extra ->> 'metadata_language' !~* '^en(-|$)') IS NOT TRUE
  AND (t.document_id IS NULL
       OR NOT d.full_text @> jsonb_build_array(jsonb_build_object('url', t.url))
       OR (t.status = 'failed' AND t.read_at < now() - interval '1 day'))
"""


def default_max_workers() -> int:
    """The most files a job on this machine reads at once, until a job reports its own.

    The rule of matcher/transcriber/src/main.ts: four threads per file.
    """
    cpus = os.cpu_count() or 1
    return max(1, cpus // min(4, cpus))


async def transcription_overview(connection: Any) -> dict[str, Any]:
    """The setting, what the job reported last, and how much audio waits or is read."""
    overview: dict[str, Any] = {
        "exists": False,
        "workers": 0,
        "running": False,
        "state": None,
        "reported_at": None,
        "max_workers": default_max_workers(),
        "cpus": os.cpu_count(),
        "unit": transcribe_unit(),
        "waiting_detail": NO_SPEECH_TO_TEXT,
        "waiting": None,
        "read": [],
    }
    if not await connection.fetchval("SELECT to_regclass('public.transcripts') IS NOT NULL"):
        return overview
    overview["exists"] = True
    rows = await fetch_json(
        connection,
        f"""SELECT workers, state, reported_at,
                   coalesce(reported_at > now() - interval '{JOB_REPORTS} seconds', false)
                       AS running
            FROM transcription""",
    )
    if rows:
        overview.update(rows[0])
        reported = (overview["state"] or {}).get("max_workers")
        overview["max_workers"] = reported or overview["max_workers"]
    [overview["waiting"]] = await fetch_json(
        connection,
        f"""SELECT count(*) AS documents, coalesce(sum(d.duration_seconds), 0) AS seconds,
                   count(*) FILTER (WHERE d.duration_seconds IS NULL) AS unknown
            {WAITING_AUDIO}""",
    )
    # What became of the audio read so far, whichever run read it.
    overview["read"] = await fetch_json(
        connection,
        """SELECT t.status, count(*) AS documents, coalesce(sum(d.duration_seconds), 0) AS seconds
           FROM transcripts AS t JOIN documents AS d ON d.id = t.document_id
           GROUP BY 1 ORDER BY 1""",
    )
    return overview


async def set_transcription_workers(connection: Any, workers: Any) -> dict[str, Any]:
    """Sets how many audio files the job reads at once; the running job follows within seconds."""
    overview = await transcription_overview(connection)
    if not overview["exists"]:
        raise ValueError("This database has no transcription table yet: run make db")
    most = overview["max_workers"]
    if isinstance(workers, bool) or not isinstance(workers, int) or not 0 <= workers <= most:
        raise ValueError(f"workers must be a whole number from 0 to {most}")
    await connection.execute(
        "INSERT INTO transcription (workers) VALUES ($1)"
        " ON CONFLICT (only_row) DO UPDATE SET workers = EXCLUDED.workers",
        workers,
    )
    return await transcription_overview(connection)
