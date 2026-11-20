"""Every copied module must import without credentials or running services."""

import importlib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _modules(base: Path, package: str) -> list[str]:
    names = []
    for path in sorted((base / package).rglob("*.py")):
        parts = path.relative_to(base).with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        names.append(".".join(parts))
    return names


MODULES = _modules(ROOT, "workers")


@pytest.mark.parametrize("module", MODULES)
def test_module_imports(module: str) -> None:
    importlib.import_module(module)
