import asyncio
import os
import socket
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[2]


async def _execute(url: str, sql: str) -> None:
    import asyncpg

    connection = await asyncpg.connect(url)
    try:
        await connection.execute(sql)
    finally:
        await connection.close()


@pytest.fixture(autouse=True)
def no_network(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit tests use fakes; a real connection attempt fails the test instead of a source.

    Tests marked `postgres` talk to the database at `TEST_DATABASE_URL` instead. On Windows the
    event loop connects without `socket.connect`, so a database connection is not refused here:
    unit tests must fake the store, not rely on this guard.
    """
    if request.node.get_closest_marker("postgres"):
        return
    real_connect = socket.socket.connect
    real_socketpair = socket.socketpair
    pairing = False

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("network access is not allowed in unit tests")

    def connect(sock: socket.socket, address: Any) -> None:
        if not pairing:
            refuse()
        real_connect(sock, address)

    def socketpair(*args: Any, **kwargs: Any) -> tuple[socket.socket, socket.socket]:
        # Windows has no native socketpair, so asyncio's event loop connects two loopback sockets.
        nonlocal pairing
        pairing = True
        try:
            return real_socketpair(*args, **kwargs)
        finally:
            pairing = False

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "socketpair", socketpair)


@pytest.fixture(autouse=True)
def no_ncbi_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """The shared NCBI throttle would sleep between the fake Entrez calls of the tests."""
    from crawler.sources.pubmed import NCBI_THROTTLE

    monkeypatch.setattr(NCBI_THROTTLE, "_sleep", lambda _seconds: None)


@pytest.fixture
def url() -> Iterator[str]:
    """A fresh schema with `db/init/` applied at `TEST_DATABASE_URL`; dropped at the end."""
    database = os.environ.get("TEST_DATABASE_URL", "").strip()
    if not database:
        if os.environ.get("CI"):
            pytest.fail("TEST_DATABASE_URL must be set on CI")
        pytest.skip("TEST_DATABASE_URL is not set")
    asyncio.run(_execute(database, "CREATE EXTENSION IF NOT EXISTS vector"))
    schema = f"test_{uuid4().hex[:12]}"
    asyncio.run(_execute(database, f"CREATE SCHEMA {schema}"))
    scoped = f"{database}{'&' if '?' in database else '?'}search_path={schema},public"
    try:
        for path in sorted((ROOT / "db/init").glob("*.sql")):
            asyncio.run(_execute(scoped, path.read_text(encoding="utf-8")))
        yield scoped
    finally:
        asyncio.run(_execute(database, f"DROP SCHEMA {schema} CASCADE"))
