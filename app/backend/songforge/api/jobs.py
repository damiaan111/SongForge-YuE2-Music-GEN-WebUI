"""Queue, job control and Server-Sent Events."""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from .. import storage
from ..db import get_session
from ..enums import JobStatus, ProjectStatus
from ..events import JobEvent, broker
from ..models import Job, Project, Version, utcnow
from ..schemas import JobListResponse, JobLogResponse, JobOut
from ..versioning import create_version_and_job
from .deps import get_queue, job_out, require_job

router = APIRouter(prefix="/jobs", tags=["jobs"])

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # Disables proxy buffering, which would otherwise delay every event.
    "X-Accel-Buffering": "no",
}


@router.get("", response_model=JobListResponse, summary="List jobs")
def list_jobs(
    session: Session = Depends(get_session),
    status_filter: JobStatus | None = Query(None, alias="status"),
    project_id: str | None = None,
    limit: int = Query(50, ge=1, le=200),
) -> JobListResponse:
    statement = select(Job)
    if status_filter is not None:
        statement = statement.where(Job.status == status_filter)
    if project_id:
        statement = statement.where(Job.project_id == project_id)
    rows = session.exec(statement.order_by(Job.created_at.desc()).limit(limit)).all()
    queue = get_queue()
    return JobListResponse(
        items=[job_out(session, job, queue=queue) for job in rows],
        active_job_id=queue.active_job_id,
    )


@router.get("/{job_id}", response_model=JobOut, summary="Read one job")
def read_job(job_id: str, session: Session = Depends(get_session)) -> JobOut:
    return job_out(session, require_job(session, job_id), queue=get_queue())


@router.get("/{job_id}/log", response_model=JobLogResponse, summary="Read the runner log")
def read_job_log(
    job_id: str,
    session: Session = Depends(get_session),
    max_lines: int = Query(2000, ge=1, le=20000),
) -> JobLogResponse:
    job = require_job(session, job_id)
    lines = storage.read_log(job.project_id, job.version_number, max_lines=max_lines + 1)
    truncated = len(lines) > max_lines
    return JobLogResponse(job_id=job_id, lines=lines[-max_lines:], truncated=truncated)


@router.post("/{job_id}/cancel", response_model=JobOut, summary="Cancel a job")
async def cancel_job(job_id: str, session: Session = Depends(get_session)) -> JobOut:
    job = require_job(session, job_id)
    if job.status.is_terminal:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"This job already finished with status '{job.status}'.",
        )
    cancelled = await get_queue().cancel(job_id)
    if not cancelled:
        raise HTTPException(status.HTTP_409_CONFLICT, "The job could not be cancelled.")

    # The running case completes asynchronously; give it a brief moment so the
    # response reflects the settled status rather than a stale one.
    for _ in range(20):
        session.expire_all()
        refreshed = session.get(Job, job_id)
        if refreshed is not None and refreshed.status.is_terminal:
            break
        await asyncio.sleep(0.1)

    session.expire_all()
    return job_out(session, require_job(session, job_id), queue=get_queue())


@router.post("/{job_id}/retry", response_model=JobOut,
             status_code=status.HTTP_202_ACCEPTED,
             summary="Retry a failed job with the same settings")
def retry_job(job_id: str, session: Session = Depends(get_session)) -> JobOut:
    original = require_job(session, job_id)
    if not original.status.is_terminal:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This job is still active; cancel it first."
        )
    if original.status is JobStatus.COMPLETED:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This job completed. Generate a new version instead of retrying.",
        )

    project = session.get(Project, original.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The project no longer exists.")

    # Retry into a fresh version so the failed attempt's logs stay intact.
    request_data = dict(original.request or {})
    _version, job = create_version_and_job(
        session,
        project=project,
        request_data=request_data,
        runner_kind=original.runner_kind,
        title=request_data.get("title", project.title),
        style_prompt=request_data.get("style_prompt", ""),
        lyrics=request_data.get("lyrics", ""),
        score_abc=request_data.get("score_abc"),
        seed=request_data.get("seed"),
        retry_of=original.id,
    )
    number = job.version_number

    storage.write_request_inputs(
        project.id, number,
        lyrics=request_data.get("lyrics", ""),
        style=request_data.get("style_prompt", ""),
        request=request_data,
        score_abc=request_data.get("score_abc"),
    )
    storage.version_paths(project.id, number, create=True)

    queue = get_queue()
    queue.notify()
    result = job_out(session, job, queue=queue)
    broker.publish(JobEvent(
        job_id=job.id, type="queue", status=str(job.status),
        queue_position=result.queue_position, project_id=project.id,
        version_number=number, message=job.message,
    ))
    return result


@router.post("/{job_id}/resume", response_model=JobOut,
             status_code=status.HTTP_202_ACCEPTED,
             summary="Resume an interrupted job whose YuE2 run had already finished")
def resume_job(job_id: str, session: Session = Depends(get_session)) -> JobOut:
    """Re-record a run that yue2 completed but SongForge never finalised.

    Unlike Retry, this reuses the same version and output directory and passes
    --resume, so yue2 re-verifies the saved result against the request, config
    and weight checksums (storage.verify_result) instead of rendering again.
    It returns in seconds, and refuses if anything that affects the output has
    changed since.
    """
    from ..queue import _request_from_job
    from ..runners.registry import current_runner

    original = require_job(session, job_id)
    if original.status not in (JobStatus.INTERRUPTED, JobStatus.FAILED):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Only an interrupted or failed job can be resumed."
        )
    project = session.get(Project, original.project_id)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "The project no longer exists.")
    newer = session.exec(
        select(Job).where(
            Job.project_id == original.project_id,
            Job.version_number == original.version_number,
            Job.created_at > original.created_at,
        )
    ).first()
    if newer is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This version was already resumed.")

    runner = current_runner()
    check = getattr(runner, "can_resume", None)
    request = _request_from_job(original)
    paths = storage.version_paths(original.project_id, original.version_number)
    reason = (
        check(request, paths.root) if callable(check)
        else f"{runner.capabilities.display_name} cannot resume a run."
    )
    if reason:
        raise HTTPException(status.HTTP_409_CONFLICT, reason)

    request_data = dict(original.request or {})
    request_data["extra"] = {**(request_data.get("extra") or {}), "resume": True}
    job = Job(
        project_id=original.project_id,
        version_number=original.version_number,
        request=request_data,
        runner_kind=original.runner_kind,
        status=JobStatus.QUEUED,
        message="Waiting to verify the finished run.",
        retry_of=original.id,
    )
    if not project.archived:
        project.status = ProjectStatus.QUEUED
    project.updated_at = utcnow()
    session.add_all([job, project])
    session.commit()
    session.refresh(job)
    storage.append_log(
        original.project_id, original.version_number,
        f"=== resume requested (from job {original.id}) ===",
    )

    queue = get_queue()
    queue.notify()
    result = job_out(session, job, queue=queue)
    broker.publish(JobEvent(
        job_id=job.id, type="queue", status=str(job.status),
        queue_position=result.queue_position, project_id=project.id,
        version_number=job.version_number, message=job.message,
    ))
    return result


@router.get("/{job_id}/events", summary="Stream job progress as Server-Sent Events")
async def job_events(job_id: str, request: Request) -> StreamingResponse:
    token, queue = await broker.subscribe(job_id)

    async def generator():
        try:
            async for frame in broker.stream(token, queue):
                if await request.is_disconnected():
                    break
                yield frame
        finally:
            await broker.unsubscribe(token)

    return StreamingResponse(
        generator(), media_type="text/event-stream", headers=SSE_HEADERS
    )


@router.get("/stream/all", summary="Stream every job's progress")
async def all_events(request: Request) -> StreamingResponse:
    token, queue = await broker.subscribe(None)

    async def generator():
        try:
            async for frame in broker.stream(token, queue):
                if await request.is_disconnected():
                    break
                yield frame
        finally:
            await broker.unsubscribe(token)

    return StreamingResponse(
        generator(), media_type="text/event-stream", headers=SSE_HEADERS
    )
