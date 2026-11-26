"""Atomic allocation of the next version number and its queued job.

Reading the highest version number and inserting the new row are separate
statements, so two concurrent Generate requests can pick the same number. The
unique constraint on ``(project_id, number)`` catches that; this module turns
the resulting IntegrityError into a retry instead of a 500.
"""
from __future__ import annotations

import logging

from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, func, select

from .enums import JobStatus, ProjectStatus, RunnerKind
from .models import Job, Project, Version, utcnow

log = logging.getLogger("songforge.versioning")

MAX_ATTEMPTS = 6


def next_version_number(session: Session, project_id: str) -> int:
    """Highest number reserved by any version or job, plus one.

    Jobs are consulted too: a queued job has reserved its number before its
    Version row is visible to another request.
    """
    highest_version = session.exec(
        select(func.max(Version.number)).where(Version.project_id == project_id)
    ).one()
    highest_job = session.exec(
        select(func.max(Job.version_number)).where(Job.project_id == project_id)
    ).one()
    return max(highest_version or 0, highest_job or 0) + 1


def create_version_and_job(
    session: Session,
    *,
    project: Project,
    request_data: dict,
    runner_kind: RunnerKind,
    title: str,
    style_prompt: str,
    lyrics: str,
    score_abc: str | None,
    seed: int | None,
    project_settings: dict | None = None,
    retry_of: str | None = None,
    candidate_group: str | None = None,
) -> tuple[Version, Job]:
    """Reserve the next version number and queue a job for it.

    Retries on a unique-constraint collision so two clients pressing Generate at
    the same moment both succeed, on consecutive version numbers.
    """
    for attempt in range(MAX_ATTEMPTS):
        number = next_version_number(session, project.id)
        version = Version(
            project_id=project.id,
            number=number,
            title=title,
            style_prompt=style_prompt,
            lyrics=lyrics,
            score_abc=score_abc,
            request=request_data,
            runner_kind=runner_kind,
            seed=seed,
            candidate_group=candidate_group,
        )
        job = Job(
            project_id=project.id,
            version_number=number,
            request=request_data,
            runner_kind=runner_kind,
            status=JobStatus.QUEUED,
            message="Waiting in the queue.",
            retry_of=retry_of,
        )
        # Project mutations belong inside the loop: a rollback undoes them too.
        # Archived stays archived: the pairing archived=True with any other
        # status is unreachable through every list filter.
        if not project.archived:
            project.status = ProjectStatus.QUEUED
        if project_settings is not None:
            project.settings = project_settings
        project.updated_at = utcnow()

        session.add_all([version, job, project])
        try:
            session.commit()
        except IntegrityError:
            session.rollback()
            log.info(
                "version %s for project %s was taken; retrying (attempt %s)",
                number, project.id, attempt + 1,
            )
            continue
        session.refresh(job)
        session.refresh(version)
        return version, job

    raise HTTPException(
        status.HTTP_409_CONFLICT,
        "Could not reserve a version number; another request kept taking it. "
        "Try again in a moment.",
    )
