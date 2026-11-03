"""Every copied module must import without credentials or running services."""

import importlib
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parent.parent


def _modules(base: Path, package: str) -> list[str]:
    names = []
    for path in sorted((base / package).rglob("*.py")):
        parts = path.relative_to(base).with_suffix("").parts
        if parts[-1] == "__init__":
            parts = parts[:-1]
        names.append(".".join(parts))
    return names


MODULES = [
    *_modules(BACKEND_ROOT, "api"),
    *_modules(BACKEND_ROOT, "workers"),
    *_modules(BACKEND_ROOT, "shared"),
]


@pytest.mark.parametrize("module", MODULES)
def test_module_imports(module: str) -> None:
    importlib.import_module(module)
