"""Health and diagnostics endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import Session, func, select

from ..db import get_session
from ..enums import JobStatus
from ..models import Job, Project
from ..runners.registry import build_runner
from ..schemas import DiagnosticCheck, DiagnosticsResponse, HealthResponse
from ..version import __version__
from .deps import ffmpeg_available, get_queue, get_settings_row

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse, summary="Liveness and readiness")
def health(session: Session = Depends(get_session)) -> HealthResponse:
    settings = get_settings_row(session)
    runner = build_runner(settings)

    ready = True
    issues = getattr(runner, "template_issues", None)
    if callable(issues):
        ready = not issues()

    queued = session.exec(
        select(func.count()).select_from(Job).where(Job.status == JobStatus.QUEUED)
    ).one()
    projects = session.exec(select(func.count()).select_from(Project)).one()

    return HealthResponse(
        version=__version__,
        database=True,
        runner_kind=settings.runner_kind,
        runner_ready=ready,
        ffmpeg=ffmpeg_available(),
        active_job_id=get_queue().active_job_id,
        queued_jobs=queued,
        projects=projects,
    )


@router.post(
    "/diagnostics/runner",
    response_model=DiagnosticsResponse,
    summary="Safely probe the runner without generating audio",
)
async def diagnose_runner(session: Session = Depends(get_session)) -> DiagnosticsResponse:
    settings = get_settings_row(session)
    runner = build_runner(settings)
    result = await runner.diagnose()
    return DiagnosticsResponse(
        ok=result.ok,
        summary=result.summary,
        command=result.command,
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        checks=[DiagnosticCheck(**check) for check in result.checks],
    )
