"""The document pre-filter study (scripts/prefilter.py, #92) without its heavy dependencies:
the labels file, the safety statistics, the rules, the samples and the summary of the results."""

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def prefilter(monkeypatch):
    spec = importlib.util.spec_from_file_location("prefilter_test", ROOT / "scripts/prefilter.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def test_cli_has_the_four_subcommands(prefilter, capsys):
    with pytest.raises(SystemExit):
        prefilter.main(["--help"])
    out = capsys.readouterr().out
    for command in ("sample", "propose", "train", "measure"):
        assert command in out


def test_load_labels_starts_with_the_guide_when_missing(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    assert data == {"version": 1, "guide": prefilter.GUIDE, "documents": []}
    assert len(prefilter.GUIDE) == 6


def test_add_documents_keeps_labels_on_rerun(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    assert prefilter.add_documents(data, ["pubmed:1", "pubmed:2"], "train") == 2
    data["documents"][0] |= {"label": "keep", "note": "trial"}
    assert prefilter.add_documents(data, ["pubmed:1", "pubmed:3"], "random") == 1
    first = data["documents"][0]
    assert first["sets"] == ["train", "random"]
    assert (first["label"], first["note"]) == ("keep", "trial")
    assert len(data["documents"]) == 3


def test_new_entries_have_no_label_and_no_proposal(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    prefilter.add_documents(data, ["pubmed:1"], "train")
    assert data["documents"][0] == {
        "id": "pubmed:1",
        "sets": ["train"],
        "proposal": None,
        "proposal_raw": None,
        "label": None,
        "group": None,
        "note": "",
        "checked_at": None,
    }


def test_checked_lists_only_labeled_entries_of_a_set(prefilter, tmp_path):
    data = prefilter.load_labels(tmp_path / "labels.json")
    prefilter.add_documents(data, ["pubmed:1", "pubmed:2"], "train")
    data["documents"][1]["label"] = "keep"
    assert [entry["id"] for entry in prefilter.checked(data, "train")] == ["pubmed:2"]
    assert prefilter.checked(data, "random") == []


def test_save_labels_round_trips_and_leaves_no_temp_file(prefilter, tmp_path):
    path = tmp_path / "labels.json"
    data = prefilter.load_labels(path)
    prefilter.add_documents(data, ["pubmed:1"], "train")
    prefilter.save_labels(path, data)
    assert prefilter.load_labels(path) == data
    assert [p.name for p in tmp_path.iterdir()] == ["labels.json"]
