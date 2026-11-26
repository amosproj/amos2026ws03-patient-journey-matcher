"""Index › AI: the local encoder of the AI approach (scripts/semantic.py)."""

import contextlib
import http.client
import json
import os
import re
import signal
import socket
import subprocess
import threading
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import common
from common import LOCAL, ROOT, describe_error

ENCODER_URL = "http://127.0.0.1:8766"
"""Where the matcher looks for the encoder without SEMANTIC_URL."""
ENCODER_SERVICE = "patient-journey-semantic"
ENCODER_LINES = 30
ENCODER_LOCK = threading.Lock()
LOOPBACK = ("localhost", "127.0.0.1", "::1")
PROGRESS = re.compile(r"(.+?):\s+\d+%\|")
"""A step of a download's progress bar; it replaces the step before of the same file."""


class Encoder:
    """The encoder this server started, with the last lines it wrote."""

    def __init__(self, process: "subprocess.Popen[str]", port: int, device: str) -> None:
        self.process = process
        self.url = f"http://127.0.0.1:{port}"
        self.device = device
        self.started_at = datetime.now(UTC).isoformat(timespec="seconds")
        self.lines: list[str] = []
        self.lines_lock = threading.Lock()

    def running(self) -> bool:
        return self.process.poll() is None

    def read_output(self) -> None:
        assert self.process.stdout is not None
        for text in self.process.stdout:
            line = text.rstrip()
            if not line:
                continue
            progress = PROGRESS.match(line)
            with self.lines_lock:
                last = PROGRESS.match(self.lines[-1]) if self.lines else None
                if progress and last and last[1] == progress[1]:
                    self.lines[-1] = line
                else:
                    self.lines = [*self.lines[1 - ENCODER_LINES :], line]


ENCODER: Encoder | None = None
"""The encoder this server started, until it is stopped; one that failed stays to show why."""


def encoder_device() -> str:
    """The device of the encoder; the matcher's requests must name the same one."""
    device = os.environ.get("SEMANTIC_DEVICE") or "cpu"
    if device not in ("cpu", "mps"):
        raise ValueError("SEMANTIC_DEVICE must be cpu or mps")
    return device


def encoder_health(url: str) -> dict[str, Any] | None:
    """What the encoder at `url` says of itself, or None if none answers there."""
    if urlsplit(url).hostname not in LOOPBACK:
        return None
    try:
        with LOCAL.open(f"{url.rstrip('/')}/health", timeout=0.5) as response:
            data = json.load(response)
    except (OSError, ValueError, http.client.HTTPException):
        return None
    return data if isinstance(data, dict) and data.get("service") == ENCODER_SERVICE else None


def encoder_state() -> dict[str, Any]:
    """The encoder the matcher's programs reach: the one this server started, else one that
    answers at SEMANTIC_URL, such as that of make debug-ai, which only that command stops."""
    encoder = ENCODER
    if encoder is not None:
        with encoder.lines_lock:
            lines = list(encoder.lines)
        code = encoder.process.poll()
        status = (
            "failed"
            if code is not None
            else "running"
            if encoder_health(encoder.url)
            else "starting"
        )
        return {
            "status": status,
            "own": True,
            "url": encoder.url,
            "device": encoder.device,
            "started_at": encoder.started_at,
            "code": code,
            "lines": lines,
        }
    url = os.environ.get("SEMANTIC_URL") or ENCODER_URL
    health = encoder_health(url)
    return {
        "status": "running" if health else "stopped",
        "own": False,
        "url": url,
        "device": health.get("device") if health else encoder_device(),
        "lines": [],
    }


def with_encoder(environment: dict[str, str]) -> dict[str, str]:
    """`environment` with the address and device of the encoder this server started."""
    encoder = ENCODER
    if encoder is not None and encoder.running():
        environment = {
            **environment,
            "SEMANTIC_URL": encoder.url,
            "SEMANTIC_DEVICE": encoder.device,
        }
    return environment


def free_port(preferred: int) -> int:
    """`preferred`, or any free port if it is taken. The encoder opens its port only after it
    has loaded both models, so a taken one would fail minutes later."""
    with socket.socket() as connection:
        try:
            connection.bind(("127.0.0.1", preferred))
        except OSError:
            connection.bind(("127.0.0.1", 0))
        return int(connection.getsockname()[1])


def start_encoder() -> dict[str, Any]:
    """Starts the encoder like make debug-ai does. It loads both models before it answers and
    downloads the weights that are missing."""
    global ENCODER
    with ENCODER_LOCK:
        state = encoder_state()
        if state["status"] in ("starting", "running"):
            raise RuntimeError(f"An encoder is already {state['status']} at {state['url']}")
        device = encoder_device()
        endpoint = urlsplit(os.environ.get("SEMANTIC_URL") or ENCODER_URL)
        if endpoint.hostname not in LOOPBACK:
            raise ValueError("SEMANTIC_URL must use a loopback host")
        port = free_port(endpoint.port or 8766)
        environment = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
        try:
            process = subprocess.Popen(
                [
                    "uv",
                    "run",
                    "--locked",
                    "scripts/semantic.py",
                    "--prepare",
                    "--device",
                    device,
                    "--port",
                    str(port),
                ],
                cwd=ROOT,
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                # Its own process group: a stop reaches the Python that uv starts.
                start_new_session=True,
            )
        except OSError as error:
            raise RuntimeError(describe_error(error)) from error
        encoder = ENCODER = Encoder(process, port, device)
    # Read all the time: a full pipe would halt the encoder.
    threading.Thread(target=encoder.read_output, daemon=True).start()
    return encoder_state()


def stop_process_group(process: "subprocess.Popen[str]") -> None:
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        process.wait()


def stop_encoder() -> dict[str, Any]:
    """Stops the encoder this server started, or forgets the one that failed."""
    global ENCODER
    with ENCODER_LOCK:
        encoder, run = ENCODER, common.INDEXING
        if encoder is None:
            raise RuntimeError("This UI started no encoder; the command that started it stops it")
        indexing = (
            run is not None and run.status == "running" and run.approach not in ("keyword", "graph")
        )
        if encoder.running() and indexing:
            raise RuntimeError("The indexer is using the encoder: stop the indexer first")
        stop_process_group(encoder.process)
        ENCODER = None
    return encoder_state()
