"""Index screen dispatch uses the selected technique even when both encoders are enabled."""

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


@pytest.fixture
def server(monkeypatch):
    path = Path(__file__).resolve().parents[2] / "debug/server.py"
    spec = importlib.util.spec_from_file_location("debug_index_test_server", path)
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    monkeypatch.setattr(
        module,
        "matcher_environment",
        lambda: {"SEMANTIC_MODEL": "qwen", "SEMANTIC_MODELS": "qwen,bge"},
    )
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
