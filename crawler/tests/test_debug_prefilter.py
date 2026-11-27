"""The Pre-filter screen's API in the debug UI: listing, saving and the results of the document
pre-filter study (#92). It only touches the JSON files in research/prefilter/."""

import importlib.util
import json
import sys
import threading
import time
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


def stored(path):
    return {item["id"]: item for item in json.loads(path.read_text())["documents"]}


@pytest.mark.parametrize(
    "body",
    [
        {"id": "pubmed:2", "label": "unhelpful", "group": None},
        {"id": "pubmed:2", "label": "keep", "group": 1},
        {"id": "pubmed:2", "label": "maybe", "group": None},
        {"id": "pubmed:2", "label": "keep", "group": None, "note": "x" * 501},
        {"id": "pubmed:2", "label": "keep", "group": None, "note": 5},
    ],
)
def test_save_label_validates(server, labels_file, body):
    with pytest.raises(ValueError):
        server.save_prefilter_label(body)
    assert stored(labels_file)["pubmed:2"]["label"] is None


def test_save_label_refuses_an_unknown_document(server, labels_file):
    with pytest.raises(LookupError):
        server.save_prefilter_label({"id": "pubmed:404", "label": "keep", "group": None})


def test_save_label_keeps_the_proposal(server, labels_file):
    body = {"id": "pubmed:2", "label": "keep", "group": None, "note": "trial"}
    saved = server.save_prefilter_label(body)
    assert saved["status"] == "changed" and saved["checked_at"]
    entry = stored(labels_file)["pubmed:2"]
    assert (entry["label"], entry["note"], entry["proposal"]) == ("keep", "trial", PROPOSAL)
    assert not [p.name for p in labels_file.parent.iterdir() if p.suffix == ".tmp"]


def test_parallel_saves_keep_both_labels(server, labels_file):
    original = server.prefilter_write

    def slow_write(path, data):  # widen the window between reading and writing
        time.sleep(0.05)
        original(path, data)

    server.prefilter_write = slow_write
    threads = [
        threading.Thread(
            target=server.save_prefilter_label,
            args=({"id": document_id, "label": "keep", "group": None},),
        )
        for document_id in ("pubmed:2", "pubmed:3")
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    entries = stored(labels_file)
    assert entries["pubmed:2"]["label"] == entries["pubmed:3"]["label"] == "keep"


def test_results_come_from_the_results_file(server, tmp_path):
    assert server.prefilter_results() == {"missing": True}
    (tmp_path / "results.json").write_text(json.dumps({"total": 3}))
    assert server.prefilter_results() == {"total": 3}


def test_save_waits_for_the_lock_the_script_holds(server, labels_file):
    import fcntl

    lock = open(labels_file.parent / ".labels.lock", "a")  # noqa: SIM115 — the script's lock
    fcntl.flock(lock, fcntl.LOCK_EX)
    done = threading.Event()
    body = {"id": "pubmed:2", "label": "keep", "group": None}
    thread = threading.Thread(target=lambda: (server.save_prefilter_label(body), done.set()))
    thread.start()
    assert not done.wait(0.2)
    fcntl.flock(lock, fcntl.LOCK_UN)
    lock.close()
    assert done.wait(2)
    assert stored(labels_file)["pubmed:2"]["label"] == "keep"


@pytest.mark.parametrize("group", [True, 1.0, "1"])
def test_save_label_takes_only_whole_number_groups(server, labels_file, group):
    with pytest.raises(ValueError):
        server.save_prefilter_label({"id": "pubmed:2", "label": "unhelpful", "group": group})
