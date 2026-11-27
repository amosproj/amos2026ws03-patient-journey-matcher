"""The Pre-filter screen's API in the debug UI: listing, saving and the results of the document
pre-filter study (#92). It only touches the JSON files in research/prefilter/."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PROPOSAL = {"label": "unhelpful", "group": 1, "reason": "cell lines only", "model": "m"}


def entry(document_id, sets, label=None, group=None, proposal=None):
    return {
        "id": document_id,
        "sets": sets,
        "proposal": proposal,
        "proposal_raw": None,
        "label": label,
        "group": group,
        "note": "",
        "checked_at": None,
    }


@pytest.fixture
def server(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location(
        "debug_prefilter_test_server", ROOT / "debug/server.py"
    )
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "PREFILTER_DIR", tmp_path)
    return module


@pytest.fixture
def labels_file(tmp_path):
    path = tmp_path / "labels.json"
    documents = [
        entry("pubmed:1", ["train"], "keep", proposal=PROPOSAL),
        entry("pubmed:2", ["train"], proposal=PROPOSAL),
        entry("pubmed:3", ["random"]),
        entry("pubmed:4", ["train", "drops-rules"], "unhelpful", 1, proposal=PROPOSAL),
    ]
    path.write_text(json.dumps({"version": 1, "guide": [{"kind": "k"}], "documents": documents}))
    return path


def test_status_compares_the_label_with_the_proposal(server):
    assert server.prefilter_status(entry("a", [], proposal=PROPOSAL)) == "unchecked"
    assert server.prefilter_status(entry("a", [], "unhelpful", 1, PROPOSAL)) == "accepted"
    assert server.prefilter_status(entry("a", [], "unhelpful", 2, PROPOSAL)) == "changed"
    assert server.prefilter_status(entry("a", [], "keep", proposal=PROPOSAL)) == "changed"
    assert server.prefilter_status(entry("a", [], "keep")) == "changed"


def test_labels_filter_by_set_and_status(server, labels_file):
    data = server.prefilter_labels({"set": ["train"], "status": ["unchecked"]})
    assert [item["id"] for item in data["items"]] == ["pubmed:2"]
    assert data["items"][0]["status"] == "unchecked"
    assert data["total"] == 1
    assert data["progress"]["train"] == {"checked": 2, "total": 3}
    assert data["progress"]["drops-rules"] == {"checked": 1, "total": 1}
    assert data["guide"] == [{"kind": "k"}]


def test_labels_page_through_all_sets(server, labels_file):
    data = server.prefilter_labels({"limit": ["2"], "offset": ["1"]})
    assert [item["id"] for item in data["items"]] == ["pubmed:2", "pubmed:3"]
    assert data["total"] == 4


def test_labels_refuse_an_unknown_status(server, labels_file):
    with pytest.raises(ValueError):
        server.prefilter_labels({"status": ["maybe"]})


def test_missing_labels_file_answers_missing(server):
    assert server.prefilter_labels({}) == {"missing": True}
