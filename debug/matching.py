"""Matcher screen: match_journey for a journey with the steps of the match, and Index › Graph,
the normalization of patient graphs and PubTator3 annotations."""

import contextlib
import json
import math
import os
import re
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from common import LOCAL, MATCHER_DIR, ROOT, URL_PASSWORD, matcher_missing, mcp_port, mcp_running
from encoder import encoder_state
from indexing import matcher_environment

JOURNEYS_DIR = ROOT / "patientdata"
"""The synthetic journeys of #14, one `timeline.json` per patient."""
JOURNEY_ID = re.compile(r"[0-9A-Za-z_-]+")
DEMO_JOURNEY = {
    "patient_id": "demo-1",
    "events": [
        {
            "id": "e1",
            "type": "surgery",
            "label": "Radikale Prostatektomie",
            "date": "2027-01-22",
        },
        {
            "id": "e2",
            "type": "progression",
            "label": "PSA-Anstieg – Biochemisches Rezidiv",
            "date": "2028-12-25",
        },
    ],
}
"""The journey of the example arguments in Documentation/user/mcp-interface.md."""
MATCH_TIMEOUT = 60


def stored_patients(filename: str) -> list[str]:
    def number(path: Path) -> tuple[int, str]:
        digits = re.search(r"\d+", path.parent.name)
        return int(digits.group()) if digits else 0, path.parent.name

    paths = sorted(JOURNEYS_DIR.glob(f"*/{filename}"), key=number)
    return [path.parent.name for path in paths]


def match_meta() -> dict[str, Any]:
    return {
        "journeys": ["demo", *stored_patients("timeline.json")],
        "graphs": stored_patients("graph.json"),
        "missing": matcher_missing(),
        "mcp": {"url": f"http://127.0.0.1:{mcp_port()}/mcp", "running": mcp_running()},
    }


def load_journey(journey_id: str, *, graph: bool = False) -> Any:
    if graph:
        return json.loads(graph_file("patient", journey_id).read_text(encoding="utf-8"))
    if journey_id == "demo":
        return DEMO_JOURNEY
    path = JOURNEYS_DIR / journey_id / "timeline.json"
    if not JOURNEY_ID.fullmatch(journey_id) or not path.exists():
        raise LookupError(f"No journey {journey_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def run_matcher(
    command: str, request: dict[str, Any], technique: str | None = None
) -> dict[str, Any]:
    """A tool by the matcher's own code: `explain` is `match_journey` with the steps of the
    match, `get_source` is that tool."""
    environment = matcher_environment()
    if technique is not None:
        if technique not in ("qwen", "bge"):
            raise ValueError("Unknown semantic technique")
        environment["SEMANTIC_MODEL"] = technique
    try:
        done = subprocess.run(
            ["node", "src/main.ts", command],
            cwd=MATCHER_DIR / "mcp-server",
            env=environment,
            input=json.dumps(request),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=MATCH_TIMEOUT,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"The matcher did not answer within {MATCH_TIMEOUT} s") from error
    try:
        answer: dict[str, Any] = json.loads(done.stdout)
        return answer
    except json.JSONDecodeError as error:
        lines = URL_PASSWORD.sub(r"\1<redacted>@", done.stderr).strip().splitlines()
        # Node prints the error message after the source line and before the stack.
        message = next((line for line in lines if re.match(r"\w*Error\b", line)), "")
        message = message or f"The matcher failed (exit code {done.returncode})"
        raise RuntimeError(message) from error


def call_mcp(tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """A tool of the running MCP server (`make start`), as a client gets it."""
    call = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    url = f"http://127.0.0.1:{mcp_port()}/mcp"
    request = urllib.request.Request(
        url,
        data=json.dumps(call).encode(),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    try:
        with LOCAL.open(request, timeout=MATCH_TIMEOUT) as response:
            body = response.read().decode()
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"The MCP server answered HTTP {error.code}") from error
    except OSError as error:
        # urllib wraps what went wrong on connecting; a timeout while reading comes as it is.
        reason = error.reason if isinstance(error, urllib.error.URLError) else error
        if isinstance(reason, ConnectionRefusedError):
            raise RuntimeError(f"No MCP server on {url}: run make start") from error
        if isinstance(reason, TimeoutError):
            raise RuntimeError(
                f"The MCP server on {url} did not answer within {MATCH_TIMEOUT} s"
            ) from error
        raise RuntimeError(f"The MCP server on {url} could not be reached: {reason}") from error
    # The server answers as an event stream with one message.
    data = [line[5:] for line in body.splitlines() if line.startswith("data:")]
    not_mcp = f"{url} did not answer like an MCP server"
    try:
        message = json.loads("".join(data) or body)
    except json.JSONDecodeError as error:
        raise RuntimeError(not_mcp) from error
    if not isinstance(message, dict):
        raise RuntimeError(not_mcp)
    if "error" in message:
        failure = message["error"]
        return {"error": {"code": str(failure.get("code")), "message": failure.get("message")}}
    result = message.get("result")
    if not isinstance(result, dict):
        raise RuntimeError(not_mcp)
    if result.get("isError"):
        text = "".join(part.get("text", "") for part in result.get("content", []))
        try:
            refused = json.loads(text)
            return {"error": {"code": refused["error_code"], "message": refused["message"]}}
        except (ValueError, KeyError, TypeError):
            return {"error": {"code": "INVALID_REQUEST", "message": text}}
    if "structuredContent" not in result:
        raise RuntimeError(not_mcp)
    return {"answer": result["structuredContent"]}


def match(body: dict[str, Any]) -> dict[str, Any]:
    request = body.get("request")
    if not isinstance(request, dict):
        raise ValueError("request must be the arguments of match_journey")
    started = time.monotonic()
    if body.get("via") == "mcp":
        # Tuning is not part of the tool: the server ranks with its own constants.
        arguments = {key: value for key, value in request.items() if key != "tuning"}
        result = {"steps": [], **call_mcp("match_journey", arguments)}
    else:
        technique = body.get("technique")
        if technique is not None and (
            technique not in ("qwen", "bge") or request.get("algorithm") != "ai_summary"
        ):
            raise ValueError("Invalid semantic technique")
        if request.get("algorithm") == "ai_summary" and encoder_state()["status"] != "running":
            raise RuntimeError("The AI approach needs the encoder: start it under Index › AI")
        result = run_matcher("explain", request, technique)
    return {**result, "seconds": round(time.monotonic() - started, 2)}


def source(body: dict[str, Any]) -> dict[str, Any]:
    """`get_source` for the example client, the same way as its match."""
    source_id = body.get("source_id")
    if not isinstance(source_id, str):
        raise ValueError("source_id must be the ID of a source")
    arguments = {"source_id": source_id}
    started = time.monotonic()
    if body.get("via") == "mcp":
        result = call_mcp("get_source", arguments)
    else:
        result = run_matcher("get_source", arguments)
    return {**result, "seconds": round(time.monotonic() - started, 2)}


# ── Index › Graph: the normalization of patient graphs and PubTator3 annotations (#80) ──

GRAPH_DIR = MATCHER_DIR / "algorithms" / "graph"
PUBTATOR_FIXTURES = GRAPH_DIR / "fixtures" / "pubtator"
GRAPH_TIMEOUT = 30
GRAPH_ENVIRONMENT = ("PATH", "HOME", "LANG", "SYSTEMROOT")
"""All the normalizer gets of this server's environment: it needs no keys and no database."""


def graph_meta() -> dict[str, Any]:
    """The graphs the screen can show: patient graphs of `make graph` and PubTator3 fixtures."""
    return {
        "patients": stored_patients("graph.json"),
        "papers": sorted(path.stem for path in PUBTATOR_FIXTURES.glob("*.json")),
        "missing": matcher_missing(),
    }


def graph_file(kind: str, name: str) -> Path:
    if not JOURNEY_ID.fullmatch(name):
        raise ValueError(f"Not a graph name: {name}")
    if kind == "patient":
        path = JOURNEYS_DIR / name / "graph.json"
    elif kind == "paper":
        path = PUBTATOR_FIXTURES / f"{name}.json"
    else:
        raise ValueError(f"Not a graph kind: {kind}")
    if not path.exists():
        raise LookupError(f"No {kind} graph {name}")
    return path


def graph_normalize(kind: str, name: str, min_score: str) -> dict[str, Any]:
    """The NormalizedGraph of one file, by the graph package's own `normalize --json`, and how
    many nodes and edges or annotations and relations the file has before it."""
    path = graph_file(kind, name)
    try:
        score = float(min_score or 0)
    except ValueError as error:
        raise ValueError(f"min_score is not a number: {min_score}") from error
    if not math.isfinite(score) or not 0 <= score <= 1:
        raise ValueError(f"min_score must be between 0 and 1: {min_score}")
    missing = matcher_missing()
    if missing:
        raise ValueError(missing)
    try:
        done = subprocess.run(
            ["node", "scripts/normalize.ts", str(path), "--json", "--min-score", str(score)],
            cwd=GRAPH_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=GRAPH_TIMEOUT,
            env={key: os.environ[key] for key in GRAPH_ENVIRONMENT if key in os.environ},
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"The normalization did not finish within {GRAPH_TIMEOUT} s") from error
    graphs: Any = None
    if done.returncode == 0:
        with contextlib.suppress(json.JSONDecodeError):
            graphs = json.loads(done.stdout)
    if not isinstance(graphs, list):
        lines = (done.stderr.strip() or done.stdout.strip()).splitlines()
        message = next((line for line in lines if re.match(r"\w*Error\b", line)), "")
        message = message or f"The normalization failed (exit code {done.returncode})"
        raise RuntimeError(message)
    if not graphs:
        raise LookupError(f"The {kind} file {name} has no document")
    return {
        "kind": kind,
        "name": name,
        "before": graph_size(kind, path),
        "graph": graphs[0],
        "original": json.loads(path.read_text(encoding="utf-8")) if kind == "patient" else None,
    }


def graph_size(kind: str, path: Path) -> dict[str, int]:
    """How many nodes and edges, or annotations and relations of the first document, a file
    has. The normalizer has read it already, so an odd shape only gives zeros here."""
    try:
        raw: Any = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raw = None

    def items(value: Any, key: str) -> list[Any]:
        found = value.get(key) if isinstance(value, dict) else None
        return found if isinstance(found, list) else []

    if kind == "patient":
        return {"nodes": len(items(raw, "nodes")), "edges": len(items(raw, "edges"))}
    # An export (`{"PubTator3": [...]}`), a list of documents or one document, as the script reads.
    documents = raw if isinstance(raw, list) else items(raw, "PubTator3") or [raw]
    first = documents[0] if documents else None
    return {
        "annotations": sum(len(items(p, "annotations")) for p in items(first, "passages")),
        "relations": len(items(first, "relations")),
    }
