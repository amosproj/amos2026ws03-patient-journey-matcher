import importlib

import pytest


@pytest.mark.parametrize("module", ["crawler", "asyncpg", "crawlee", "pydantic"])
def test_imports(module: str) -> None:
    importlib.import_module(module)
