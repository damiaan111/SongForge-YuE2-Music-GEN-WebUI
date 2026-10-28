"""File download endpoints.

The client selects a file by an allowlisted key, never by path. Version numbers
are integers and project IDs are resolved through ``storage.safe_join``, so no
request can address anything outside ``runtime/projects``.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlmodel import Session, select

from .. import storage
from ..db import get_session
from ..models import Project, Version, utcnow
from ..paths import PathTraversalError, safe_filename
from ..schemas import MAX_VERSION_NUMBER
from .deps import require_project

router = APIRouter(prefix="/projects", tags=["files"])


def _resolve_version(session: Session, project_id: str, version: int | None) -> int:
    project = require_project(session, project_id)
    if version is not None:
        return version
    if project.primary_version is not None:
        return project.primary_version
    latest = session.exec(
        select(Version.number)
        .where(Version.project_id == project_id)
        .order_by(Version.number.desc())
    ).first()
    if latest is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "This project has no versions yet.")
    return latest


@router.get("/{project_id}/download/{file_key}", summary="Download one file of a version")
def download_file(
    project_id: str,
    file_key: str,
    version: int | None = Query(None, ge=1, le=MAX_VERSION_NUMBER),
    session: Session = Depends(get_session),
) -> FileResponse:
    entry = storage.DOWNLOADABLE.get(file_key)
    if entry is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"Unknown file '{file_key}'. Available: "
            + ", ".join(sorted(storage.DOWNLOADABLE)),
        )
    filename, media_type = entry
    number = _resolve_version(session, project_id, version)

    try:
        paths = storage.version_paths(project_id, number)
    except (PathTraversalError, ValueError) as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    path = paths.root / filename
    if not path.is_file():
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"No {file_key} file exists for version {number}.",
        )

    project = session.get(Project, project_id)
    stem = safe_filename(f"{project.slug if project else 'song'}-v{number}")
    suffix = Path(filename).suffix
    return FileResponse(
        path, media_type=media_type, filename=f"{stem}{suffix}"
    )


def _starts_playback(range_header: str | None) -> bool:
    """True for a plain GET or an open-ended Range request from byte 0.

    Safari probes with "bytes=0-1" before playing; that is excluded. This is
    still an approximation - a browser may fetch "bytes=0-" to read metadata
    without the user pressing play - but it no longer multiplies every play.
    """
    if not range_header:
        return True
    return range_header.replace(" ", "").lower() == "bytes=0-"


@router.get("/{project_id}/stream", summary="Stream a version's audio for playback")
def stream_audio(
    project_id: str,
    request: Request,
    version: int | None = Query(None, ge=1, le=MAX_VERSION_NUMBER),
    session: Session = Depends(get_session),
) -> FileResponse:
    """Serve audio for the player and count the play."""
    number = _resolve_version(session, project_id, version)
    paths = storage.version_paths(project_id, number)

    # Prefer the lossless original; fall back to whatever exists.
    for candidate, media_type in (
        (paths.flac, "audio/flac"),
        (paths.mp3, "audio/mpeg"),
        (paths.wav, "audio/wav"),
        (paths.root / "song.wav", "audio/wav"),
    ):
        if candidate.is_file():
            project = session.get(Project, project_id)
            # An <audio> element issues several Range requests per playback
            # (metadata probe, then the body, then every seek). Only a request
            # for the start of the file is counted, so one play is one play.
            if project is not None and _starts_playback(request.headers.get("range")):
                project.play_count += 1
                project.last_played_at = utcnow()
                session.add(project)
                session.commit()
            return FileResponse(candidate, media_type=media_type)

    raise HTTPException(
        status.HTTP_404_NOT_FOUND, f"Version {number} has no playable audio."
    )


@router.get("/bulk/export.zip", summary="Download several projects as one ZIP")
def export_projects(
    background: BackgroundTasks,
    ids: list[str] = Query(..., min_length=1, max_length=200),
    session: Session = Depends(get_session),
) -> FileResponse:
    """One archive with a folder per project, for the Library's multi-select.

    Declared before /{project_id}/export.zip so "bulk" is never read as an id.
    """
    projects = [require_project(session, project_id) for project_id in dict.fromkeys(ids)]
    handle = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    handle.close()
    target = Path(handle.name)
    try:
        storage.export_many_zip(
            [(project.id, safe_filename(project.slug or "project")) for project in projects],
            target,
        )
    except Exception:
        target.unlink(missing_ok=True)
        raise
    background.add_task(target.unlink, missing_ok=True)
    return FileResponse(
        target,
        media_type="application/zip",
        filename=f"songforge-export-{len(projects)}-songs.zip",
        background=background,
    )


@router.get("/{project_id}/export.zip", summary="Download the whole project as a ZIP")
def export_project(
    project_id: str,
    background: BackgroundTasks,
    session: Session = Depends(get_session),
) -> FileResponse:
    project = require_project(session, project_id)
    # Built in the system temp directory, never inside runtime/projects, and
    # removed once the response has been sent.
    handle = tempfile.NamedTemporaryFile(suffix=".zip", delete=False)
    handle.close()
    target = Path(handle.name)
    try:
        storage.export_zip(project_id, target)
    except Exception:
        target.unlink(missing_ok=True)
        raise

    background.add_task(target.unlink, missing_ok=True)
    return FileResponse(
        target,
        media_type="application/zip",
        filename=f"{safe_filename(project.slug or 'project')}.zip",
        background=background,
    )
