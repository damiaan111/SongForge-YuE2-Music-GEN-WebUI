"""Test fixtures.

Each test gets an isolated runtime directory, so nothing touches real projects.
"""
from __future__ import annotations

import os
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def runtime_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Point the whole app at a throwaway runtime directory."""
    root = tmp_path / "runtime"
    root.mkdir()
    monkeypatch.setenv("SONGFORGE_RUNTIME_DIR", str(root))
    monkeypatch.setenv("SONGFORGE_HOST", "127.0.0.1")

    # Caches hold the previous runtime path, so clear them between tests.
    from songforge import config, db

    config.get_config.cache_clear()
    db._engine = None
    yield root
    db._engine = None
    config.get_config.cache_clear()


@pytest.fixture
def app(runtime_dir: Path):
    from songforge.main import create_app

    return create_app()


@pytest.fixture
def client(app) -> Iterator:
    """TestClient runs the lifespan, so the queue worker is live."""
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def fast_mock(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make the MockRunner finish quickly so tests stay fast."""
    from songforge.runners import mock as mock_module

    original = mock_module.MockRunner.__init__

    def quick_init(self, **kwargs):
        kwargs.setdefault("duration_seconds", 1.0)
        kwargs.setdefault("total_runtime_seconds", 0.3)
        original(self, **kwargs)

    monkeypatch.setattr(mock_module.MockRunner, "__init__", quick_init)


@pytest.fixture
def live_server(runtime_dir: Path):
    """A real uvicorn server on a free port.

    Needed for streaming endpoints: TestClient and httpx's ASGI transport both
    buffer the response body, so SSE frames would never arrive incrementally.
    """
    import socket
    import threading
    import time

    import uvicorn

    from songforge import config, db
    from songforge.main import create_app

    config.get_config.cache_clear()
    db._engine = None

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    server = uvicorn.Server(
        uvicorn.Config(create_app(), host="127.0.0.1", port=port, log_level="warning")
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and not server.started:
        time.sleep(0.05)
    if not server.started:
        server.should_exit = True
        raise RuntimeError("the test server did not start")

    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=20)


def wait_for(predicate, timeout: float = 30.0, interval: float = 0.1) -> bool:
    """Poll ``predicate`` until it is true or the timeout expires."""
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False
