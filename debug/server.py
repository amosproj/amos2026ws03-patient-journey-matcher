"""Debug UI for the crawler, the database, the index and the matcher.

Start it from the repository root with `make debug` (see debug/README.md). It runs in the
crawler's uv environment and only uses the crawler's public Python API (`run_requests`
with its factory and sleep hooks, `crawler.store` for `--store`), asyncpg and the standard
library, so the crawler needs nothing extra for it. The database view only reads, except when
the user empties tables and types the database name to confirm, and when the Index overview sets
how many audio files the transcription job reads at once.

The matcher is TypeScript, so its logic stays there: the Index screens start the indexer job
(`matcher/indexer`) as a child process, for every approach or one, and read its tables, and the
Matcher screen asks `node src/main.ts explain` in `matcher/mcp-server` for the answer of
`match_journey` with the steps of the match, and `node src/main.ts get_source` for the files of
one source. Index › Graph shows a patient graph or PubTator3 annotations normalized by
`scripts/normalize.ts` of `matcher/algorithms/graph`. Journeys are passed on, never stored or
logged.

The jobs live in modules next to this file; it routes the requests and starts the server.
"""

import argparse
import contextlib
import json
import logging
import re
import signal
import threading
import warnings
from collections.abc import Awaitable, Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import asyncpg
import common
import encoder
from common import (
    HERE,
    LOCK,
    ROOT,
    SLOW_QUERY,
    DbUnavailable,
    EventLog,
    describe_error,
    first,
    refresh_env,
    run_db,
)
from db_view import (
    db_document,
    db_documents,
    db_overview,
    db_runs,
    db_schema,
    db_table,
    db_term_test,
    db_titles,
    empty_tables,
    emptying_plan,
)
from encoder import encoder_state, start_encoder, stop_encoder, stop_process_group
from indexing import (
    index_overview,
    index_vocabulary,
    indexer_state,
    journey_terms,
    set_transcription_workers,
    start_indexer,
    stop_indexer,
    term_documents,
    transcription_overview,
)
from info import info, probe, topic_detail
from matching import graph_meta, graph_normalize, load_journey, match, match_meta, source
from runs import (
    EventLogHandler,
    Run,
    build_argv,
    delete_all_runs,
    delete_run,
    execute,
    list_runs,
    load_run,
    load_summaries,
    meta,
    parse_run,
    prepare,
    show_warning,
)

from crawler.runner import ENV_FILE

WEB_DIR = HERE / "web"
"""The page: index.html, one script and stylesheet per screen; nothing else is served."""
WEB_FILE = re.compile(r"/([a-z0-9-]+\.(?:html|css|js))")
WEB_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}
ALLOWED_HOSTS: set[str] = set()
"""`Host` header values of this server, set in main(); other hosts are DNS rebinding."""


def string_list(body: dict[str, Any], key: str, limit: int) -> list[str]:
    values = body.get(key)
    if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
        raise ValueError(f"{key} must be a list of texts")
    if len(values) > limit:
        raise ValueError(f"At most {limit} {key}")
    return values


# ── Docs screen: the Markdown files of the checkout, and the files they show ──────
# In this file, not a module: crawler/tests/test_debug_docs.py patches ROOT and probe here.
DOC_FILE_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
}
"""What a doc may show or link to besides other docs: images, and PDFs that open in a tab."""


def checkout_files(suffixes: tuple[str, ...]) -> list[str]:
    """The files of the checkout with these suffixes that git tracks or would add, so none it
    ignores (`.env`, `node_modules/`, `out/`) and none in a dot directory; relative to ROOT."""
    listed = probe(
        ["git", "-C", str(ROOT), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
    )
    if listed is None:
        raise RuntimeError("The Docs screen needs git and a git checkout")
    return sorted(
        name
        for name in listed.split("\0")
        if name.lower().endswith(suffixes)
        and not any(part.startswith(".") for part in name.split("/"))
        and (ROOT / name).is_file()
    )


def docs() -> dict[str, Any]:
    """Every Markdown file with its text: the screen renders and searches them itself."""
    return {
        "docs": [
            {"path": name, "text": (ROOT / name).read_text(encoding="utf-8", errors="replace")}
            for name in checkout_files((".md",))
        ]
    }


def doc_file(name: str) -> tuple[bytes, str]:
    """An image or PDF of the checkout, looked up among the files git lists and never opened
    by a path from the URL."""
    suffix = Path(name).suffix.lower()
    if suffix not in DOC_FILE_TYPES or name not in checkout_files(tuple(DOC_FILE_TYPES)):
        raise LookupError(f"No image or PDF {name} in this checkout")
    return (ROOT / name).read_bytes(), DOC_FILE_TYPES[suffix]


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

    def refuse_foreign(self, *, changes_state: bool) -> bool:
        """Answer 403 to requests another website can make the browser send.

        A foreign `Host` is DNS rebinding. A foreign `Origin` is a cross-site request, and a
        body that is not JSON could come from a cross-site form without a CORS preflight.
        """
        origin = self.headers.get("Origin")
        content_type = (self.headers.get("Content-Type") or "").partition(";")[0].strip()
        foreign = (
            self.headers.get("Host") not in ALLOWED_HOSTS
            or (origin is not None and origin.removeprefix("http://") not in ALLOWED_HOSTS)
            or (changes_state and content_type.lower() != "application/json")
        )
        if foreign:
            self.send_json({"error": "Forbidden"}, 403)
        return foreign

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        data = json.loads(self.rfile.read(length) or b"{}")
        return data if isinstance(data, dict) else {}

    def send_db(self, query: Callable[[Any], Awaitable[Any]], *, write: bool = False) -> None:
        try:
            self.send_json(run_db(query, write=write))
        except DbUnavailable as error:
            self.send_json({"error": str(error), "hint": error.hint, "unavailable": True}, 503)
        except LookupError as error:
            self.send_json({"error": str(error).strip("'\"")}, 404)
        except (ValueError, asyncpg.DataError) as error:
            self.send_json({"error": str(error)}, 400)
        except TimeoutError:
            self.send_json({"error": f"The query took longer than {SLOW_QUERY} s"}, 504)
        except asyncpg.PostgresError as error:
            self.send_json({"error": describe_error(error)}, 500)

    def send_result(self, action: Callable[[], Any]) -> None:
        """The JSON answer of `action`; its errors as 400 (bad request), 404, 409 or 502."""
        try:
            self.send_json(action())
        except LookupError as error:
            self.send_json({"error": str(error).strip("'\"")}, 404)
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)
        except RuntimeError as error:
            self.send_json({"error": str(error)}, 409)

    def send_doc_file(self, name: str) -> None:
        try:
            body, content_type = doc_file(name)
        except LookupError as error:
            self.send_json({"error": str(error).strip("'\"")}, 404)
            return
        except RuntimeError as error:
            self.send_json({"error": str(error)}, 409)
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        if content_type == "image/svg+xml":  # opened on its own, an SVG could run a script
            self.send_header("Content-Security-Policy", "script-src 'none'")
        self.end_headers()
        self.wfile.write(body)

    def route_db(self, path: str, params: dict[str, list[str]]) -> None:
        if path == "/api/db":
            self.send_db(db_overview)
        elif path == "/api/db/documents":
            self.send_db(lambda connection: db_documents(connection, params))
        elif path == "/api/db/document":
            self.send_db(lambda connection: db_document(connection, first(params, "id")))
        elif path == "/api/db/term-test":
            self.send_db(lambda connection: db_term_test(connection, params))
        elif path == "/api/db/runs":
            self.send_db(lambda connection: db_runs(connection, params))
        elif path == "/api/db/schema":
            self.send_db(db_schema)
        elif path == "/api/db/table":
            self.send_db(lambda connection: db_table(connection, params))
        elif path == "/api/db/empty-plan":
            self.send_db(lambda connection: emptying_plan(connection, params.get("table") or []))
        else:
            self.send_json({"error": "not found"}, 404)

    def route_index(self, path: str, params: dict[str, list[str]]) -> None:
        if path == "/api/index":
            self.send_db(
                lambda connection: index_overview(
                    connection, first(params, "technique") or "keyword"
                )
            )
        elif path == "/api/index/run":
            self.send_json(indexer_state(events=True))
        elif path == "/api/index/events":
            self.stream_events(common.INDEXING, params)
        elif path == "/api/index/vocabulary":
            self.send_db(lambda connection: index_vocabulary(connection, params))
        elif path == "/api/index/journey-terms":
            self.send_db(journey_terms)
        elif path == "/api/index/transcription":
            self.send_db(transcription_overview)
        elif path == "/api/index/encoder":
            self.send_result(encoder_state)
        else:
            self.send_json({"error": "not found"}, 404)

    def empty_db(self) -> None:
        """Empty tables; the body must name the database, which the UI asks the user to type."""
        try:
            body = self.read_json()
        except json.JSONDecodeError:
            self.send_json({"error": "Invalid JSON"}, 400)
            return
        tables, confirm = body.get("tables"), body.get("confirm")
        if not isinstance(tables, list) or not all(isinstance(name, str) for name in tables):
            self.send_json({"error": "tables must be a list of table names"}, 400)
            return
        run = common.CURRENT
        if run is not None and run.store_url is not None:
            self.send_json({"error": "A crawler run with Store is in progress; wait for it"}, 409)
            return
        if common.INDEXING is not None and common.INDEXING.status == "running":
            self.send_json({"error": "The indexer is running; stop it first"}, 409)
            return
        self.send_db(lambda connection: empty_tables(connection, tables, str(confirm)), write=True)

    def do_GET(self) -> None:
        if self.refuse_foreign(changes_state=False):
            return
        url = urlparse(self.path)
        path = url.path
        page = WEB_FILE.fullmatch("/index.html" if path == "/" else path)
        if page and (WEB_DIR / page[1]).is_file():
            body = (WEB_DIR / page[1]).read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", WEB_TYPES[Path(page[1]).suffix])
            self.send_header("Content-Length", str(len(body)))
            # Read from disk on every request, so a reload shows an edit without a restart.
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        elif path == "/api/meta":
            self.send_json(meta())
        elif path == "/api/runs":
            self.send_json(list_runs())
        elif path == "/api/events":
            self.stream_events(common.CURRENT, parse_qs(url.query))
        elif path == "/api/db" or path.startswith("/api/db/"):
            self.route_db(path, parse_qs(url.query))
        elif path == "/api/index" or path.startswith("/api/index/"):
            self.route_index(path, parse_qs(url.query))
        elif path == "/api/graph/meta":
            self.send_json(graph_meta())
        elif path == "/api/graph/normalize":
            params = parse_qs(url.query)
            kind, name, score = (first(params, key) for key in ("kind", "name", "min_score"))
            self.send_result(lambda: graph_normalize(kind, name, score))
        elif path == "/api/match/meta":
            self.send_json(match_meta())
        elif path == "/api/info":
            self.send_json(info(fresh="fresh" in parse_qs(url.query)))
        elif path.startswith("/api/topics/"):
            self.send_result(lambda: topic_detail(path.removeprefix("/api/topics/")))
        elif path == "/api/docs":
            self.send_result(docs)
        elif path == "/api/docs/file":
            self.send_doc_file(first(parse_qs(url.query), "path"))
        elif path == "/api/match/journey":
            params = parse_qs(url.query)
            self.send_result(
                lambda: load_journey(first(params, "id"), graph=first(params, "kind") == "graph")
            )
        elif path.startswith("/api/runs/"):
            run_id, _, suffix = path.removeprefix("/api/runs/").partition("/")
            data = load_run(run_id)
            if data is None:
                self.send_json({"error": "Run not found"}, 404)
            elif suffix == "jsonl":
                documents = (data.get("result") or {}).get("documents") or []
                lines = (json.dumps(d, ensure_ascii=False) + "\n" for d in documents)
                encoded = "".join(lines).encode()
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
        if self.refuse_foreign(changes_state=True):
            return
        path = urlparse(self.path).path
        if path == "/api/runs":
            self.start_run()
        elif path == "/api/db/empty":
            self.empty_db()
        elif path == "/api/index/cancel":
            self.send_result(stop_indexer)
        elif path == "/api/index/encoder/start":
            self.send_result(start_encoder)
        elif path == "/api/index/encoder/stop":
            self.send_result(stop_encoder)
        elif path in (
            "/api/index/run",
            "/api/index/terms",
            "/api/index/transcription",
            "/api/db/titles",
            "/api/match",
            "/api/match/source",
        ):
            try:
                body = self.read_json()
            except json.JSONDecodeError:
                self.send_json({"error": "Invalid JSON"}, 400)
                return
            if path == "/api/match":
                self.send_result(lambda: match(body))
            elif path == "/api/index/run":
                self.send_result(
                    lambda: start_indexer(
                        body.get("technique", body.get("approach") or "all")
                    ).summary()
                )
            elif path == "/api/index/transcription":
                self.send_db(
                    lambda connection: set_transcription_workers(connection, body.get("workers")),
                    write=True,
                )
            elif path == "/api/match/source":
                self.send_result(lambda: source(body))
            elif path == "/api/db/titles":
                self.send_db(
                    lambda connection: db_titles(connection, string_list(body, "ids", 5000))
                )
            else:
                self.send_db(
                    lambda connection: term_documents(connection, string_list(body, "terms", 500))
                )
        elif path == "/api/cancel":
            run = common.CURRENT
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
        if self.refuse_foreign(changes_state=True):
            return
        path = urlparse(self.path).path
        if path == "/api/runs":
            self.send_json({"deleted": delete_all_runs()})
        elif path.startswith("/api/runs/") and delete_run(path.removeprefix("/api/runs/")):
            self.send_json({"ok": True})
        else:
            self.send_json({"error": "Run not found"}, 404)

    def start_run(self) -> None:
        try:
            body = self.read_json()
            argv = build_argv(body)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json({"error": str(error)}, 400)
            return
        with LOCK:
            if common.CURRENT is not None:
                self.send_json({"error": "A run is already in progress"}, 409)
                return
            refresh_env()
            try:
                seeds, options = parse_run(argv)
                store_url = None
                if body.get("store") is True:
                    store_url, options = prepare(argv[0], options)
            except ValueError as error:
                self.send_json({"error": str(error)}, 400)
                return
            run = Run(argv)
            run.store_url = store_url
            common.CURRENT = run
        run.emit(
            "run_started",
            command=run.command,
            seeds=len(seeds),
            options=options.model_dump(mode="json"),
        )
        threading.Thread(target=execute, args=(run, seeds, options), daemon=True).start()
        self.send_json({"id": run.id, "command": run.command})

    def stream_events(self, run: EventLog | None, query: dict[str, list[str]]) -> None:
        """Sends the events of `run`, a crawler run or an indexer run, until it is done."""
        run_id = (query.get("run") or [""])[0]
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


def interrupt(*_: Any) -> None:
    raise KeyboardInterrupt


def main() -> None:
    options = argparse.ArgumentParser(description="Debug UI for the crawler and the matcher")
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

    host = f"[{arguments.host}]" if ":" in arguments.host else arguments.host
    ALLOWED_HOSTS.update(
        f"{name}:{arguments.port}" for name in (host, "127.0.0.1", "localhost", "[::1]")
    )
    refresh_env()
    load_summaries()
    # The page asks for all its files at once; the default queue of 5 resets some of them.
    ThreadingHTTPServer.request_queue_size = 128
    server = ThreadingHTTPServer((arguments.host, arguments.port), Handler)
    server.daemon_threads = True
    print(f"Debug UI: http://{arguments.host}:{arguments.port}", flush=True)
    print(f"Crawler .env: {ENV_FILE} ({'found' if ENV_FILE.exists() else 'missing'})", flush=True)
    # A stop (make debug-ai, systemd) or a closed terminal also stops the encoder it started.
    for stopping in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(stopping, interrupt)
    try:
        with contextlib.suppress(KeyboardInterrupt):
            server.serve_forever()
    finally:
        if encoder.ENCODER is not None:
            stop_process_group(encoder.ENCODER.process)


if __name__ == "__main__":
    main()
