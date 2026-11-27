# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "asyncpg==0.32.0",
#   "huggingface-hub==0.36.2",
#   "numpy==2.5.4",
#   "scikit-learn==1.9.1",
#   "torch==2.9.1",
#   "transformers==4.57.3",
# ]
#
# # The default build for Linux on x86-64 brings NVIDIA's libraries, which are not open source.
# [tool.uv.sources]
# torch = [{ index = "pytorch-cpu", marker = "sys_platform == 'linux' and platform_machine == 'x86_64'" }]  # noqa: E501
#
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
"""The document pre-filter study (#92): can rules and a small classifier drop unhelpful documents?

    uv run --locked scripts/prefilter.py sample --set train
    uv run --locked scripts/prefilter.py propose --set train
    uv run --locked scripts/prefilter.py train
    uv run --locked scripts/prefilter.py measure

Reads `DATABASE_URL` (or `--database-url`) and only reads: every connection is read only. Writes
the labels, the classifier and the results to research/prefilter/. People check the proposed
labels in the Pre-filter screen of the debug UI. Method and results: research/document-prefilter.md.
"""

import argparse
import json
import os
import tempfile
from collections.abc import Iterable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "research/prefilter/labels.json"
MODEL = ROOT / "research/prefilter/model.json"
RESULTS = ROOT / "research/prefilter/results.json"

# Where the line for group 1 ("not usable for patients") is; agreed on #92. In doubt, keep.
GUIDE = [
    {
        "kind": "Pure lab or animal work: cell lines, mice, molecular mechanisms",
        "label": "unhelpful",
        "example": "Altered glycosylation in prostate cancer",
    },
    {
        "kind": "Pure methods or statistics papers",
        "label": "unhelpful",
        "example": "a new scoring algorithm",
    },
    {
        "kind": "Clinician work topics",
        "label": "unhelpful",
        "example": "Intraoperative workload of the surgeon in robot-assisted prostatectomy",
    },
    {
        "kind": "Regional statistics",
        "label": "keep",
        "example": "Radical prostatectomy trends 2010-2020 in Ehime, Japan",
    },
    {
        "kind": "Rare patient subgroups",
        "label": "keep",
        "example": "Radical prostatectomy outcomes in renal transplant recipients",
    },
    {
        "kind": "Lab work about a drug patients take",
        "label": "keep",
        "example": "Non-coding RNAs in enzalutamide resistance",
    },
]


def load_labels(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": 1, "guide": GUIDE, "documents": []}
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def save_labels(path: Path, data: dict[str, Any]) -> None:
    """Write through a temporary file, so a crash never leaves half a labels file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False
    ) as file:
        json.dump(data, file, indent=2, ensure_ascii=False)
        file.write("\n")
    os.replace(file.name, path)


def add_documents(data: dict[str, Any], ids: Iterable[str], set_name: str) -> int:
    """Put `ids` into `set_name`; labels, notes and proposals of known ids stay as they are."""
    known = {entry["id"]: entry for entry in data["documents"]}
    added = 0
    for document_id in ids:
        entry = known.get(document_id)
        if entry is None:
            entry = {
                "id": document_id,
                "sets": [],
                "proposal": None,
                "proposal_raw": None,
                "label": None,
                "group": None,
                "note": "",
                "checked_at": None,
            }
            data["documents"].append(entry)
            known[document_id] = entry
            added += 1
        if set_name not in entry["sets"]:
            entry["sets"].append(set_name)
    return added


def checked(data: dict[str, Any], set_name: str) -> list[dict[str, Any]]:
    """The entries of a set that a person has labeled."""
    return [
        entry
        for entry in data["documents"]
        if set_name in entry["sets"] and entry["label"] is not None
    ]


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    cli.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    commands = cli.add_subparsers(dest="command", required=True)
    sample = commands.add_parser("sample", help="add a sample of documents to the labels file")
    sample.add_argument("--set", choices=["train", "random"], required=True)
    sample.add_argument("--n", type=int)
    propose = commands.add_parser("propose", help="let a local LLM propose labels")
    propose.add_argument("--set")
    propose.add_argument("--limit", type=int)
    commands.add_parser("train", help="train the classifier on the checked training labels")
    commands.add_parser("measure", help="measure drops, safety and speed into the results file")
    return cli


def main(argv: list[str] | None = None) -> None:
    args = parser().parse_args(argv)
    raise SystemExit(f"{args.command}: not implemented")


if __name__ == "__main__":
    main()
