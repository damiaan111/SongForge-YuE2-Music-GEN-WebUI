"""Project filesystem layout.

Every project lives at ``runtime/projects/{uuid}/`` with this shape::

    project.json
    lyrics-v{n}.txt
    style-v{n}.txt
    request-v{n}.json
    score-v{n}.abc          (when a score exists)
    versions/v{n}/song.flac
    versions/v{n}/song.mp3  (when exported)
    versions/v{n}/song.wav  (when exported)
    versions/v{n}/waveform.json
    versions/v{n}/generation.log
    versions/v{n}/runner-command.txt
    versions/v{n}/metadata.json

Project identity is always a UUID. User text never becomes a path segment.
"""
from __future__ import annotations

import json
import shutil
import struct
import wave
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import get_config
from .paths import safe_join

# Files a client may request through the download endpoint, mapped to the real
# name on disk. An allowlist, so no user string ever selects a path.
DOWNLOADABLE: dict[str, tuple[str, str]] = {
    "flac": ("song.flac", "audio/flac"),
    "mp3": ("song.mp3", "audio/mpeg"),
    "wav": ("song.wav", "audio/wav"),
    "waveform": ("waveform.json", "application/json"),
    "log": ("generation.log", "text/plain; charset=utf-8"),
    "metadata": ("metadata.json", "application/json"),
    "command": ("runner-command.txt", "text/plain; charset=utf-8"),
    # Symbolic and provenance artifacts the runner produced for this version.
    "score": ("score.abc", "text/plain; charset=utf-8"),
    "request": ("request.json", "application/json"),
    "result": ("result.json", "application/json"),
    "config": ("config.json", "application/json"),
    "plan": ("plan.json", "application/json"),
}

# Artifact keys a runner may hand back for copying into the version directory.
COPYABLE_ARTIFACTS = ("request", "result", "config", "plan")

WAVEFORM_BUCKETS = 800


@dataclass(frozen=True, slots=True)
class VersionPaths:
    """Absolute paths for one version's files."""
    root: Path

    @property
    def flac(self) -> Path: return self.root / "song.flac"
    @property
    def mp3(self) -> Path: return self.root / "song.mp3"
    @property
    def wav(self) -> Path: return self.root / "song.wav"
    @property
    def waveform(self) -> Path: return self.root / "waveform.json"
    @property
    def log(self) -> Path: return self.root / "generation.log"
    @property
    def command(self) -> Path: return self.root / "runner-command.txt"
    @property
    def metadata(self) -> Path: return self.root / "metadata.json"
    @property
    def score(self) -> Path: return self.root / "score.abc"

    def for_key(self, key: str) -> Path:
        """Path for an allowlisted download key. Never accepts a raw filename."""
        filename, _media_type = DOWNLOADABLE[key]
        return self.root / filename


def projects_root() -> Path:
    root = get_config().projects_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def project_dir(project_id: str, *, create: bool = False) -> Path:
    """Resolve a project directory, refusing anything outside the projects root."""
    path = safe_join(projects_root(), project_id)
    if create:
        path.mkdir(parents=True, exist_ok=True)
        (path / "versions").mkdir(exist_ok=True)
    return path


def version_paths(project_id: str, number: int, *, create: bool = False) -> VersionPaths:
    if not isinstance(number, int) or number < 1:
        raise ValueError(f"version number must be a positive integer, got {number!r}")
    root = safe_join(project_dir(project_id), "versions", f"v{number}")
    if create:
        root.mkdir(parents=True, exist_ok=True)
    return VersionPaths(root=root)


# ------------------------------------------------------------------ writing


def write_project_manifest(project_id: str, data: dict[str, Any]) -> Path:
    path = safe_join(project_dir(project_id, create=True), "project.json")
    _write_json(path, data)
    return path


def write_request_inputs(
    project_id: str,
    number: int,
    *,
    lyrics: str,
    style: str,
    request: dict[str, Any],
    score_abc: str | None = None,
) -> None:
    """Persist the exact inputs used for a version, next to the project root."""
    root = project_dir(project_id, create=True)
    safe_join(root, f"lyrics-v{number}.txt").write_text(lyrics or "", encoding="utf-8")
    safe_join(root, f"style-v{number}.txt").write_text(style or "", encoding="utf-8")
    _write_json(safe_join(root, f"request-v{number}.json"), request)
    if score_abc:
        safe_join(root, f"score-v{number}.abc").write_text(score_abc, encoding="utf-8")


def delete_request_inputs(project_id: str, number: int) -> None:
    """Remove the per-version input files written by write_request_inputs.

    They sit at the project root rather than inside versions/v{n}/, so deleting
    the version directory alone left them behind - and still inside export.zip.
    """
    root = project_dir(project_id)
    for name in (
        f"lyrics-v{number}.txt", f"style-v{number}.txt",
        f"request-v{number}.json", f"score-v{number}.abc",
    ):
        target = safe_join(root, name)
        if target.is_file():
            target.unlink()


def append_log(project_id: str, number: int, line: str) -> None:
    paths = version_paths(project_id, number, create=True)
    with paths.log.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line.rstrip("\n") + "\n")


def read_log(project_id: str, number: int, *, max_lines: int = 5000) -> list[str]:
    paths = version_paths(project_id, number)
    if not paths.log.is_file():
        return []
    lines = paths.log.read_text(encoding="utf-8", errors="replace").splitlines()
    return lines[-max_lines:]


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)  # atomic, so a crash never leaves a half-written manifest


# ------------------------------------------------------------------ waveform


def build_waveform(audio_path: Path, out_path: Path, *, buckets: int = WAVEFORM_BUCKETS) -> dict:
    """Compute peak data for the player.

    Reads WAV directly through the stdlib. For FLAC it shells out to FFmpeg if
    present; when neither works it writes an explicitly empty waveform rather
    than inventing one, and the UI falls back to a plain progress bar.
    """
    peaks: list[float] = []
    duration = 0.0
    try:
        if audio_path.suffix.lower() == ".wav":
            peaks, duration = _peaks_from_wav(audio_path, buckets)
        else:
            peaks, duration = _peaks_via_ffmpeg(audio_path, buckets)
    except Exception:
        peaks, duration = [], 0.0

    data = {
        "version": 1,
        "buckets": len(peaks),
        "duration": duration,
        "peaks": peaks,
        "available": bool(peaks),
    }
    _write_json(out_path, data)
    return data


def _peaks_from_wav(path: Path, buckets: int) -> tuple[list[float], float]:
    with wave.open(str(path), "rb") as src:
        channels = src.getnchannels()
        width = src.getsampwidth()
        rate = src.getframerate()
        frames = src.getnframes()
        if width != 2 or frames == 0:
            return [], (frames / rate if rate else 0.0)
        duration = frames / rate
        per_bucket = max(1, frames // buckets)
        peaks: list[float] = []
        remaining = frames
        while remaining > 0:
            count = min(per_bucket, remaining)
            raw = src.readframes(count)
            remaining -= count
            if not raw:
                break
            total = len(raw) // 2
            values = struct.unpack(f"<{total}h", raw[: total * 2])
            if channels > 1:
                # Peak across all channels, matching the FFmpeg path's downmix.
                # Taking channel 0 alone renders silence for a right-only mix.
                frame_peak = max(
                    (max(abs(v) for v in values[i:i + channels])
                     for i in range(0, len(values) - channels + 1, channels)),
                    default=0,
                )
            else:
                frame_peak = max((abs(v) for v in values), default=0)
            peaks.append(round(frame_peak / 32768.0, 4))
        return peaks[:buckets], duration


def _peaks_via_ffmpeg(path: Path, buckets: int) -> tuple[list[float], float]:
    import subprocess

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return [], 0.0
    rate = 8000
    proc = subprocess.run(
        [ffmpeg, "-v", "error", "-i", str(path), "-ac", "1",
         "-ar", str(rate), "-f", "s16le", "-"],
        capture_output=True, check=False,
    )
    if proc.returncode != 0 or not proc.stdout:
        return [], 0.0
    total = len(proc.stdout) // 2
    values = struct.unpack(f"<{total}h", proc.stdout[: total * 2])
    duration = total / rate
    per_bucket = max(1, total // buckets)
    peaks = [
        round(max((abs(v) for v in values[i:i + per_bucket]), default=0) / 32768.0, 4)
        for i in range(0, total, per_bucket)
    ]
    return peaks[:buckets], duration


# ------------------------------------------------------------------ exports


def export_zip(project_id: str, out_path: Path) -> Path:
    """Bundle an entire project directory. Paths inside the archive are relative."""
    root = project_dir(project_id)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(root.rglob("*")):
            if file.is_file():
                archive.write(file, file.relative_to(root).as_posix())
    return out_path


def export_many_zip(projects: list[tuple[str, str]], out_path: Path) -> Path:
    """Bundle several projects, each under its own folder.

    Folder names come from the sanitised slug plus a short id suffix, so two
    songs with the same title cannot overwrite each other inside the archive.
    """
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as archive:
        for project_id, slug in projects:
            root = project_dir(project_id)
            if not root.is_dir():
                continue
            folder = f"{slug}-{project_id[:8]}"
            for file in sorted(root.rglob("*")):
                if file.is_file():
                    archive.write(file, f"{folder}/{file.relative_to(root).as_posix()}")
    return out_path


def delete_project_files(project_id: str) -> bool:
    """Remove a project directory. Only ever called after explicit confirmation."""
    root = project_dir(project_id)
    if not root.is_dir():
        return False
    shutil.rmtree(root)
    return True
