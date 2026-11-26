"""Fetching the one file that makes setup fail.

The PyTorch wheel is 2.9 GB for a CUDA build, and on a home connection it is
where setup falls over. pip streams it into a temporary directory, so a
connection that drops near the end leaves nothing on disk to continue from the
next time. On Windows the clean-up after a failed download also collides with
whatever virus scanner is still holding the half-written file open, which
surfaces as the unhelpful "WinError 32 - the process cannot access the file
because it is being used by another process".

So the wheel is fetched here instead, before pip is asked to install anything:
to a known path under ``runtime/downloads``, continuing an interrupted transfer
with a Range request, and checked against the hash the index publishes next to
the file. A failed attempt leaves the part that arrived in place, so running
setup again carries on from there rather than starting at zero - and someone
who would rather download it in a browser can simply drop the file into that
directory.

Standard library only; see this package's docstring.
"""
from __future__ import annotations

import hashlib
import http.client
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

from .hardware import Machine

CHUNK = 1024 * 1024
MIB = 1024 * 1024
USER_AGENT = "SongForge-setup"
# Long enough to ride out a slow stretch, short enough that a dead connection
# is noticed and resumed rather than hanging until the user gives up.
READ_TIMEOUT = 60.0
ATTEMPTS = 8


class DownloadError(RuntimeError):
    """A file could not be fetched. The message is written for the user."""


class _Interrupted(OSError):
    """The connection closed before the whole body arrived."""


@dataclass(frozen=True)
class Wheel:
    url: str
    filename: str
    sha256: str = ""


# --------------------------------------------------------------------------
# Finding the right file in a package index
# --------------------------------------------------------------------------

class _Anchors(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        for name, value in attrs:
            if name == "href" and value:
                self.hrefs.append(value)


def platform_markers(machine: Machine) -> tuple[str, ...]:
    """Substrings every wheel tag for this machine must contain.

    Deliberately loose: ``linux`` and ``x86_64`` match manylinux and musllinux
    alike, without this module having to know which of them a project ships
    this year.
    """
    processor = machine.machine.lower()
    system = machine.system.lower()
    arm = processor in {"arm64", "aarch64"} or processor.startswith("armv")
    if system == "windows":
        return ("win_arm64",) if arm else ("win_amd64",)
    if system == "darwin":
        return ("macosx", "arm64") if arm else ("macosx", "x86_64")
    if system == "linux":
        return ("linux", "aarch64") if arm else ("linux", "x86_64")
    return ()


def find_wheel(
    index_url: str, package: str, version: str, machine: Machine, *, timeout: float = 30.0,
) -> Wheel | None:
    """The wheel this machine needs, or None if the index publishes no match.

    "No match" is not an error: the caller falls back to letting pip resolve
    the requirement itself, which is what happened before this module existed.
    """
    markers = platform_markers(machine)
    if not markers:
        return None
    major, minor = machine.python[0], machine.python[1]
    interpreter = f"cp{major}{minor}"
    page_url = f"{index_url.rstrip('/')}/{package.replace('_', '-').lower()}/"

    request = urllib.request.Request(page_url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            page = response.read().decode(charset, "replace")
    except (urllib.error.URLError, http.client.HTTPException, OSError, ValueError) as exc:
        raise DownloadError(f"could not read the package index at {page_url}: {exc}") from exc

    # torch-2.10.0+cu128-cp312-cp312-win_amd64.whl
    wanted = re.compile(
        rf"^{re.escape(package)}-{re.escape(version)}(?:\+[A-Za-z0-9._]+)?-(?P<tags>.+)\.whl$"
    )
    anchors = _Anchors()
    anchors.feed(page)
    for href in anchors.hrefs:
        absolute = urllib.parse.urljoin(page_url, href)
        parts = urllib.parse.urlsplit(absolute)
        filename = urllib.parse.unquote(parts.path.rsplit("/", 1)[-1])
        match = wanted.match(filename)
        if not match:
            continue
        tags = match.group("tags")
        if not tags.startswith(f"{interpreter}-"):
            continue
        if not all(marker in tags for marker in markers):
            continue
        hashes = urllib.parse.parse_qs(parts.fragment)
        digest = (hashes.get("sha256") or [""])[0]
        return Wheel(url=urllib.parse.urlunsplit(parts._replace(fragment="")),
                     filename=filename, sha256=digest)
    return None


# --------------------------------------------------------------------------
# Fetching it
# --------------------------------------------------------------------------

def fetch(
    wheel: Wheel,
    destination: Path,
    *,
    log: Callable[[str], None] = print,
    attempts: int = ATTEMPTS,
    timeout: float = READ_TIMEOUT,
) -> Path:
    """Download ``wheel`` to ``destination``, resuming and verifying as it goes."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and _verified(destination, wheel.sha256):
        log(f"    {destination.name} is already here.")
        return destination

    part = destination.with_name(destination.name + ".part")
    problem = "the download did not finish"
    for attempt in range(1, attempts + 1):
        try:
            _one_attempt(wheel, part, timeout=timeout, log=log)
        except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
            problem = str(exc) or exc.__class__.__name__
            have = part.stat().st_size if part.is_file() else 0
            if attempt == attempts:
                break
            pause = min(2 ** attempt, 30)
            log(f"    interrupted at {have // MIB} MB ({problem}); "
                f"continuing in {pause}s - attempt {attempt + 1} of {attempts}")
            time.sleep(pause)
            continue

        if wheel.sha256 and not _verified(part, wheel.sha256):
            # Resuming against a file that is not the one the index describes
            # would repeat forever, so this restart is from zero.
            part.unlink(missing_ok=True)
            problem = "the file that arrived does not match the checksum the index publishes"
            if attempt == attempts:
                break
            log(f"    {problem}; downloading it again")
            continue

        _replace(part, destination)
        log(f"    {destination.name} downloaded.")
        return destination

    raise DownloadError(
        f"{wheel.filename} could not be downloaded after {attempts} attempts: {problem}"
    )


def _one_attempt(wheel: Wheel, part: Path, *, timeout: float, log: Callable[[str], None]) -> None:
    have = part.stat().st_size if part.is_file() else 0
    request = urllib.request.Request(wheel.url, headers={"User-Agent": USER_AGENT})
    if have:
        request.add_header("Range", f"bytes={have}-")

    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as exc:
        with exc:
            # 416 means the file on disk already covers the whole range, so
            # there is nothing left to fetch; the checksum decides if it is good.
            if exc.code == 416 and have:
                return
            raise

    with response:
        if have and getattr(response, "status", 200) != 206:
            # The server ignored the Range header and started from the top.
            log("    this server will not resume; starting the download again")
            have = 0
        length = response.headers.get("Content-Length")
        total = have + int(length) if length and length.isdigit() else 0
        started = time.monotonic()
        spoken = started
        written = have
        with part.open("ab" if have else "wb") as handle:
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                handle.write(chunk)
                written += len(chunk)
                now = time.monotonic()
                if now - spoken >= 5.0:
                    spoken = now
                    log(_progress(written - have, written, total, now - started))

    if total and written < total:
        raise _Interrupted(
            f"the connection closed after {written // MIB} of {total // MIB} MB"
        )


def _progress(this_run: int, written: int, total: int, elapsed: float) -> str:
    speed = this_run / elapsed / MIB if elapsed > 0 else 0.0
    if not total:
        return f"    {written // MIB} MB at {speed:.1f} MB/s"
    share = 100 * written / total
    remaining = (total - written) / (this_run / elapsed) if this_run and elapsed > 0 else 0
    return (f"    {written // MIB} of {total // MIB} MB ({share:.0f}%) "
            f"at {speed:.1f} MB/s, about {remaining / 60:.0f} min left")


def _verified(path: Path, sha256: str) -> bool:
    if not sha256:
        # Nothing to check against: only a complete-looking file gets this far.
        return path.is_file() and path.stat().st_size > 0
    return _digest(path) == sha256.lower()


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def _replace(part: Path, destination: Path, *, attempts: int = 5) -> None:
    """Rename the finished file into place, waiting out a scanner if need be."""
    for attempt in range(1, attempts + 1):
        try:
            os.replace(part, destination)
            return
        except OSError as exc:
            if attempt == attempts:
                raise DownloadError(
                    f"{part.name} finished downloading but could not be renamed: {exc}. "
                    "A virus scanner or a file manager is holding it open."
                ) from exc
            time.sleep(1.0)
