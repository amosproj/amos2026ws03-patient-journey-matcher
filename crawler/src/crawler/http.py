"""Helpers for the JSON APIs that are called with the standard library."""

import time
import urllib.request
from collections.abc import Callable
from types import TracebackType

Fetch = Callable[[urllib.request.Request, float], bytes]


def urlopen_bytes(request: urllib.request.Request, timeout: float) -> bytes:
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body: bytes = response.read()
    return body


class Pacer:
    """Keeps at least `min_interval` seconds between the end of one call and the next.

    Use it as a context manager around each call.
    """

    def __init__(
        self,
        min_interval: float,
        *,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._min_interval = min_interval
        self._sleep = sleep
        self._clock = clock
        self._last_call: float | None = None

    def __enter__(self) -> None:
        if self._last_call is not None:
            wait = self._min_interval - (self._clock() - self._last_call)
            if wait > 0:
                self._sleep(wait)

    def __exit__(
        self,
        _type: type[BaseException] | None,
        _error: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        self._last_call = self._clock()
