"""Fetching the PyTorch wheel: picking the right one, and surviving the network.

These run against a local HTTP server that can drop a connection part way
through, which is the failure a 2.9 GB wheel hits on a home line. Nothing here
touches the internet.
"""
from __future__ import annotations

import hashlib
import http.server
import threading
from pathlib import Path

import pytest

from songforge.setup.components import Context, SetupError, _torch_wheel
from songforge.setup.download import (
    DownloadError,
    Wheel,
    fetch,
    find_wheel,
    platform_markers,
)
from songforge.setup.hardware import Gpu, Machine, torch_target

WINDOWS = Machine(system="Windows", machine="AMD64", python=(3, 12, 3))
LINUX = Machine(system="Linux", machine="x86_64", python=(3, 12, 3))
LINUX_ARM = Machine(system="Linux", machine="aarch64", python=(3, 12, 3))
MACOS = Machine(system="Darwin", machine="arm64", python=(3, 12, 3))
WINDOWS_311 = Machine(system="Windows", machine="AMD64", python=(3, 11, 9))

# Shaped like the real https://download.pytorch.org/whl/cu128/torch/ page,
# including the +cu128 local version and the sha256 fragment.
INDEX_HTML = """<!DOCTYPE html><html><body>
<a href="/files/torch-2.10.0%2Bcu128-cp311-cp311-win_amd64.whl#sha256=1111">a</a>
<a href="/files/torch-2.10.0%2Bcu128-cp312-cp312-manylinux_2_28_aarch64.whl#sha256=2222">b</a>
<a href="/files/torch-2.10.0%2Bcu128-cp312-cp312-manylinux_2_28_x86_64.whl#sha256=3333">c</a>
<a href="/files/torch-2.10.0%2Bcu128-cp312-cp312-win_amd64.whl#sha256=4444">d</a>
<a href="/files/torch-2.10.0%2Bcu128-cp312-cp312-macosx_11_0_arm64.whl#sha256=5555">e</a>
<a href="/files/torch-2.9.0%2Bcu128-cp312-cp312-win_amd64.whl#sha256=6666">f</a>
<a href="/files/torchvision-0.25.0%2Bcu128-cp312-cp312-win_amd64.whl#sha256=7777">g</a>
</body></html>"""

PAYLOAD = bytes(range(256)) * 400  # 100 KB, enough to interrupt part way
DIGEST = hashlib.sha256(PAYLOAD).hexdigest()


class _Handler(http.server.BaseHTTPRequestHandler):
    """Serves the index page and one file, and can cut a transfer short."""

    payload = PAYLOAD
    drop_after: int | None = None   # bytes to send before hanging up
    ignore_range = False
    ranges: list[str | None] = []

    def log_message(self, *args) -> None:  # keep the test output quiet
        pass

    def log_error(self, *args) -> None:
        pass

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        if self.path.endswith("/torch/"):
            body = INDEX_HTML.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        header = self.headers.get("Range")
        type(self).ranges.append(header)
        start = 0
        if header and not self.ignore_range:
            start = int(header.split("=", 1)[1].split("-", 1)[0])
            if start >= len(self.payload):
                self.send_error(416)
                return
            self.send_response(206)
            self.send_header(
                "Content-Range",
                f"bytes {start}-{len(self.payload) - 1}/{len(self.payload)}",
            )
        else:
            self.send_response(200)

        body = self.payload[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.drop_after is not None and len(body) > self.drop_after:
            # Fewer bytes than Content-Length promised, then hang up: what a
            # connection dropping half way through a 2.9 GB wheel looks like.
            self.wfile.write(body[: self.drop_after])
            self.wfile.flush()
            self.close_connection = True
            return
        self.wfile.write(body)


@pytest.fixture
def server():
    _Handler.payload = PAYLOAD
    _Handler.drop_after = None
    _Handler.ignore_range = False
    _Handler.ranges = []
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=5)


def wheel_for(server: str) -> Wheel:
    return Wheel(url=f"{server}/files/torch.whl", filename="torch.whl", sha256=DIGEST)


# ------------------------------------------------------------ picking a wheel

@pytest.mark.parametrize(("machine", "expected"), [
    (WINDOWS, "torch-2.10.0+cu128-cp312-cp312-win_amd64.whl"),
    (LINUX, "torch-2.10.0+cu128-cp312-cp312-manylinux_2_28_x86_64.whl"),
    (LINUX_ARM, "torch-2.10.0+cu128-cp312-cp312-manylinux_2_28_aarch64.whl"),
    (MACOS, "torch-2.10.0+cu128-cp312-cp312-macosx_11_0_arm64.whl"),
    (WINDOWS_311, "torch-2.10.0+cu128-cp311-cp311-win_amd64.whl"),
])
def test_each_machine_finds_its_own_wheel(server, machine, expected) -> None:
    found = find_wheel(server, "torch", "2.10.0", machine)
    assert found is not None
    assert found.filename == expected
    assert found.url.startswith(server) and "#" not in found.url
    assert found.sha256 and len(found.sha256) >= 4


def test_another_version_or_project_is_never_picked(server) -> None:
    """2.9.0 and torchvision share every tag with the wheel we want."""
    found = find_wheel(server, "torch", "2.10.0", WINDOWS)
    assert found is not None
    assert found.filename.startswith("torch-2.10.0+")
    assert find_wheel(server, "torch", "2.11.0", WINDOWS) is None


def test_an_unknown_platform_asks_pip_instead() -> None:
    assert platform_markers(Machine(system="FreeBSD", machine="amd64", python=(3, 12, 0))) == ()


def test_an_unreachable_index_is_reported_not_swallowed() -> None:
    with pytest.raises(DownloadError, match="could not read the package index"):
        find_wheel("http://127.0.0.1:9", "torch", "2.10.0", WINDOWS)


# ---------------------------------------------------------------- fetching it

def test_a_whole_file_arrives_and_is_verified(server, tmp_path) -> None:
    target = fetch(wheel_for(server), tmp_path / "torch.whl", log=lambda _m: None)
    assert target.read_bytes() == PAYLOAD
    assert not (tmp_path / "torch.whl.part").exists()


def test_an_interrupted_download_resumes_where_it_stopped(server, tmp_path) -> None:
    """The real failure: the connection dies part way through a huge file."""
    _Handler.drop_after = 40_000

    def stop_dropping_after_the_first_attempt(_message: str) -> None:
        _Handler.drop_after = None

    target = fetch(wheel_for(server), tmp_path / "torch.whl",
                   log=stop_dropping_after_the_first_attempt, attempts=3)

    assert target.read_bytes() == PAYLOAD
    # The second request asked for the rest, not the whole file again.
    assert _Handler.ranges[0] is None
    assert _Handler.ranges[1] == "bytes=40000-"


def test_a_part_file_from_an_earlier_run_is_continued(server, tmp_path) -> None:
    (tmp_path / "torch.whl.part").write_bytes(PAYLOAD[:60_000])
    target = fetch(wheel_for(server), tmp_path / "torch.whl", log=lambda _m: None)
    assert target.read_bytes() == PAYLOAD
    assert _Handler.ranges == ["bytes=60000-"]


def test_a_server_that_ignores_range_starts_again_cleanly(server, tmp_path) -> None:
    _Handler.ignore_range = True
    (tmp_path / "torch.whl.part").write_bytes(PAYLOAD[:60_000])
    target = fetch(wheel_for(server), tmp_path / "torch.whl", log=lambda _m: None)
    assert target.read_bytes() == PAYLOAD   # not 60 KB longer than it should be


def test_a_complete_part_file_is_accepted_without_refetching(server, tmp_path) -> None:
    """A 416 means the bytes are all there; the checksum still has to agree."""
    (tmp_path / "torch.whl.part").write_bytes(PAYLOAD)
    target = fetch(wheel_for(server), tmp_path / "torch.whl", log=lambda _m: None)
    assert target.read_bytes() == PAYLOAD


def test_a_corrupt_file_is_thrown_away_rather_than_installed(server, tmp_path) -> None:
    wrong = Wheel(url=f"{server}/files/torch.whl", filename="torch.whl",
                  sha256=hashlib.sha256(b"something else").hexdigest())
    with pytest.raises(DownloadError, match="checksum"):
        fetch(wrong, tmp_path / "torch.whl", log=lambda _m: None, attempts=2)
    assert not (tmp_path / "torch.whl").exists()
    assert not (tmp_path / "torch.whl.part").exists()


def test_a_file_already_downloaded_is_not_downloaded_again(server, tmp_path) -> None:
    (tmp_path / "torch.whl").write_bytes(PAYLOAD)
    fetch(wheel_for(server), tmp_path / "torch.whl", log=lambda _m: None)
    assert _Handler.ranges == []   # someone can drop the file in by hand


def test_giving_up_says_what_was_kept(server, tmp_path) -> None:
    _Handler.drop_after = 10_000
    with pytest.raises(DownloadError, match="could not be downloaded after 2 attempts"):
        fetch(wheel_for(server), tmp_path / "torch.whl", log=lambda _m: None, attempts=2)
    # Each attempt added what it managed, and the part file survives for the
    # next run of setup rather than being deleted.
    assert (tmp_path / "torch.whl.part").stat().st_size == 20_000
    assert not (tmp_path / "torch.whl").exists()


# ------------------------------------------------------- the install step

def context(tmp_path: Path, **kwargs) -> Context:
    gpu = Gpu(vendor="nvidia", name="RTX 3060", memory_gib=12.0, compute=(8, 6), driver="617.14")
    return Context(root=tmp_path, machine=WINDOWS, gpu=gpu,
                   torch=torch_target(gpu, WINDOWS), log=lambda _m: None, **kwargs)


def test_a_dry_run_downloads_nothing(tmp_path) -> None:
    assert _torch_wheel(context(tmp_path, dry_run=True)) is None


def test_an_unreadable_index_falls_back_to_pip(tmp_path, monkeypatch) -> None:
    def refuse(*_args, **_kwargs):
        raise DownloadError("could not read the package index")

    monkeypatch.setattr("songforge.setup.components.find_wheel", refuse)
    assert _torch_wheel(context(tmp_path)) is None


def test_no_matching_wheel_falls_back_to_pip(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("songforge.setup.components.find_wheel", lambda *a, **k: None)
    assert _torch_wheel(context(tmp_path)) is None


def test_a_failed_download_explains_how_to_finish_it(tmp_path, monkeypatch) -> None:
    wheel = Wheel(url="https://example/torch.whl", filename="torch.whl", sha256="abc")
    monkeypatch.setattr("songforge.setup.components.find_wheel", lambda *a, **k: wheel)

    def give_up(*_args, **_kwargs):
        raise DownloadError("torch.whl could not be downloaded after 8 attempts: timed out")

    monkeypatch.setattr("songforge.setup.components.fetch", give_up)
    with pytest.raises(SetupError) as raised:
        _torch_wheel(context(tmp_path))
    message = str(raised.value)
    assert "continues from there" in message      # re-running resumes
    assert "virus scanner" in message             # the WinError 32 cause
    assert "https://example/torch.whl" in message  # fetch it by hand
