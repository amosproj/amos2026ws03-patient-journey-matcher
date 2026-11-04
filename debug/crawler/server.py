"""Debug UI for the crawler: start runs, watch them live, inspect the results.

Start it from the repository root with `make debug` (see debug/crawler/README.md). It runs in the
crawler's uv environment and only uses the crawler's public Python API (`run_requests`
with its factory and sleep hooks) and the standard library, so the crawler needs nothing
extra for it.
"""

import argparse
import asyncio
import contextlib
import io
import json
import logging
import os
import re
import shlex
import threading
import time
import uuid
import warnings
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from dotenv import dotenv_values
from pydantic import ValidationError

from crawler.cli import parser as cli_parser
from crawler.cli import requests_from_args
from crawler.runner import ENV_FILE, link_extractor_from_env, run_requests, source_from_env
from crawler.seeds import TOPICS_DIR, TopicFileError, load_topic

HERE = Path(__file__).resolve().parent
RUNS_DIR = HERE / "runs"
ENV_KEYS = ("NCBI_ENTREZ_EMAIL", "NCBI_API_KEY", "SEMANTIC_SCHOLAR_API_KEY", "YOUTUBE_API_KEY")
SHELL_KEYS = {key for key in ENV_KEYS if os.environ.get(key)}
RUN_ID = re.compile(r"[0-9A-Za-z-]+")

LOCK = threading.Lock()
CURRENT: "Run | None" = None
SUMMARIES: dict[str, dict[str, Any]] = {}


def describe_error(error: BaseException) -> str:
    return f"{type(error).__name__}: {error}"


def refresh_env() -> dict[str, bool]:
    """Re-read crawler/.env so edits apply without a restart; shell variables win."""
    values = dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}
    for key in ENV_KEYS:
        if key in SHELL_KEYS:
            continue
        value = (values.get(key) or "").strip()
        if value:
            os.environ[key] = value
        else:
            os.environ.pop(key, None)
    return {key: bool(os.environ.get(key)) for key in ENV_KEYS}


class Run:
    def __init__(self, argv: list[str]) -> None:
        self.id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        self.argv = argv
        self.command = "uv run crawler " + shlex.join(argv)
        self.started_at = datetime.now(UTC).isoformat(timespec="seconds")
        self.started = time.monotonic()
        self.duration: float | None = None
        self.status = "running"
        self.error: str | None = None
        self.result: dict[str, Any] | None = None
        self.events: list[dict[str, Any]] = []
        self.changed = threading.Condition()
        self.loop: asyncio.AbstractEventLoop | None = None
        self.task: asyncio.Task[Any] | None = None
        self.cancel_requested = False

    def emit(self, event_type: str, /, **data: Any) -> None:
        with self.changed:
            event = {
                "seq": len(self.events),
                "t": round(time.monotonic() - self.started, 2),
                "type": event_type,
                **data,
            }
            self.events.append(event)
            self.changed.notify_all()

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
        }

    def to_json(self) -> dict[str, Any]:
        return {**self.summary(), "argv": self.argv, "result": self.result, "events": self.events}


# ── Tracing wrappers: plugged in through run_requests' factory hooks ─────────────


class TracedScraper:
    """Wraps a real scraper and reports every source call as an event."""

    def __init__(self, inner: Any, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def scrape(self, request: Any) -> Any:
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
                {"id": document.id, "title": document.title, "type": document.source_type.value}
                for document in documents
            ],
        )
        return documents


class TracedExtractor:
    """Wraps a real link extractor and reports the citation edges it finds."""

    def __init__(self, inner: Any, run: Run) -> None:
        self.inner = inner
        self.source = inner.source
        self.run = run

    def cited_ids(self, native_ids: Any) -> Any:
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
        run = CURRENT
        if run is not None and run.status == "running":
            run.emit("retry", message=record.getMessage())


def show_warning(message: Any, category: Any, *_args: Any, **_kwargs: Any) -> None:
    text = str(message).strip()
    first_line = text.splitlines()[0] if text else ""
    run = CURRENT
    if run is not None and run.status == "running":
        run.emit("warning", message=f"{category.__name__}: {first_line}")
    else:
        print(f"{category.__name__}: {first_line}")


def execute(run: Run, seeds: list[Any], options: Any) -> None:
    global CURRENT
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    run.loop = loop

    def sources(source: Any) -> TracedScraper:
        return TracedScraper(source_from_env(source), run)

    def extractors(source: Any) -> TracedExtractor | None:
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
        run.status = "cancelled" if run.cancel_requested else "finished"
        run.emit(
            "run_cancelled" if run.cancel_requested else "run_finished",
            ok=result.ok,
            documents=len(result.documents),
            failures=len(result.failures),
            run_error=result.run_error,
        )
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
            CURRENT = None


# ── Runs on disk ──────────────────────────────────────────────────────────────


def save(run: Run) -> None:
    RUNS_DIR.mkdir(exist_ok=True)
    (RUNS_DIR / f"{run.id}.json").write_text(json.dumps(run.to_json(), ensure_ascii=False))
    SUMMARIES[run.id] = run.summary()


def load_summaries() -> None:
    if not RUNS_DIR.exists():
        return
    for path in RUNS_DIR.glob("*.json"):
        with contextlib.suppress(OSError, ValueError):
            data = json.loads(path.read_text())
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
                )
            }


def list_runs() -> list[dict[str, Any]]:
    runs = sorted(SUMMARIES.values(), key=lambda run: run["id"], reverse=True)
    current = CURRENT
    if current is not None:
        runs = [current.summary(), *[run for run in runs if run["id"] != current.id]]
    return runs[:100]


def load_run(run_id: str) -> dict[str, Any] | None:
    current = CURRENT
    if current is not None and current.id == run_id:
        return current.to_json()
    if not RUN_ID.fullmatch(run_id):
        return None
    path = RUNS_DIR / f"{run_id}.json"
    return json.loads(path.read_text()) if path.exists() else None


def delete_all_runs() -> int:
    deleted = 0
    for run_id in list(SUMMARIES):
        deleted += delete_run(run_id)
    return deleted


def delete_run(run_id: str) -> bool:
    if not RUN_ID.fullmatch(run_id) or (CURRENT is not None and CURRENT.id == run_id):
        return False
    path = RUNS_DIR / f"{run_id}.json"
    SUMMARIES.pop(run_id, None)
    if path.exists():
        path.unlink()
        return True
    return False


# ── Building a run from the form, with the same rules as the CLI ─────────────


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
    add("--since", body.get("since"))
    if source in ("arxiv", "zenodo"):
        add("--query-mode", body.get("query_mode"))
    add("--max-requests", body.get("max_requests"))

    if body.get("mode") == "topic":
        topics = [str(topic) for topic in body.get("topics") or [] if topic]
        if not topics:
            raise ValueError("Select at least one topic")
        for topic in topics:
            argv.extend(["--topic", topic])
    else:
        value = str(body.get("query") or "").strip()
        if not value:
            raise ValueError("Enter a query or a channel")
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
    except (TopicFileError, ValidationError, ValueError) as error:
        raise ValueError(str(error)) from error


def meta() -> dict[str, Any]:
    topics = []
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
    env = refresh_env() if CURRENT is None else {k: bool(os.environ.get(k)) for k in ENV_KEYS}
    return {
        "env": env,
        "env_file": str(ENV_FILE),
        "env_file_exists": ENV_FILE.exists(),
        "topics": topics,
        "feeds": list(feeds.values()),
        "running": CURRENT.id if CURRENT is not None else None,
    }


# ── HTTP ──────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    server_version = "CrawlerDebug/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        """Keep the terminal quiet; the UI shows what happens."""

    def send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")
        return data if isinstance(data, dict) else {}

    def do_GET(self) -> None:
        url = urlparse(self.path)
        path = url.path
        if path in ("/", "/index.html"):
            body = (HERE / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/meta":
            self.send_json(meta())
        elif path == "/api/runs":
            self.send_json(list_runs())
        elif path == "/api/events":
            self.stream_events(parse_qs(url.query))
        elif path.startswith("/api/runs/"):
            run_id, _, suffix = path.removeprefix("/api/runs/").partition("/")
            data = load_run(run_id)
            if data is None:
                self.send_json({"error": "Run not found"}, 404)
            elif suffix == "jsonl":
                documents = (data.get("result") or {}).get("documents") or []
                body = "".join(json.dumps(d, ensure_ascii=False) + "\n" for d in documents)
                encoded = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{run_id}.jsonl"')
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)
            else:
                self.send_json(data)
        else:
            self.send_json({"error": "not found"}, 404)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/runs":
            self.start_run()
        elif path == "/api/cancel":
            run = CURRENT
            if run is None or run.loop is None or run.task is None:
                self.send_json({"error": "No run in progress"}, 409)
                return
            run.cancel_requested = True
            run.emit("cancel_requested")
            run.loop.call_soon_threadsafe(run.task.cancel)
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "not found"}, 404)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/runs":
            self.send_json({"deleted": delete_all_runs()})
        elif path.startswith("/api/runs/") and delete_run(path.removeprefix("/api/runs/")):
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "Run not found"}, 404)

    def start_run(self) -> None:
        global CURRENT
        try:
            argv = build_argv(self.read_json())
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
            return
        with LOCK:
            if CURRENT is not None:
                self.send_json({"error": "A run is already in progress"}, 409)
                return
            refresh_env()
            try:
                seeds, options = parse_run(argv)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
                return
            run = Run(argv)
            CURRENT = run
        run.emit(
            "run_started",
            command=run.command,
            seeds=len(seeds),
            options=options.model_dump(mode="json"),
        )
        threading.Thread(target=execute, args=(run, seeds, options), daemon=True).start()
        self.send_json({"id": run.id, "command": run.command})

    def stream_events(self, query: dict[str, list[str]]) -> None:
        run_id = (query.get("run") or [""])[0]
        run = CURRENT
        if run is None or run.id != run_id:
            self.send_json({"error": "Run is not active"}, 404)
            return
        last = self.headers.get("Last-Event-ID") or ""
        start = (query.get("from") or ["0"])[0]
        seq = int(last) + 1 if last.isdigit() else int(start) if start.isdigit() else 0
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            while True:
                with run.changed:
                    if seq >= len(run.events) and run.status == "running":
                        run.changed.wait(timeout=15)
                    batch = run.events[seq:]
                    done = run.status != "running"
                for event in batch:
                    data = json.dumps(event, ensure_ascii=False)
                    self.wfile.write(f"id: {event['seq']}\ndata: {data}\n\n".encode())
                seq += len(batch)
                if not batch:
                    self.wfile.write(b": keepalive\n\n")
                if done and seq >= len(run.events):
                    self.wfile.write(b"event: end\ndata: {}\n\n")
                    self.wfile.flush()
                    return
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return


def main() -> None:
    options = argparse.ArgumentParser(description="Debug UI for the crawler")
    options.add_argument("--host", default="127.0.0.1")
    options.add_argument("--port", type=int, default=8765)
    arguments = options.parse_args()

    # Crawlee logs every failure with a full traceback; the UI shows failures itself.
    logging.getLogger("crawlee").setLevel(logging.CRITICAL)
    runner_logger = logging.getLogger("crawler.runner")
    runner_logger.addHandler(EventLogHandler())
    runner_logger.setLevel(logging.WARNING)
    runner_logger.propagate = False
    warnings.showwarning = show_warning

    refresh_env()
    load_summaries()
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    server.daemon_threads = True
    print(f"Crawler debug UI: http://{arguments.host}:{arguments.port}", flush=True)
    print(f"Crawler .env: {ENV_FILE} ({'found' if ENV_FILE.exists() else 'missing'})", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
