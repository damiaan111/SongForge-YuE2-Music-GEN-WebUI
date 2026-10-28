"""Shared dependencies and response mappers for the API layer."""
from __future__ import annotations

import shutil
from functools import lru_cache

from fastapi import Depends, HTTPException, status
from sqlmodel import Session, func, select

from ..db import get_session
from ..enums import JobStatus, RunnerKind
from ..models import AppSettings, Job, Project, Version
from ..queue import GenerationQueue
from ..runners.base import RunnerCapabilities
from ..schemas import JobOut, ProjectOut, RunnerCapabilitiesOut, VersionOut

SessionDep = Depends(get_session)

# The queue instance is created in main.py and registered here so routers can
# reach it without importing the app module (which would be circular).
_queue: GenerationQueue | None = None


def set_queue(queue: GenerationQueue) -> None:
    global _queue
    _queue = queue


def get_queue() -> GenerationQueue:
    if _queue is None:  # pragma: no cover - set during app startup
        raise RuntimeError("Generation queue has not been initialised.")
    return _queue


@lru_cache(maxsize=1)
def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def get_settings_row(session: Session) -> AppSettings:
    settings = session.get(AppSettings, 1)
    if settings is None:
        settings = AppSettings(id=1)
        session.add(settings)
        session.commit()
        session.refresh(settings)
    return settings


def require_project(session: Session, project_id: str) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found.")
    return project


def require_job(session: Session, job_id: str) -> Job:
    job = session.get(Job, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found.")
    return job


# ------------------------------------------------------------------ mappers


def capabilities_out(caps: RunnerCapabilities) -> RunnerCapabilitiesOut:
    return RunnerCapabilitiesOut(
        kind=caps.kind,
        display_name=caps.display_name,
        supports_lyrics=caps.supports_lyrics,
        supports_instrumental=caps.supports_instrumental,
        supports_score_abc=caps.supports_score_abc,
        supports_planning=caps.supports_planning,
        supports_seed=caps.supports_seed,
        supports_cfg_scale=caps.supports_cfg_scale,
        supports_duration_target=caps.supports_duration_target,
        supports_cancel=caps.supports_cancel,
        supports_plan_stage=caps.supports_plan_stage,
        supports_sampling_overrides=caps.supports_sampling_overrides,
        supports_progress_percent=caps.supports_progress_percent,
        emits_score=caps.emits_score,
        stages=list(caps.stages),
        notes=caps.notes,
    )


def version_statuses(session: Session, project_id: str) -> dict[int, JobStatus]:
    """Status of the job behind each version number of a project.

    One job produces one version (a retry reserves a new number), so the
    newest job per number is authoritative.
    """
    rows = session.exec(
        select(Job.version_number, Job.status)
        .where(Job.project_id == project_id)
        .order_by(Job.created_at)
    ).all()
    return {number: job_status for number, job_status in rows}


def version_out(version: Version, job_status: JobStatus | None = None) -> VersionOut:
    return VersionOut.model_validate(
        {**version.model_dump(), "status": job_status or JobStatus.COMPLETED}
    )


def project_out(session: Session, project: Project) -> ProjectOut:
    statuses = version_statuses(session, project.id)
    versions = session.exec(
        select(Version.number, Version.duration_seconds).where(
            Version.project_id == project.id
        )
    ).all()
    numbers = [
        number for number, _ in versions
        if statuses.get(number, JobStatus.COMPLETED) is JobStatus.COMPLETED
    ]
    duration = next(
        (length for number, length in versions if number == project.primary_version),
        None,
    )
    active = session.exec(
        select(Job.id).where(
            Job.project_id == project.id,
            Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        ).order_by(Job.created_at.desc())
    ).first()
    return ProjectOut(
        **project.model_dump(),
        version_count=len(numbers),
        latest_version=max(numbers) if numbers else None,
        active_job_id=active,
        duration_seconds=duration,
    )


def job_out(session: Session, job: Job, *, queue: GenerationQueue | None = None) -> JobOut:
    title = session.exec(
        select(Project.title).where(Project.id == job.project_id)
    ).first() or ""
    position = queue.queue_position(session, job.id) if queue is not None else None
    # The capability must describe the runner this job actually used, not
    # whatever Settings happens to name now: changing runners must not
    # retroactively add or remove a progress bar on historical jobs.
    caps = _capabilities_for_kind(session, job.runner_kind)
    return JobOut(
        **job.model_dump(),
        project_title=title,
        queue_position=position,
        supports_progress_percent=caps.supports_progress_percent,
    )


def _capabilities_for_kind(session: Session, kind: RunnerKind) -> RunnerCapabilities:
    """Capabilities of a named runner, configured as Settings currently has it."""
    settings = session.get(AppSettings, 1) or AppSettings(id=1)
    if settings.runner_kind is not kind:
        settings = settings.model_copy(update={"runner_kind": kind})
    from ..runners.registry import build_runner as _build

    return _build(settings).capabilities


def count_projects(session: Session) -> int:
    return session.exec(select(func.count()).select_from(Project)).one()
