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
