"""The Docs screen gets the Markdown files that git lists, and of the other files only images and
PDFs, never a path outside that list."""

import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FILES = {
    "README.md": "# Project\n",
    "docs/guide.md": "# Guide\n",
    "docs/diagram.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "docs/notes.txt": "not a doc",
    ".github/template.md": "# Template\n",
    ".env": "SECRET=1\n",
    "out/report.md": "# Generated\n",
    ".gitignore": "out/\n.env\n",
}


@pytest.fixture
def server(monkeypatch, tmp_path):
    spec = importlib.util.spec_from_file_location("debug_docs_server", ROOT / "debug/server.py")
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    for name, text in FILES.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(text, encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "add", "README.md"], cwd=tmp_path, check=True)  # the rest is new
    monkeypatch.setattr(module, "ROOT", tmp_path)
    return module


def test_the_docs_are_the_markdown_files_git_lists(server):
    docs = server.docs()["docs"]
    assert [doc["path"] for doc in docs] == ["README.md", "docs/guide.md"]
    assert docs[1]["text"] == "# Guide\n"


def test_an_image_of_the_checkout_is_served(server):
    body, content_type = server.doc_file("docs/diagram.svg")
    assert content_type == "image/svg+xml"
    assert body.startswith(b"<svg")


@pytest.mark.parametrize(
    "name",
    [
        "docs/notes.txt",
        "README.md",
        ".env",
        "../.env",
        "docs/../.env",
        "out/report.md",
        "docs/missing.svg",
        "/etc/passwd",
    ],
)
def test_other_paths_are_refused(server, name):
    with pytest.raises(LookupError):
        server.doc_file(name)


def test_an_absolute_path_is_refused(server):
    with pytest.raises(LookupError):
        server.doc_file(str(server.ROOT / "docs/diagram.svg"))


def test_the_docs_need_git(server, monkeypatch):
    monkeypatch.setattr(server, "probe", lambda argv, **env: None)
    with pytest.raises(RuntimeError):
        server.docs()
