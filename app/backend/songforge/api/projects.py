"""Project, version, draft and generation endpoints."""
from __future__ import annotations

import random
import uuid
import shutil
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Response, status
from sqlalchemy import or_
from sqlmodel import Session, func, select

from .. import storage
from ..db import get_session
from ..enums import CotMode, JobStatus, ProjectStatus, SeedMode
from ..events import JobEvent, broker
from ..models import Job, Project, Version, utcnow
from ..paths import slugify
from ..runners.registry import build_runner
from ..versioning import create_version_and_job
from ..schemas import (
    MAX_VERSION_NUMBER,
    DraftUpdate,
    GenerateRequest,
    JobOut,
    ProjectCreate,
    ProjectDetail,
    ProjectListResponse,
    ProjectOut,
    ProjectUpdate,
    QuickGenerateRequest,
    ScoreUpdate,
    VersionOut,
)
from .deps import (
    get_queue,
    get_settings_row,
    job_out,
    project_out,
    require_project,
    version_out,
    version_statuses,
)

router = APIRouter(prefix="/projects", tags=["projects"])

SortKey = Literal["newest", "oldest", "alphabetical", "duration", "most_played"]


# ------------------------------------------------------------------- listing


@router.get("", response_model=ProjectListResponse, summary="List and search projects")
def list_projects(
    session: Session = Depends(get_session),
    search: str = Query("", max_length=200),
    status_filter: ProjectStatus | None = Query(None, alias="status"),
    tag: str | None = Query(None, max_length=40),
    language: str | None = Query(None, max_length=40),
    vocal: str | None = Query(None, max_length=80, description="Substring of the vocal preference"),
    favourite: bool | None = None,
    archived: bool = False,
    sort: SortKey = "newest",
    limit: int = Query(60, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> ProjectListResponse:
    statement = select(Project)

    # Archived projects are hidden unless explicitly requested.
    statement = statement.where(Project.archived == archived)
    if status_filter is not None:
        statement = statement.where(Project.status == status_filter)
    if favourite is not None:
        statement = statement.where(Project.favourite == favourite)
    if language:
        statement = statement.where(Project.language == language)
    if vocal and vocal.strip():
        statement = statement.where(Project.vocal_preference.ilike(f"%{vocal.strip()}%"))
    if search.strip():
        like = f"%{search.strip()}%"
        statement = statement.where(
            or_(
                Project.title.ilike(like),
                Project.style_prompt.ilike(like),
                Project.lyrics.ilike(like),
            )
        )

    rows = session.exec(statement).all()
    # Tags are JSON, so filter in Python rather than relying on SQLite JSON ops.
    if tag:
        rows = [p for p in rows if tag in (p.tags or [])]

    total = len(rows)
    rows = _sort_projects(session, rows, sort)[offset: offset + limit]
    return ProjectListResponse(
        items=[project_out(session, p) for p in rows],
        total=total, limit=limit, offset=offset,
    )


def _sort_projects(session: Session, rows: list[Project], sort: SortKey) -> list[Project]:
    if sort == "alphabetical":
        return sorted(rows, key=lambda p: p.title.casefold())
    if sort == "oldest":
        return sorted(rows, key=lambda p: p.created_at)
    if sort == "most_played":
        return sorted(rows, key=lambda p: (p.play_count, p.updated_at), reverse=True)
    if sort == "duration":
        durations = _primary_durations(session, [p.id for p in rows])
        return sorted(rows, key=lambda p: durations.get(p.id) or 0.0, reverse=True)
    return sorted(rows, key=lambda p: p.created_at, reverse=True)


def _primary_durations(session: Session, ids: list[str]) -> dict[str, float | None]:
    if not ids:
        return {}
    # The primary version's length - what the card shows - not the newest
    # version's, which may be a failed attempt with no audio at all.
    rows = session.exec(
        select(Version.project_id, Version.duration_seconds)
        .join(Project, Project.id == Version.project_id)
        .where(Version.project_id.in_(ids), Version.number == Project.primary_version)
    ).all()
    return {project_id: duration for project_id, duration in rows}


# -------------------------------------------------------------------- CRUD


@router.post("", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED,
             summary="Create a project")
def create_project(
    payload: ProjectCreate, session: Session = Depends(get_session)
) -> ProjectDetail:
    project = Project(
        title=payload.title,
        slug=slugify(payload.title),
        style_prompt=payload.style_prompt,
        lyrics=payload.lyrics,
        instrumental=payload.instrumental,
        language=payload.language,
        vocal_preference=payload.vocal_preference,
        tags=payload.tags,
        notes=payload.notes,
        status=ProjectStatus.DRAFT,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    storage.project_dir(project.id, create=True)
    _write_manifest(session, project)
    return _detail(session, project)


@router.get("/{project_id}", response_model=ProjectDetail, summary="Read one project")
def read_project(project_id: str, session: Session = Depends(get_session)) -> ProjectDetail:
    return _detail(session, require_project(session, project_id))


@router.put("/{project_id}", response_model=ProjectDetail, summary="Update a project")
def update_project(
    project_id: str, payload: ProjectUpdate, session: Session = Depends(get_session)
) -> ProjectDetail:
    project = require_project(session, project_id)
    fields = payload.model_dump(exclude_unset=True)

    if "primary_version" in fields:
        target = fields.pop("primary_version")
        if target is not None:
            _set_primary(session, project, target)
        else:
            # Clearing the pointer must clear the flag as well. Leaving a row
            # with is_primary=True and no project pointer makes that version
            # permanently undeletable - delete_version refuses the primary, and
            # with one version there is nothing else to promote.
            _clear_primary(session, project)

    for field, value in fields.items():
        setattr(project, field, value)
    if "title" in fields:
        project.slug = slugify(project.title)
    if project.archived and project.status is not ProjectStatus.ARCHIVED:
        project.status = ProjectStatus.ARCHIVED
    project.updated_at = utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    _write_manifest(session, project)
    return _detail(session, project)


@router.put("/{project_id}/draft", response_model=ProjectDetail,
            summary="Autosave draft edits")
def update_draft(
    project_id: str, payload: DraftUpdate, session: Session = Depends(get_session)
) -> ProjectDetail:
    """Draft edits never alter an existing version - only the project row."""
    project = require_project(session, project_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(project, field, value)
    project.updated_at = utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    return _detail(session, project)


@router.put("/{project_id}/score", response_model=ProjectDetail, summary="Update the draft score")
def update_score(
    project_id: str, payload: ScoreUpdate, session: Session = Depends(get_session)
) -> ProjectDetail:
    project = require_project(session, project_id)
    project.score_abc = payload.score_abc
    project.updated_at = utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    return _detail(session, project)


@router.post("/{project_id}/duplicate", response_model=ProjectDetail,
             status_code=status.HTTP_201_CREATED, summary="Duplicate a project's settings")
def duplicate_project(
    project_id: str, session: Session = Depends(get_session)
) -> ProjectDetail:
    """Copies editable content only. Generated audio is not duplicated."""
    source = require_project(session, project_id)
    clone = Project(
        title=f"{source.title} (copy)",
        slug=slugify(f"{source.title}-copy"),
        style_prompt=source.style_prompt,
        lyrics=source.lyrics,
        score_abc=source.score_abc,
        notes=source.notes,
        instrumental=source.instrumental,
        language=source.language,
        vocal_preference=source.vocal_preference,
        tags=list(source.tags or []),
        settings=dict(source.settings or {}),
        status=ProjectStatus.DRAFT,
    )
    session.add(clone)
    session.commit()
    session.refresh(clone)
    storage.project_dir(clone.id, create=True)
    _write_manifest(session, clone)
    return _detail(session, clone)


@router.post("/{project_id}/archive", response_model=ProjectDetail, summary="Archive or restore")
def archive_project(
    project_id: str, archived: bool = True, session: Session = Depends(get_session)
) -> ProjectDetail:
    project = require_project(session, project_id)
    project.archived = archived
    if archived:
        project.status = ProjectStatus.ARCHIVED
    else:
        # Restore to what the project actually is, not to "draft": a project
        # archived while failed comes back failed.
        project.status = _status_for(session, project)
    project.updated_at = utcnow()
    session.add(project)
    session.commit()
    session.refresh(project)
    return _detail(session, project)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT,
               summary="Permanently delete a project and its files")
def delete_project(
    project_id: str,
    confirm: bool = Query(False, description="Must be true; deletion is irreversible."),
    session: Session = Depends(get_session),
) -> Response:
    project = require_project(session, project_id)
    if not confirm:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Deletion is permanent. Repeat the request with confirm=true.",
        )
    active = session.exec(
        select(Job).where(
            Job.project_id == project_id,
            Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
    ).first()
    if active is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This project has a job in the queue. Cancel it before deleting.",
        )

    for version in session.exec(
        select(Version).where(Version.project_id == project_id)
    ).all():
        session.delete(version)
    for job in session.exec(select(Job).where(Job.project_id == project_id)).all():
        session.delete(job)
    session.delete(project)
    session.commit()
    storage.delete_project_files(project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------- versions


@router.get("/{project_id}/versions", response_model=list[VersionOut],
            summary="List versions")
def list_versions(
    project_id: str, session: Session = Depends(get_session)
) -> list[VersionOut]:
    require_project(session, project_id)
    rows = session.exec(
        select(Version).where(Version.project_id == project_id).order_by(Version.number)
    ).all()
    statuses = version_statuses(session, project_id)
    return [version_out(v, statuses.get(v.number)) for v in rows]


@router.delete("/{project_id}/versions/{number}", status_code=status.HTTP_204_NO_CONTENT,
               summary="Permanently delete one version")
def delete_version(
    project_id: str,
    number: int = Path(..., ge=1, le=MAX_VERSION_NUMBER),
    confirm: bool = Query(False, description="Must be true; deletion is irreversible."),
    session: Session = Depends(get_session),
) -> Response:
    """Remove a single take. The primary version is protected."""
    project = require_project(session, project_id)
    if not confirm:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "Deletion is permanent. Repeat the request with confirm=true.",
        )
    version = session.exec(
        select(Version).where(Version.project_id == project_id, Version.number == number)
    ).first()
    if version is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Version {number} does not exist.")
    if version.is_primary or project.primary_version == number:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This is the primary version. Make another version primary first.",
        )
    active = session.exec(
        select(Job).where(
            Job.project_id == project_id,
            Job.version_number == number,
            Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
    ).first()
    if active is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "This version is still generating. Cancel it before deleting.",
        )

    session.delete(version)
    session.commit()

    # Remove the version directory, leaving the rest of the project untouched.
    paths = storage.version_paths(project_id, number)
    if paths.root.is_dir():
        shutil.rmtree(paths.root, ignore_errors=True)
    storage.delete_request_inputs(project_id, number)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{project_id}/versions", response_model=JobOut,
             status_code=status.HTTP_202_ACCEPTED,
             summary="Generate a new version from the current draft")
def create_version(
    project_id: str,
    payload: GenerateRequest | None = None,
    session: Session = Depends(get_session),
) -> JobOut:
    return _enqueue(session, require_project(session, project_id),
                    payload or GenerateRequest())


@router.post("/{project_id}/generate", response_model=JobOut,
             status_code=status.HTTP_202_ACCEPTED,
             summary="Queue a generation for this project")
def generate(
    project_id: str,
    payload: GenerateRequest | None = None,
    session: Session = Depends(get_session),
) -> JobOut:
    return _enqueue(session, require_project(session, project_id),
                    payload or GenerateRequest())


@router.post("/quick", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED,
             summary="Create a project and queue it in one step")
def quick_generate(
    payload: QuickGenerateRequest, session: Session = Depends(get_session)
) -> JobOut:
    title = payload.title or _title_from_prompt(payload.prompt)
    project = Project(
        title=title,
        slug=slugify(title),
        style_prompt=payload.prompt,
        lyrics=payload.lyrics,
        instrumental=payload.instrumental,
        tags=payload.tags,
        status=ProjectStatus.DRAFT,
    )
    session.add(project)
    session.commit()
    session.refresh(project)
    storage.project_dir(project.id, create=True)
    try:
        return _enqueue(session, project, GenerateRequest(instrumental=payload.instrumental))
    except HTTPException:
        # Quick mode creates the project and enqueues in one call, so a refused
        # request must not leave an untitled empty project behind. The rollback
        # is explicit: _enqueue may already have staged rows on this session.
        session.rollback()
        session.delete(session.get(Project, project.id))
        session.commit()
        storage.delete_project_files(project.id)
        raise


# ----------------------------------------------------------------- helpers


def _enqueue(session: Session, project: Project, payload: GenerateRequest) -> JobOut:
    settings = get_settings_row(session)
    runner = build_runner(settings)
    caps = runner.capabilities

    # Apply the payload over the project's current draft.
    title = payload.title if payload.title is not None else project.title
    style = payload.style_prompt if payload.style_prompt is not None else project.style_prompt
    lyrics = payload.lyrics if payload.lyrics is not None else project.lyrics
    score = payload.score_abc if payload.score_abc is not None else project.score_abc
    instrumental = (
        payload.instrumental if payload.instrumental is not None else project.instrumental
    )

    if not style.strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "A style prompt is required before generating.",
        )
    if not instrumental and caps.supports_lyrics and not lyrics.strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Add lyrics, or turn on the instrumental option.",
        )

    # Reject options the active runner cannot honour rather than ignoring them.
    if payload.cfg_scale is not None and not caps.supports_cfg_scale:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{caps.display_name} does not support CFG scale.",
        )
    if score and not caps.supports_score_abc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{caps.display_name} does not accept a score.",
        )
    if instrumental and not caps.supports_instrumental:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{caps.display_name} has no instrumental mode. "
            "Generate with lyrics, or switch runner in Settings.",
        )
    # yue2/protocol.py raises "External ABC requires nonempty text and
    # cot=melody/full". Catch it here rather than after the model has loaded.
    if score and (payload.cot or CotMode(settings.default_cot)) is CotMode.OFF:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "A score cannot be used with planning turned off. "
            "Choose melody or full planning, or remove the score.",
        )

    issues_fn = getattr(runner, "template_issues", None)
    issues = issues_fn() if callable(issues_fn) else []
    if issues:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "The runner is not configured: " + "; ".join(issues),
        )

    if payload.stage == "plan" and not caps.supports_plan_stage:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{caps.display_name} cannot plan without rendering audio.",
        )

    extra: dict = {}
    if payload.abc_sampling is not None and payload.abc_sampling.overrides():
        extra["abc_sampling"] = payload.abc_sampling.overrides()
    if payload.semantic_sampling is not None and payload.semantic_sampling.overrides():
        extra["semantic_sampling"] = payload.semantic_sampling.overrides()
    if payload.ode_steps is not None:
        extra["ode_steps"] = payload.ode_steps
    if extra and not caps.supports_sampling_overrides:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{caps.display_name} cannot apply sampling or synthesis-step overrides "
            "with the current command template. Reset the template in Settings, "
            "or leave the advanced sampling controls at their defaults.",
        )

    seed = _resolve_seed(payload, project)
    cot = payload.cot or CotMode(settings.default_cot)
    if payload.stage == "plan" and cot is CotMode.OFF:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Planning produces no score when planning is turned off. "
            "Choose melody or full planning.",
        )

    request_data = {
        "title": title,
        "style_prompt": style,
        "lyrics": lyrics,
        "score_abc": score,
        "instrumental": instrumental,
        "language": payload.language if payload.language is not None else project.language,
        "vocal_preference": (
            payload.vocal_preference if payload.vocal_preference is not None
            else project.vocal_preference
        ),
        "cot": str(cot if caps.supports_planning else CotMode.OFF),
        "stage": payload.stage,
        "seed": seed,
        "cfg_scale": _resolved_cfg_scale(payload, settings, caps),
        "export_mp3": (
            payload.export_mp3 if payload.export_mp3 is not None else settings.export_mp3
        ),
        "export_wav": (
            payload.export_wav if payload.export_wav is not None else settings.export_wav
        ),
        "mp3_bitrate": settings.mp3_bitrate,
        "extra": extra,
    }

    group = uuid.uuid4().hex if payload.candidates > 1 else None
    jobs: list[Job] = []
    for index in range(payload.candidates):
        # Candidate 1 honours the chosen seed mode; the others must differ, or
        # every take in the set would be the same song.
        take_seed = seed if index == 0 else random.randrange(2**31)
        take_request = {**request_data, "seed": take_seed}
        _version, job = create_version_and_job(
            session,
            project=project,
            request_data=take_request,
            runner_kind=caps.kind,
            title=title,
            style_prompt=style,
            lyrics=lyrics,
            score_abc=score,
            seed=take_seed,
            project_settings={
                "cot": request_data["cot"],
                "cfg_scale": request_data["cfg_scale"],
                "seed": seed,
                "export_mp3": request_data["export_mp3"],
                "export_wav": request_data["export_wav"],
            },
            candidate_group=group,
        )
        storage.write_request_inputs(
            project.id, job.version_number,
            lyrics=lyrics, style=style, request=take_request, score_abc=score,
        )
        storage.version_paths(project.id, job.version_number, create=True)
        jobs.append(job)

    queue = get_queue()
    queue.notify()
    outs = [job_out(session, job, queue=queue) for job in jobs]
    for out in outs:
        broker.publish(JobEvent(
            job_id=out.id, type="queue", status=str(out.status),
            queue_position=out.queue_position, project_id=project.id,
            version_number=out.version_number, message=out.message,
        ))
    result = outs[0]
    result.sibling_job_ids = [out.id for out in outs[1:]]
    return result


def _native_cfg_scale(cot: CotMode | str) -> float:
    """yue2's own guidance default, which differs by planning mode.

    ``SongRequest.guidance`` in yue2/protocol.py uses 1.01 without planning and
    1.0 with it. The two are not interchangeable: 1.0 disables guidance, while
    anything else runs a second CFG branch and roughly doubles generation time.
    """
    return 1.01 if str(cot) == str(CotMode.OFF) else 1.0


def _resolved_cfg_scale(payload, settings, caps) -> float | None:
    """The guidance value to send, or None to let yue2 use its own default.

    A value the user typed is always honoured, including an explicit 1.0. The
    app-wide default is different: it ships as 1.0, which is simply yue2's own
    default restated, so it expresses no preference. Sending it regardless
    forced 1.0 onto ``cot=off`` runs, where yue2 would have used 1.01 and where
    1.0 means something else entirely - guidance off. So an unchanged default
    sends nothing and each mode keeps its native value; a default the user has
    actually changed is a real preference and is passed on.
    """
    if payload.cfg_scale is not None:
        return payload.cfg_scale
    if not caps.supports_cfg_scale:
        return None
    default = settings.default_cfg_scale
    if default is None or default == _native_cfg_scale(CotMode.FULL):
        return None
    return default


def _resolve_seed(payload: GenerateRequest, project: Project) -> int:
    if payload.seed_mode is SeedMode.MANUAL:
        if payload.seed is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Manual seed mode requires a seed value.",
            )
        return payload.seed
    if payload.seed_mode is SeedMode.LOCKED:
        previous = (project.settings or {}).get("seed")
        if isinstance(previous, int):
            return previous
        if payload.seed is not None:
            return payload.seed
    return payload.seed if payload.seed is not None else random.randrange(2**31)



def _clear_primary(session: Session, project: Project) -> None:
    """Drop the primary pointer and the flag together."""
    for version in session.exec(
        select(Version).where(Version.project_id == project.id, Version.is_primary)
    ).all():
        version.is_primary = False
        session.add(version)
    project.primary_version = None


def _status_for(session: Session, project: Project) -> ProjectStatus:
    """The status an unarchived project should show, from what it actually has."""
    active = session.exec(
        select(Job).where(
            Job.project_id == project.id,
            Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
    ).first()
    if active is not None:
        return (
            ProjectStatus.QUEUED if active.status is JobStatus.QUEUED
            else ProjectStatus.GENERATING
        )
    if project.primary_version is not None:
        return ProjectStatus.COMPLETED
    last = session.exec(
        select(Job)
        .where(Job.project_id == project.id)
        .order_by(Job.created_at.desc())
    ).first()
    if last is not None and last.status in (JobStatus.FAILED, JobStatus.INTERRUPTED):
        return ProjectStatus.FAILED
    if last is not None and last.status is JobStatus.CANCELLED:
        return ProjectStatus.CANCELLED
    return ProjectStatus.DRAFT


def _set_primary(session: Session, project: Project, number: int) -> None:
    target = session.exec(
        select(Version).where(Version.project_id == project.id, Version.number == number)
    ).first()
    if target is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Version {number} does not exist.")
    for version in session.exec(
        select(Version).where(Version.project_id == project.id)
    ).all():
        version.is_primary = version.number == number
        session.add(version)
    project.primary_version = number


def _title_from_prompt(prompt: str) -> str:
    words = " ".join(prompt.split())[:60].strip()
    return words or "Untitled"


def _write_manifest(session: Session, project: Project) -> None:
    storage.write_project_manifest(project.id, {
        "id": project.id,
        "title": project.title,
        "slug": project.slug,
        "tags": project.tags,
        "language": project.language,
        "created_at": project.created_at.isoformat(),
        "updated_at": project.updated_at.isoformat(),
    })


def _detail(session: Session, project: Project) -> ProjectDetail:
    versions = session.exec(
        select(Version).where(Version.project_id == project.id).order_by(Version.number)
    ).all()
    base = project_out(session, project)
    statuses = version_statuses(session, project.id)
    return ProjectDetail(
        **base.model_dump(),
        versions=[version_out(v, statuses.get(v.number)) for v in versions],
    )
