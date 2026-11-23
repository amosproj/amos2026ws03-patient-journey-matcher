"""The encoder worker (scripts/semantic.py) without PyTorch: which requests it takes, what
reaches the model, that its pins are the matcher's, and how it starts and stops the programs."""

import contextlib
import importlib.util
import re
import signal
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def worker(monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "semantic_worker_test", ROOT / "scripts/semantic.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def body(worker, model="qwen", mode="document", texts=("a text",)):
    """What the matcher sends: `configuration` of encoder.ts with the mode and the texts."""
    repository, revision = worker.MODELS[model]
    return {
        "model": model,
        "repository": repository,
        "revision": revision,
        "pooling": worker.POOLING[model],
        "template": 1,
        "maxTokens": 512,
        "dimensions": 1024,
        "attention": "sdpa",
        "instruction": worker.INSTRUCTION,
        "device": "cpu",
        "mode": mode,
        "texts": list(texts),
    }


@pytest.mark.parametrize(
    ("model", "mode", "instructed"),
    [("qwen", "document", False), ("qwen", "query", True), ("bge", "query", False)],
)
def test_only_a_qwen_query_gets_the_instruction(worker, monkeypatch, model, mode, instructed):
    seen = []
    monkeypatch.setattr(worker, "embed", lambda name, texts: seen.append((name, texts)) or [[1.0]])
    answer = worker.encode(body(worker, model, mode, ["Keine Metastasen"]))
    prefix = f"Instruct: {worker.INSTRUCTION}\nQuery: " if instructed else ""
    assert seen == [(model, [prefix + "Keine Metastasen"])]
    assert answer == {"vectors": [[1.0]]}


@pytest.mark.parametrize(
    "changes",
    [
        {"revision": "0000"},
        {"repository": "BAAI/bge-m3"},
        {"pooling": "cls"},
        {"maxTokens": 8192},
        {"device": "mps"},
        {"mode": "passage"},
        {"model": "other"},
        {"texts": []},
        {"texts": ["a", "b", "c", "d", "e"]},
        {"texts": ["a" * 500_001]},
        {"texts": "a text"},
    ],
)
def test_a_request_with_other_settings_or_too_much_text_is_refused(worker, monkeypatch, changes):
    monkeypatch.setattr(worker, "embed", lambda name, texts: pytest.fail("reached the model"))
    with pytest.raises((ValueError, KeyError)):  # both answered with HTTP 400
        worker.encode({**body(worker), **changes})


def test_the_vector_is_of_the_last_token_for_qwen_and_of_the_first_for_bge(worker, monkeypatch):
    states = [[1.0, 0.0], [0.0, 2.0], [3.0, 0.0]]  # of the three tokens of one text
    tokenized = []

    class Tokens(dict):
        def to(self, device):
            return self

    def tokenizer(text, **options):
        tokenized.append((text, options))
        return Tokens()

    def model(**tokens):
        return SimpleNamespace(last_hidden_state=[states])

    torch = SimpleNamespace(
        inference_mode=contextlib.nullcontext,
        nn=SimpleNamespace(
            functional=SimpleNamespace(
                normalize=lambda vector, dim: SimpleNamespace(tolist=lambda: vector)
            )
        ),
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setattr(worker, "load", lambda name: (tokenizer, model))
    assert worker.embed("qwen", ["a", "b"]) == [[3.0, 0.0], [3.0, 0.0]]
    assert worker.embed("bge", ["a"]) == [[1.0, 0.0]]
    assert tokenized[0] == ("a", {"truncation": True, "max_length": 512, "return_tensors": "pt"})


def test_the_pins_are_those_of_the_matcher(worker):
    matcher = (ROOT / "matcher/algorithms/ai-summary/src/encoder.ts").read_text(encoding="utf-8")
    for model, (repository, revision) in worker.MODELS.items():
        block = (
            rf'{model}: {{\s*repository: "{re.escape(repository)}",\s*revision: "{revision}",'
            rf'\s*pooling: "{worker.POOLING[model]}",\s*}}'
        )
        assert re.search(block, matcher), f"encoder.ts pins {model} otherwise"
    assert f'"{worker.INSTRUCTION}"' in matcher
    assert f"maxTokens: {worker.MAX_TOKENS}," in matcher


@pytest.fixture
def programs(worker, monkeypatch):
    """Runs `run_application` without starting or stopping anything: the programs it starts are
    recorded, and so are the process groups it stops and the signals it handles."""
    record = SimpleNamespace(started=[], stopped=[], signals={})

    class Program:
        def __init__(self, arguments, **options):
            self.arguments, self.environment = arguments, options["env"]
            self.pid = len(record.started) + 1
            self.running = True
            record.started.append(self)

        def poll(self):
            return None if self.running else 0

        def wait(self, timeout=None):
            if self.arguments[0] == "node" and record.interrupt and self.running:
                raise KeyboardInterrupt  # what the signal handler raises while the job runs
            self.running = False
            return 0

    def stop_group(pid, sent):
        record.stopped.append(pid)
        record.started[pid - 1].running = False

    record.interrupt = False
    # First the two calls that would reach real processes.
    monkeypatch.setattr(worker.os, "killpg", stop_group)
    monkeypatch.setattr(worker.signal, "signal", record.signals.__setitem__)
    monkeypatch.setattr(worker.subprocess, "Popen", Program)
    monkeypatch.setattr(worker, "health", lambda port: worker.worker_configuration())
    monkeypatch.setenv("DATABASE_URL", "postgresql://user@127.0.0.1/database")
    for setting in ("SEMANTIC_MODEL", "SEMANTIC_MODELS", "SEMANTIC_URL"):  # of the developer
        monkeypatch.delenv(setting, raising=False)
    return record


def test_a_command_starts_an_encoder_of_its_own_next_to_a_running_one(
    worker, programs, monkeypatch
):
    with socket.socket() as running:  # the encoder of another command, on the configured port
        running.bind(("127.0.0.1", 0))
        taken = running.getsockname()[1]
        monkeypatch.setenv("SEMANTIC_URL", f"http://127.0.0.1:{taken}")
        assert worker.run_application("index", 8765) == 0
    encoder, indexer = programs.started
    assert encoder.arguments[:5] == ["uv", "run", "--locked", "scripts/semantic.py", "--prepare"]
    port = int(encoder.arguments[encoder.arguments.index("--port") + 1])
    assert port != taken
    assert indexer.arguments == ["node", "src/main.ts", "ai_summary"]
    assert indexer.environment["SEMANTIC_URL"] == f"http://127.0.0.1:{port}"
    assert indexer.environment["SEMANTIC_MODELS"] == "qwen,bge"
    assert programs.stopped == [encoder.pid]  # the job had ended, its encoder ends with it


def test_a_signal_or_a_closed_terminal_stops_what_the_command_started(worker, programs):
    programs.interrupt = True
    with pytest.raises(KeyboardInterrupt):
        worker.run_application("index", 8765)
    assert sorted(programs.stopped) == [1, 2]
    assert set(programs.signals) == {signal.SIGTERM, signal.SIGHUP}
    for handler in programs.signals.values():
        with pytest.raises(KeyboardInterrupt):
            handler(signal.SIGHUP, None)
