# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "torch==2.9.1",
#   "transformers==4.57.3",
#   "sentence-transformers==5.1.2",
# ]
# ///
"""Local embedding worker. Run with uv run scripts/semantic.py [--download].

Only fixed, pinned models are accepted. Request texts are kept in memory.
"""

import argparse
import contextlib
import gc
import json
import os
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MODELS = {
    "qwen": ("Qwen/Qwen3-Embedding-0.6B", "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"),
    "bge": ("BAAI/bge-m3", "5617a9f61b028005a4858fdac845db406aefb181"),
}
INSTRUCTION = (
    "Given a patient's current medical situation and history, "
    "retrieve resources relevant to the current situation."
)
LOCK = threading.Lock()
LOADED = {}
DEVICE = "cpu"


def load(name, download=False):
    from sentence_transformers import SentenceTransformer

    if name not in LOADED:
        LOADED.clear()
        gc.collect()
        repository, revision = MODELS[name]
        LOADED[name] = SentenceTransformer(
            repository,
            revision=revision,
            local_files_only=not download,
            device=DEVICE,
            model_kwargs={"attn_implementation": "sdpa"},
        )
        LOADED[name].max_seq_length = 512
    return LOADED[name]


def encode(body):
    name = body["model"]
    repository, revision = MODELS[name]
    texts = body["texts"]
    if (
        body.get("device") != DEVICE
        or body.get("repository") != repository
        or body.get("revision") != revision
        or body.get("maxTokens") != 512
        or body.get("dimensions") != 1024
        or body.get("template") != 1
        or body.get("attention") != "sdpa"
        or body.get("instruction") != INSTRUCTION
        or body.get("pooling") != ("last-token" if name == "qwen" else "cls")
        or body.get("mode") not in ("query", "document")
        or not isinstance(texts, list)
        or not 1 <= len(texts) <= 4
        or not all(isinstance(text, str) and len(text) <= 500_000 for text in texts)
    ):
        raise ValueError("Invalid encoder request")
    if name == "qwen" and body["mode"] == "query":
        texts = [f"Instruct: {INSTRUCTION}\nQuery: {text}" for text in texts]
    with LOCK:
        vectors = load(name).encode(texts, normalize_embeddings=True, batch_size=1)
    return {"vectors": vectors.tolist()}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path != "/health":
            self.send_error(404)
            return
        data = json.dumps(worker_configuration()).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/encode":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 4_000_000:
                raise ValueError("Invalid body length")
            body = json.loads(self.rfile.read(length))
            answer = encode(body)
        except (KeyError, ValueError, TypeError):
            self.send_error(400, "Invalid encoder request")
            return
        except Exception:  # noqa: BLE001 — keep model errors containing patient text private
            # Model errors can contain input text, so return only a fixed message.
            self.send_error(
                503,
                "Local encoder unavailable. Check cached models and device configuration.",
            )
            return
        data = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def worker_configuration():
    return {
        "service": "patient-journey-semantic",
        "device": DEVICE,
        "max_tokens": 512,
        "attention": "sdpa",
        "models": {name: list(value) for name, value in MODELS.items()},
    }


LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def health(port):
    try:
        with LOCAL.open(f"http://127.0.0.1:{port}/health", timeout=0.5) as response:
            return json.load(response)
    except (OSError, ValueError, urllib.error.URLError):
        return None


def available_port(preferred):
    with socket.socket() as connection:
        try:
            connection.bind(("127.0.0.1", preferred))
        except OSError:
            connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


def stop(child):
    if child.poll() is None:
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()


def interrupt(*_):
    raise KeyboardInterrupt


def run_application(command, ui_port):
    root = Path(__file__).resolve().parent.parent
    environment = dict(os.environ)
    environment.pop("VIRTUAL_ENV", None)
    source_path = str(root / "crawler/src")
    environment["PYTHONPATH"] = os.pathsep.join(
        filter(None, [source_path, environment.get("PYTHONPATH")])
    )
    environment["SEMANTIC_DEVICE"] = DEVICE
    environment["SEMANTIC_MODEL"] = environment.get("SEMANTIC_MODEL") or "qwen"
    environment["SEMANTIC_MODELS"] = environment.get("SEMANTIC_MODELS") or "qwen,bge"
    if not environment.get("DATABASE_URL"):
        raise ValueError(
            "DATABASE_URL is required. Run this through make debug-ai or make index-ai."
        )
    endpoint = urlsplit(environment.get("SEMANTIC_URL") or "http://127.0.0.1:8766")
    if endpoint.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise ValueError("SEMANTIC_URL must use a loopback host")
    port = endpoint.port or 8766
    signal.signal(signal.SIGTERM, interrupt)
    with contextlib.ExitStack() as cleanup:

        def launch(arguments, directory):
            child = subprocess.Popen(
                arguments,
                cwd=directory,
                env=environment,
                start_new_session=True,
            )
            cleanup.callback(stop, child)
            return child

        if health(port) != worker_configuration():
            port = available_port(port)
            print(
                "Preparing the local encoders. Missing weights will be downloaded.",
                flush=True,
            )
            worker = launch(
                [
                    "uv",
                    "run",
                    "--locked",
                    "scripts/semantic.py",
                    "--prepare",
                    "--device",
                    DEVICE,
                    "--port",
                    str(port),
                ],
                root,
            )
            while health(port) != worker_configuration():
                if worker.poll() is not None:
                    raise RuntimeError(
                        "The local encoder could not start. See its output above."
                    )
                time.sleep(0.2)
        environment["SEMANTIC_URL"] = f"http://127.0.0.1:{port}"
        print(f"Encoder ready at {environment['SEMANTIC_URL']} ({DEVICE}).", flush=True)
        if command == "index":
            return launch(
                ["node", "src/main.ts", "ai_summary"],
                root / "matcher/indexer",
            ).wait()

        environment["MCP_PORT"] = str(
            available_port(int(environment.get("MCP_PORT") or 3000))
        )
        server = launch(["node", "src/main.ts"], root / "matcher/mcp-server")
        if command == "start":
            return server.wait()
        gui_port = available_port(ui_port)
        gui = launch(
            [
                str(root / "crawler/.venv/bin/python"),
                "../debug/server.py",
                "--port",
                str(gui_port),
            ],
            root / "crawler",
        )
        print(f"Open http://127.0.0.1:{gui_port} and choose Matcher.", flush=True)
        print("Ctrl+C stops the services started by this command.", flush=True)
        while gui.poll() is None and server.poll() is None:
            time.sleep(0.2)
        return gui.poll() or server.poll() or 0


def main():
    global DEVICE
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--download", action="store_true", help="Download both pinned models and exit"
    )
    parser.add_argument(
        "--device",
        choices=["cpu", "mps", "cuda"],
        default=os.environ.get("SEMANTIC_DEVICE") or "cpu",
    )
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--run",
        choices=["debug", "index", "start"],
        help="Manage the encoder and application together",
    )
    parser.add_argument("--ui-port", type=int, default=8765)
    parser.add_argument("--prepare", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    DEVICE = args.device
    if args.run:
        return run_application(args.run, args.ui_port)
    if args.download or args.prepare:
        for name in MODELS:
            try:
                load(name)
            except OSError:
                load(name, download=True)
        if args.download:
            return 0
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, RuntimeError) as error:
        raise SystemExit(str(error)) from None
