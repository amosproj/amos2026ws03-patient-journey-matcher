import socket

import pytest


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit tests use fakes; a real connection attempt fails the test instead of a source."""

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("network access is not allowed in unit tests")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
