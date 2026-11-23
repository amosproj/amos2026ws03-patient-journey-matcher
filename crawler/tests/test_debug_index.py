"""Index screen dispatch uses the selected technique even when both encoders are enabled, and
the Index › AI screen starts and stops the local encoder."""

import importlib.util
import signal
import socket
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

ROOT = Path(__file__).resolve().parents[2]
HEALTH = {"service": "patient-journey-semantic", "device": "cpu"}


@pytest.fixture
def module(monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "debug_index_test_server", ROOT / "debug/server.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    for setting in ("SEMANTIC_URL", "SEMANTIC_DEVICE"):  # of the developer
        monkeypatch.delenv(setting, raising=False)
    return module


@pytest.fixture
def server(module, monkeypatch):
    monkeypatch.setattr(
        module,
        "matcher_environment",
        lambda: {"SEMANTIC_MODEL": "qwen", "SEMANTIC_MODELS": "qwen,bge"},
    )
    monkeypatch.setattr(module, "encoder_health", lambda url: HEALTH)
    return module


@pytest.mark.parametrize(
    ("technique", "arguments", "models"),
    [
        ("keyword", ["keyword"], "qwen,bge"),
        ("qwen", ["ai_summary"], "qwen"),
        ("bge", ["ai_summary"], "bge"),
        ("semantic", ["ai_summary"], "qwen,bge"),
    ],
)
def test_selected_index_process(server, monkeypatch, technique, arguments, models):
    thread = Mock()
    monkeypatch.setattr(server.threading, "Thread", thread)
    run = server.start_indexer(technique)
    environment = thread.call_args.kwargs["args"][1]
    process = Mock(return_value=SimpleNamespace(stdout=[], wait=lambda: 0))
    monkeypatch.setattr(server.subprocess, "Popen", process)
    server.run_indexer(run, environment)
    assert process.call_args.args[0] == ["node", "src/main.ts", *arguments]
    assert process.call_args.kwargs["env"]["SEMANTIC_MODELS"] == models
    assert run.status == "finished"


def test_unknown_index_selection_is_refused(server):
    with pytest.raises(ValueError, match="Choose"):
        server.start_indexer("unknown")


@pytest.mark.parametrize("technique", ["qwen", "bge", "semantic"])
def test_semantic_overview_uses_only_selected_models(server, monkeypatch, technique):
    profiles = [
        {"model": "qwen", "table": "ai_summary.qwen_fixture"},
        {"model": "bge", "table": "ai_summary.bge_fixture"},
    ]
    monkeypatch.setattr(server, "semantic_profiles", lambda: profiles)

    class Connection:
        async def fetchval(self, sql, *args):
            return True

    async def rows(connection, sql, *args):
        assert "keyword." not in sql
        assert "embedding" in sql
        return [
            {
                "source": "pubmed",
                "content_type": "journal_article",
                "documents": 5,
                "indexed": 3,
                "pending": 1,
                "empty": 1,
            }
        ]

    monkeypatch.setattr(server, "fetch_json", rows)
    result = server.asyncio.run(server.index_overview(Connection(), technique))
    expected = ["qwen", "bge"] if technique == "semantic" else [technique]
    assert [model["model"] for model in result["models"]] == expected
    assert all(model["indexed"] == 3 and model["pending"] == 1 for model in result["models"])
    assert "words" not in result and "extension" not in result


def test_ai_indexing_needs_the_encoder(server, monkeypatch):
    monkeypatch.setattr(server, "encoder_health", lambda url: None)
    monkeypatch.setattr(server.threading, "Thread", Mock())
    with pytest.raises(RuntimeError, match="needs the encoder"):
        server.start_indexer("qwen")
    assert server.start_indexer("keyword").approach == "keyword"


class Process:
    """The encoder's process: what uv started, with the lines it wrote."""

    pid = 4242

    def __init__(self, arguments, **options):
        self.arguments, self.options = arguments, options
        self.stdout = iter(
            [
                "model.safetensors:  10%|#         | 1/10\n",
                "model.safetensors:  50%|#####     | 5/10\n",
                "\n",
                "Loaded\n",
            ]
        )
        self.code = None

    def poll(self):
        return self.code

    def wait(self, timeout=None):
        self.code = -signal.SIGTERM if self.code is None else self.code
        return self.code


class Thread:
    """Runs its target at once, so that the encoder's lines are read before the test looks."""

    def __init__(self, target, daemon):
        self.target = target

    def start(self):
        self.target()


@pytest.fixture
def encoder(module, monkeypatch):
    """`start_encoder` with the configured port taken, nothing answering and no real process."""
    monkeypatch.setattr(module.subprocess, "Popen", Process)
    monkeypatch.setattr(module.threading, "Thread", Thread)
    monkeypatch.setattr(module, "encoder_health", lambda url: None)
    monkeypatch.setenv("VIRTUAL_ENV", "/the/crawler/.venv")
    stopped = []
    monkeypatch.setattr(module.os, "killpg", lambda pid, sent: stopped.append((pid, sent)))
    with socket.socket() as taken:
        taken.bind(("127.0.0.1", 0))
        port = taken.getsockname()[1]
        monkeypatch.setenv("SEMANTIC_URL", f"http://127.0.0.1:{port}")
        state = module.start_encoder()
    return SimpleNamespace(state=state, taken=port, stopped=stopped)


def test_the_encoder_starts_on_a_free_port_and_reaches_the_matcher(module, encoder):
    process = module.ENCODER.process
    port = int(process.arguments[-1])
    assert process.arguments == [
        "uv", "run", "--locked", "scripts/semantic.py", "--prepare",
        "--device", "cpu", "--port", str(port),
    ]  # fmt: skip
    assert port != encoder.taken
    assert process.options["cwd"] == ROOT
    assert process.options["start_new_session"] is True
    assert "VIRTUAL_ENV" not in process.options["env"]
    assert encoder.state["status"] == "starting" and encoder.state["own"] is True
    # A progress bar keeps one line per file.
    assert encoder.state["lines"] == ["model.safetensors:  50%|#####     | 5/10", "Loaded"]
    assert module.with_encoder({"DATABASE_URL": "postgresql://x"}) == {
        "DATABASE_URL": "postgresql://x",
        "SEMANTIC_URL": f"http://127.0.0.1:{port}",
        "SEMANTIC_DEVICE": "cpu",
    }
    with pytest.raises(RuntimeError, match="already starting"):
        module.start_encoder()


def test_a_stop_ends_the_process_group_but_not_during_an_ai_index_run(module, encoder):
    module.INDEXING = SimpleNamespace(status="running", approach="ai_summary")
    with pytest.raises(RuntimeError, match="stop the indexer first"):
        module.stop_encoder()
    module.INDEXING = SimpleNamespace(status="running", approach="keyword")
    assert module.stop_encoder()["status"] == "stopped"
    assert encoder.stopped == [(Process.pid, signal.SIGTERM)]
    assert module.ENCODER is None
    assert "SEMANTIC_URL" not in module.with_encoder({})


def test_an_encoder_that_ended_shows_why(module, encoder):
    module.ENCODER.process.code = 1
    state = module.encoder_state()
    assert (state["status"], state["code"]) == ("failed", 1)
    assert state["lines"][-1] == "Loaded"
    assert module.with_encoder({}) == {}


def test_the_encoder_of_another_command_shows_but_stays(module, monkeypatch):
    monkeypatch.setattr(module, "encoder_health", lambda url: {**HEALTH, "device": "mps"})
    state = module.encoder_state()
    assert (state["status"], state["own"], state["device"]) == ("running", False, "mps")
    assert state["url"] == "http://127.0.0.1:8766"
    with pytest.raises(RuntimeError, match="already running"):
        module.start_encoder()
    with pytest.raises(RuntimeError, match="started no encoder"):
        module.stop_encoder()
