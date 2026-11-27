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
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "research/prefilter/labels.json"
MODEL = ROOT / "research/prefilter/model.json"
RESULTS = ROOT / "research/prefilter/results.json"


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
