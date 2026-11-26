"""Runs: crawler runs with their tracing wrappers, runs on disk, and the run form as the
crawler's arguments."""

import asyncio
import contextlib
import io
import json
import logging
import os
import re
import shlex
import time
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import common
from common import ENV_KEYS, HERE, LOCK, EventLog, describe_error, refresh_env
from pydantic import ValidationError

from crawler.cli import parser as cli_parser
from crawler.cli import refresh_videos, requests_from_args
from crawler.links.base import LinkExtractor
from crawler.models import ScrapeRequest, SourceDocument, SourceName, validation_message
from crawler.runner import ENV_FILE, link_extractor_from_env, run_requests, source_from_env
from crawler.seeds import TOPICS_DIR, TopicFileError, load_topic
from crawler.sources.base import BaseScraper, redact_secrets
from crawler.store import (
    RunInfo,
    StoreError,
    database_url,
    prepare_store,
    save_result,
)

RUNS_DIR = HERE / "runs"
RUN_ID = re.compile(r"[0-9A-Za-z-]+")
SUMMARIES: dict[str, dict[str, Any]] = {}


class Run(EventLog):
    def __init__(self, argv: list[str]) -> None:
        super().__init__()
        self.argv = argv
        self.command = "uv run crawler " + shlex.join(argv)
        self.error: str | None = None
        self.result: dict[str, Any] | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.task: asyncio.Task[Any] | None = None
        self.cancel_requested = False
        self.store_url: str | None = None
        """`DATABASE_URL` when the run is stored like `crawler --store`."""
        self.stored: dict[str, Any] | None = None

    def summary(self) -> dict[str, Any]:
        stats = (self.result or {}).get("stats") or {}
        return {
            "id": self.id,
            "command": self.command,
            "started_at": self.started_at,
            "status": self.status,
            "duration": self.duration,
            "documents": stats.get("documents"),
            "failures": len((self.result or {}).get("failures") or []),
            "error": self.error,
            "stored": (self.stored or {}).get("run_id"),
        }

    def to_json(self) -> dict[str, Any]:
        return {**self.summary(), "argv": self.argv, "result": self.result, "events": self.events}


class TracedScraper(BaseScraper):
    """Wraps a real scraper and reports every source call as an event."""

    def __init__(self, inner: BaseScraper, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def scrape(self, request: ScrapeRequest) -> list[SourceDocument]:
        detail: str | None
        if request.is_lookup:
            kind, detail = "lookup", f"{len(request.ids)} IDs"
        elif request.channel or request.feed:
            kind, detail = "channel", request.seed_label
        else:
            kind, detail = "search", request.query
        base = {"kind": kind, "source": request.source.value, "detail": detail}
        self.run.emit("request_start", **base)
        start = time.monotonic()
        try:
            documents = self.inner.scrape(request)
        except Exception as error:
            seconds = round(time.monotonic() - start, 2)
            self.run.emit("request_error", **base, seconds=seconds, error=describe_error(error))
            raise
        self.run.emit(
            "request_done",
            **base,
            seconds=round(time.monotonic() - start, 2),
            count=len(documents),
            requested=len(request.ids) if request.is_lookup else None,
            docs=[
                {"id": document.id, "title": document.title, "type": document.content_type}
                for document in documents
            ],
        )
        return documents


class TracedExtractor(LinkExtractor):
    """Wraps a real link extractor and reports the citation edges it finds."""

    def __init__(self, inner: LinkExtractor, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def cited_ids(self, native_ids: Sequence[str]) -> dict[str, list[str]]:
        prefix = self.source.value
        base = {"kind": "references", "source": prefix, "detail": f"{len(native_ids)} papers"}
        self.run.emit("request_start", **base)
        start = time.monotonic()
        try:
            cited = self.inner.cited_ids(native_ids)
        except Exception as error:
            seconds = round(time.monotonic() - start, 2)
            self.run.emit("request_error", **base, seconds=seconds, error=describe_error(error))
            raise
        self.run.emit(
            "request_done",
            **base,
            seconds=round(time.monotonic() - start, 2),
            count=sum(len(values) for values in cited.values()),
            edges={
                f"{prefix}:{citing}": [f"{prefix}:{value}" for value in values]
                for citing, values in cited.items()
            },
        )
        return cited


class EventLogHandler(logging.Handler):
    """Forwards the runner's one-line retry messages to the current run."""

    def emit(self, record: logging.LogRecord) -> None:
        run = common.CURRENT
        if run is not None and run.status == "running":
            run.emit("retry", message=record.getMessage())


def show_warning(message: Any, category: Any, *_args: Any, **_kwargs: Any) -> None:
    text = str(message).strip()
    first_line = text.splitlines()[0] if text else ""
    run = common.CURRENT
    if run is not None and run.status == "running":
        run.emit("warning", message=f"{category.__name__}: {first_line}")
    else:
        print(f"{category.__name__}: {first_line}")


def execute(run: Run, seeds: list[Any], options: Any) -> None:
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    run.loop = loop

    def sources(source: SourceName) -> TracedScraper:
        return TracedScraper(source_from_env(source), run)

    def extractors(source: SourceName) -> TracedExtractor | None:
        inner = link_extractor_from_env(source)
        return None if inner is None else TracedExtractor(inner, run)

    async def sleep(seconds: float) -> None:
        run.emit("backoff", seconds=seconds)
        await asyncio.sleep(seconds)

    try:
        run.task = loop.create_task(
            run_requests(
                seeds,
                options=options,
                source_factory=sources,
                link_extractor_factory=extractors,
                sleep=sleep,
            )
        )
        result = loop.run_until_complete(run.task)
        run.result = result.model_dump(mode="json")
        run.duration = round(time.monotonic() - run.started, 2)
        # Crawlee stops on cancellation and returns what it has, so the result is partial.
        status = "cancelled" if run.cancel_requested else "finished"
        run.emit(
            "run_cancelled" if run.cancel_requested else "run_finished",
            ok=result.ok,
            documents=len(result.documents),
            failures=len(result.failures),
            run_error=result.run_error,
        )
        # Still running while it stores, so the live log gets the store lines before its end.
        if run.store_url is not None and status == "finished":
            store(run, loop, seeds, result)
        with run.changed:
            run.status = status
            run.changed.notify_all()
    except asyncio.CancelledError:
        run.duration = round(time.monotonic() - run.started, 2)
        run.status = "cancelled"
        run.emit("run_cancelled")
    except Exception as error:
        run.duration = round(time.monotonic() - run.started, 2)
        run.error = describe_error(error)
        run.status = "failed"
        run.emit("run_failed", error=run.error)
    finally:
        with contextlib.suppress(Exception):
            loop.close()
        save(run)
        with LOCK:
            common.CURRENT = None


def prepare(source: str, options: Any) -> tuple[str, Any]:
    """Like `crawler --store` before a crawl: check the database, skip stored cited papers."""
    try:
        url = database_url()
        stored = asyncio.run(prepare_store(url, SourceName(source), load_ids=options.max_depth > 0))
    except StoreError as error:
        raise ValueError(str(error)) from error
    return url, options.model_copy(update={"known_ids": options.known_ids | stored})


def store(run: Run, loop: asyncio.AbstractEventLoop, seeds: list[Any], result: Any) -> None:
    """Like `crawler --store` after a crawl, but several topics as one run, where the command
    line makes one of each; cancelled runs are not stored."""
    assert run.store_url is not None
    run.emit("store_started")
    info = RunInfo(
        source=SourceName(run.argv[0]),
        topics=list(dict.fromkeys(topic for seed in seeds for topic in seed.topics)),
        arguments=run.argv,
        started_at=datetime.fromisoformat(run.started_at),
        finished_at=datetime.now(UTC),
    )
    refreshed: list[Any] = []
    if info.source is SourceName.YOUTUBE:
        try:
            due, refreshed = loop.run_until_complete(refresh_videos(run.store_url, seeds, result))
        except Exception as error:
            message = redact_secrets(describe_error(error))
            run.emit("warning", message=f"Refreshing stored videos failed: {message}")
        else:
            run.emit("refreshed", due=due, refreshed=len(refreshed))
    try:
        report = loop.run_until_complete(
            save_result(run.store_url, result, info, refreshed=refreshed)
        )
    except StoreError as error:
        run.emit("store_failed", error=str(error))
        return
    run.stored = report.model_dump()
    run.emit("stored", **run.stored)


def save(run: Run) -> None:
    RUNS_DIR.mkdir(exist_ok=True)
    (RUNS_DIR / f"{run.id}.json").write_text(
        json.dumps(run.to_json(), ensure_ascii=False), encoding="utf-8"
    )
    SUMMARIES[run.id] = run.summary()


def load_summaries() -> None:
    if not RUNS_DIR.exists():
        return
    for path in RUNS_DIR.glob("*.json"):
        with contextlib.suppress(OSError, ValueError):
            data = json.loads(path.read_text(encoding="utf-8"))
            SUMMARIES[data["id"]] = {
                key: data.get(key)
                for key in (
                    "id",
                    "command",
                    "started_at",
                    "status",
                    "duration",
                    "documents",
                    "failures",
                    "error",
                    "stored",
                )
            }


def list_runs() -> list[dict[str, Any]]:
    runs = sorted(SUMMARIES.values(), key=lambda run: run["id"], reverse=True)
    current = common.CURRENT
    if current is not None:
        runs = [current.summary(), *[run for run in runs if run["id"] != current.id]]
    return runs[:100]


def load_run(run_id: str) -> dict[str, Any] | None:
    current = common.CURRENT
    if current is not None and current.id == run_id:
        return current.to_json()
    if not RUN_ID.fullmatch(run_id):
        return None
    path = RUNS_DIR / f"{run_id}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def delete_all_runs() -> int:
    deleted = 0
    for run_id in list(SUMMARIES):
        deleted += delete_run(run_id)
    return deleted


def delete_run(run_id: str) -> bool:
    if not RUN_ID.fullmatch(run_id) or (common.CURRENT is not None and common.CURRENT.id == run_id):
        return False
    path = RUNS_DIR / f"{run_id}.json"
    SUMMARIES.pop(run_id, None)
    if path.exists():
        path.unlink()
        return True
    return False


def build_argv(body: dict[str, Any]) -> list[str]:
    source = body.get("source")
    if source not in ("pubmed", "arxiv", "zenodo", "youtube", "podcast"):
        raise ValueError("Unknown source")
    argv = [source]

    def add(flag: str, value: Any) -> None:
        if value not in (None, ""):
            argv.extend([flag, str(value)])

    add("--max-results", body.get("max_results"))
    if source in ("pubmed", "arxiv"):
        add("--max-depth", body.get("max_depth"))
        if body.get("min_citations") != 1:
            add("--min-citations", body.get("min_citations"))
    add("--since", body.get("since"))
    if source in ("arxiv", "zenodo"):
        add("--query-mode", body.get("query_mode"))
    add("--max-requests", body.get("max_requests"))
    if body.get("store") is True:
        argv.append("--store")

    if body.get("mode") == "topic":
        topics = [str(topic) for topic in body.get("topics") or [] if topic]
        if not topics:
            raise ValueError("Select at least one topic")
        for topic in topics:
            argv.extend(["--topic", topic])
    else:
        value = str(body.get("query") or "").strip()
        if not value:
            missing = {"youtube": "Enter a channel", "podcast": "Enter a feed key"}
            raise ValueError(missing.get(source, "Enter a query"))
        argv.extend(["--", value] if value.startswith("-") else [value])
    return argv


def parse_run(argv: list[str]) -> tuple[list[Any], Any]:
    errors = io.StringIO()
    try:
        with contextlib.redirect_stderr(errors):
            arguments = cli_parser().parse_args(argv)
    except SystemExit as error:
        lines = errors.getvalue().strip().splitlines()
        raise ValueError(lines[-1] if lines else "Invalid arguments") from error
    try:
        return requests_from_args(arguments)
    except ValidationError as error:  # a ValueError too: catch it first, without pydantic's dump
        raise ValueError(validation_message(error)) from error
    except (TopicFileError, ValueError) as error:
        raise ValueError(str(error)) from error


def meta() -> dict[str, Any]:
    topics: list[dict[str, Any]] = []
    feeds: dict[str, dict[str, str]] = {}
    for path in sorted(TOPICS_DIR.glob("*.yaml")):
        try:
            topic = load_topic(path)
        except TopicFileError as error:
            topics.append({"id": path.stem, "label": path.stem, "error": str(error)})
            continue
        topics.append(
            {
                "id": topic.id,
                "label": topic.label,
                "queries": len(topic.queries),
                "channels": len(topic.channels),
                "podcasts": len(topic.podcasts),
                "terms": topic.terms,
            }
        )
        for feed in topic.podcasts:
            feeds.setdefault(
                feed.key, {"key": feed.key, "name": feed.name, "audience": feed.audience}
            )
    env = (
        refresh_env() if common.CURRENT is None else {k: bool(os.environ.get(k)) for k in ENV_KEYS}
    )
    try:
        database = bool(database_url())
    except StoreError:
        database = False
    return {
        "env": env,
        "env_file": str(ENV_FILE),
        "env_file_exists": ENV_FILE.exists(),
        "database": database,
        "topics": topics,
        "feeds": list(feeds.values()),
        "running": common.CURRENT.id if common.CURRENT is not None else None,
    }
