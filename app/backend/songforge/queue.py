"""Single-slot generation queue.

One job runs at a time. Jobs are persisted, so a restart can mark anything that
was in flight as interrupted while keeping its logs and partial output.

Cancellation is cooperative: the task is cancelled at an await point, the runner
terminates its process group, and the job is recorded as cancelled.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from sqlmodel import Session, select

from . import lyrics, storage
from .db import get_engine
from .enums import JobStage, JobStatus, ProjectStatus, RunnerKind
from .events import JobEvent, broker
from .models import Job, Project, Version, utcnow
from .runners.base import (
    BaseRunner,
    GenerationRequest,
    RunnerCancelled,
    RunnerError,
    RunnerEvent,
    RunnerResult,
)

log = logging.getLogger("songforge.queue")


class GenerationQueue:
    """Owns the worker task and the single active job."""

    def __init__(self, runner_factory) -> None:
        # runner_factory() -> BaseRunner, re-read per job so settings changes apply.
        self._runner_factory = runner_factory
        self._wake = asyncio.Event()
        self._worker: asyncio.Task | None = None
        self._active_job_id: str | None = None
        self._active_task: asyncio.Task | None = None
        self._stopping = False

    # ----------------------------------------------------------- lifecycle

    async def start(self) -> None:
        if self._worker is None or self._worker.done():
            self._stopping = False
            self._worker = asyncio.create_task(self._run_forever(), name="songforge-queue")
        self._wake.set()

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        if self._active_task is not None and not self._active_task.done():
            self._active_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._active_task
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None

    # -------------------------------------------------------------- public

    @property
    def active_job_id(self) -> str | None:
        return self._active_job_id

    def notify(self) -> None:
        """Signal the worker that the queue may have new work."""
        self._wake.set()

    def queue_position(self, session: Session, job_id: str) -> int | None:
        """1-based position among queued jobs; 0 when running; None if terminal."""
        job = session.get(Job, job_id)
        if job is None or job.status.is_terminal:
            return None
        if job.status is JobStatus.RUNNING:
            return 0
        ahead = session.exec(
            select(Job).where(
                Job.status == JobStatus.QUEUED,
                Job.created_at < job.created_at,
            )
        ).all()
        return len(ahead) + 1

    async def cancel(self, job_id: str) -> bool:
        """Cancel a queued or running job. Returns False if it was already done."""
        with Session(get_engine()) as session:
            job = session.get(Job, job_id)
            if job is None or job.status.is_terminal:
                return False
            if job.status is JobStatus.QUEUED:
                message = "Cancelled before it started."
                project_id, number = job.project_id, job.version_number
                self._finish(session, job, JobStatus.CANCELLED, message=message)
                # The project must follow the job, exactly as it does when a
                # running job is cancelled via _conclude.
                project = session.get(Project, project_id)
                if project is not None and not _has_other_active_job(
                    session, project_id, job_id
                ):
                    project.status = (
                        ProjectStatus.COMPLETED if project.primary_version is not None
                        else ProjectStatus.CANCELLED
                    )
                    project.updated_at = utcnow()
                    session.add(project)
                session.commit()
                broker.publish(JobEvent(job_id=job_id, type="cancelled",
                                        status=str(JobStatus.CANCELLED),
                                        message=message, project_id=project_id,
                                        version_number=number))
                self._republish_positions()
                return True

        if self._active_job_id == job_id and self._active_task is not None:
            self._active_task.cancel()
            return True
        return False

    # -------------------------------------------------------------- worker

    async def _run_forever(self) -> None:
        while not self._stopping:
            job_id = self._claim_next()
            if job_id is None:
                self._wake.clear()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), timeout=30.0)
                continue

            self._active_job_id = job_id
            self._active_task = asyncio.create_task(self._execute(job_id))
            try:
                await self._active_task
            except asyncio.CancelledError:
                # Cancellation of the job task, not of the worker itself.
                if self._stopping:
                    raise
            except Exception:
                log.exception("queue worker: job %s failed unexpectedly", job_id)
            finally:
                self._active_job_id = None
                self._active_task = None
                self._republish_positions()

    def _claim_next(self) -> str | None:
        with Session(get_engine()) as session:
            job = session.exec(
                select(Job)
                .where(Job.status == JobStatus.QUEUED)
                .order_by(Job.created_at)
            ).first()
            if job is None:
                return None
            job.status = JobStatus.RUNNING
            job.started_at = utcnow()
            job.stage = JobStage.LOADING_MODEL
            job.message = "Starting"
            session.add(job)
            project = session.get(Project, job.project_id)
            if project is not None:
                if not project.archived:
                    project.status = ProjectStatus.GENERATING
                project.updated_at = utcnow()
                session.add(project)
            session.commit()
            return job.id

    async def _execute(self, job_id: str) -> None:
        with Session(get_engine()) as session:
            job = session.get(Job, job_id)
            if job is None:
                return
            request = _request_from_job(job)
            project_id, number = job.project_id, job.version_number

        runner: BaseRunner = self._runner_factory()
        paths = storage.version_paths(project_id, number, create=True)
        if runner.capabilities.kind is RunnerKind.YUE2_CLI:
            # YuE2 needs nearly the whole card; the local lyrics model
            # must be out of GPU memory before the render loads.
            await lyrics.ensure_unloaded()
        storage.append_log(project_id, number,
                           f"=== job {job_id} started {datetime.now(timezone.utc).isoformat()} ===")

        broker.publish(JobEvent(job_id=job_id, type="status", status=str(JobStatus.RUNNING),
                                stage=str(JobStage.LOADING_MODEL), project_id=project_id,
                                version_number=number, queue_position=0))

        result: RunnerResult | None = None
        try:
            async for item in runner.generate(request, paths.root):
                if isinstance(item, RunnerResult):
                    result = item
                    continue
                self._handle_event(job_id, project_id, number, item, runner)
            if result is None:
                raise RunnerError("Runner finished without producing a result.")
            # Once the runner has produced audio, the expensive work is done.
            # Finalising converts, writes the waveform and commits the Version
            # row, and takes seconds - long enough for a Cancel to land on a
            # panel that already says "completed". Throwing the render away then
            # would file a finished song as an empty cancelled version while its
            # FLAC sits on disk, so the cancel is refused instead, and said so.
            finalising = asyncio.create_task(
                self._finalise(job_id, project_id, number, request, result, runner)
            )
            try:
                await asyncio.shield(finalising)
            except asyncio.CancelledError:
                current = asyncio.current_task()
                if current is not None:
                    current.uncancel()
                await finalising
                storage.append_log(
                    project_id, number,
                    "=== cancel arrived after the audio was rendered; the version was kept ===",
                )

        except asyncio.CancelledError:
            # Shutdown cancels the same task a user cancel does, so the two must
            # be told apart here. Recording a shutdown as "cancelled" would
            # blame the user and would hide the job from _mark_interrupted.
            if self._stopping:
                self._conclude(
                    job_id, JobStatus.INTERRUPTED,
                    "Backend stopped while this job was running.", None,
                )
                storage.append_log(project_id, number, "=== interrupted by shutdown ===")
            else:
                self._conclude(job_id, JobStatus.CANCELLED, "Cancelled.", None)
                storage.append_log(project_id, number, "=== cancelled by user ===")
            raise
        except RunnerCancelled as exc:
            self._conclude(job_id, JobStatus.CANCELLED, str(exc), None)
            storage.append_log(project_id, number, f"=== cancelled: {exc} ===")
        except RunnerError as exc:
            self._conclude(job_id, JobStatus.FAILED, str(exc), exc.exit_code)
            storage.append_log(project_id, number, f"=== failed: {exc} ===")
        except Exception as exc:  # noqa: BLE001 - surfaced to the user, never swallowed
            log.exception("job %s failed", job_id)
            self._conclude(job_id, JobStatus.FAILED, f"{type(exc).__name__}: {exc}", None)
            storage.append_log(project_id, number, f"=== failed: {type(exc).__name__}: {exc} ===")

    def _handle_event(
        self, job_id: str, project_id: str, number: int,
        event: RunnerEvent, runner: BaseRunner,
    ) -> None:
        if event.log_line:
            storage.append_log(project_id, number, event.log_line)

        # Only report a percentage when the runner genuinely produces one.
        progress = event.progress if runner.capabilities.supports_progress_percent else None

        with Session(get_engine()) as session:
            job = session.get(Job, job_id)
            if job is not None:
                job.stage = event.stage
                job.message = event.message[:500]
                if progress is not None:
                    job.progress = max(0.0, min(1.0, progress))
                session.add(job)
                session.commit()

        broker.publish(JobEvent(
            job_id=job_id, type="stage", status=str(JobStatus.RUNNING),
            stage=str(event.stage), progress=progress, message=event.message[:500],
            log_line=event.log_line, project_id=project_id, version_number=number,
        ))

    # ------------------------------------------------------------ finalise

    async def _finalise(
        self, job_id: str, project_id: str, number: int,
        request: GenerationRequest, result: RunnerResult, runner: BaseRunner,
    ) -> None:
        paths = storage.version_paths(project_id, number, create=True)
        source = result.flac_path
        if result.plan_only:
            await self._finalise_plan(job_id, project_id, number, request, result, runner)
            return
        if source is None or not source.is_file():
            raise RunnerError("Runner reported success but no audio file exists.")

        # Preserve the runner's own output losslessly; transcode only for exports.
        # Without FFmpeg a non-FLAC runner output is kept under its own
        # extension, so `primary` is not necessarily paths.flac.
        primary = await asyncio.to_thread(_ensure_flac, source, paths.flac)
        mp3 = wav = False
        if request.export_mp3:
            mp3 = await asyncio.to_thread(_transcode, primary, paths.mp3,
                                          ["-b:a", f"{request.mp3_bitrate}k"])
        if request.export_wav and primary != paths.wav:
            wav = await asyncio.to_thread(_transcode, primary, paths.wav, [])

        waveform = await asyncio.to_thread(storage.build_waveform, primary, paths.waveform)
        paths.command.write_text(result.command or "", encoding="utf-8")

        # The score belongs with the version, not only at the project root.
        if result.score_abc:
            paths.score.write_text(result.score_abc, encoding="utf-8")
        # Copy the runner's own artifacts in under their allowlisted names, so
        # the Files tab can offer them without exposing the runner's layout.
        for key, source in (result.artifacts or {}).items():
            if key not in storage.COPYABLE_ARTIFACTS:
                continue
            try:
                source_path = Path(source)
                if source_path.is_file():
                    shutil.copy2(source_path, paths.for_key(key))
            except OSError as exc:
                log.warning("could not copy %s artifact: %s", key, exc)

        duration = result.duration_seconds or waveform.get("duration") or None
        metadata = {
            "project_id": project_id,
            "version": number,
            "title": request.title,
            "runner": str(runner.capabilities.kind),
            "runner_name": runner.capabilities.display_name,
            "seed": result.seed,
            "duration_seconds": duration,
            "sample_rate": result.sample_rate,
            "exit_code": result.exit_code,
            "truncated": result.truncated,
            "identity": result.identity,
            "weights": result.weights,
            "timing": result.timing,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "request": request.to_dict(),
        }
        storage._write_json(paths.metadata, metadata)
        storage.write_request_inputs(
            project_id, number,
            lyrics=request.lyrics, style=request.style_prompt,
            request=request.to_dict(), score_abc=result.score_abc,
        )

        with Session(get_engine()) as session:
            job = session.get(Job, job_id)
            version = session.exec(
                select(Version).where(
                    Version.project_id == project_id, Version.number == number
                )
            ).first()
            if version is not None:
                version.score_abc = result.score_abc
                version.duration_seconds = duration
                version.sample_rate = result.sample_rate
                version.seed = result.seed
                version.runner_command = result.command
                version.runner_kind = runner.capabilities.kind
                # Report what is actually on disk under each name, so the UI
                # never offers a download that would 404 or hide one that works.
                version.has_flac = paths.flac.is_file()
                version.has_mp3 = mp3 or paths.mp3.is_file()
                version.has_wav = wav or paths.wav.is_file()
                version.has_waveform = bool(waveform.get("available"))
                version.result = {
                    key: value
                    for key, value in (
                        ("truncated", result.truncated),
                        ("identity", result.identity),
                        ("weights", result.weights),
                        ("timing", result.timing),
                    )
                    if value is not None
                }
                session.add(version)

            project = session.get(Project, project_id)
            if project is not None:
                # An archived project stays archived: the API enforces that
                # pairing, and a project that is archived with some other
                # status is invisible to every list filter.
                if not project.archived:
                    project.status = ProjectStatus.COMPLETED
                project.updated_at = utcnow()
                if project.primary_version is None:
                    project.primary_version = number
                    if version is not None:
                        version.is_primary = True
                        session.add(version)
                session.add(project)

            if job is not None:
                self._finish(session, job, JobStatus.COMPLETED,
                             message="Completed.", exit_code=result.exit_code)
            session.commit()

        storage.append_log(project_id, number, "=== completed ===")
        broker.publish(JobEvent(
            job_id=job_id, type="completed", status=str(JobStatus.COMPLETED),
            stage=str(JobStage.COMPLETED), progress=1.0, message="Completed.",
            project_id=project_id, version_number=number, exit_code=result.exit_code,
        ))

    async def _finalise_plan(
        self, job_id: str, project_id: str, number: int,
        request: GenerationRequest, result: RunnerResult, runner: BaseRunner,
    ) -> None:
        """Complete a plan-only run: a score, deliberately no audio."""
        paths = storage.version_paths(project_id, number, create=True)
        if not result.score_abc:
            raise RunnerError("The planning run produced no score.")

        paths.score.write_text(result.score_abc, encoding="utf-8")
        paths.command.write_text(result.command or "", encoding="utf-8")
        for key, source in (result.artifacts or {}).items():
            if key not in storage.COPYABLE_ARTIFACTS:
                continue
            try:
                source_path = Path(source)
                if source_path.is_file():
                    shutil.copy2(source_path, paths.for_key(key))
            except OSError as exc:
                log.warning("could not copy %s artifact: %s", key, exc)

        storage._write_json(paths.metadata, {
            "project_id": project_id,
            "version": number,
            "title": request.title,
            "stage": "plan",
            "runner": str(runner.capabilities.kind),
            "runner_name": runner.capabilities.display_name,
            "seed": result.seed,
            "exit_code": result.exit_code,
            "identity": result.identity,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "request": request.to_dict(),
        })
        storage.write_request_inputs(
            project_id, number,
            lyrics=request.lyrics, style=request.style_prompt,
            request=request.to_dict(), score_abc=result.score_abc,
        )

        with Session(get_engine()) as session:
            job = session.get(Job, job_id)
            version = session.exec(
                select(Version).where(
                    Version.project_id == project_id, Version.number == number
                )
            ).first()
            if version is not None:
                version.score_abc = result.score_abc
                version.seed = result.seed
                version.runner_command = result.command
                version.runner_kind = runner.capabilities.kind
                version.is_plan_only = True
                # The same receipt the audio path stores, so a plan that hit the
                # score token ceiling is flagged rather than silently short.
                version.result = {
                    key: value
                    for key, value in (
                        ("truncated", result.truncated),
                        ("identity", result.identity),
                        ("weights", result.weights),
                        ("timing", result.timing),
                    )
                    if value is not None
                }
                session.add(version)

            project = session.get(Project, project_id)
            if project is not None:
                # The planned score becomes the draft, ready to edit and render.
                project.score_abc = result.score_abc
                project.status = (
                    ProjectStatus.COMPLETED if project.primary_version is not None
                    else ProjectStatus.DRAFT
                )
                project.updated_at = utcnow()
                session.add(project)

            if job is not None:
                self._finish(session, job, JobStatus.COMPLETED,
                             message="Score ready to review.",
                             exit_code=result.exit_code)
            session.commit()

        storage.append_log(project_id, number, "=== plan completed ===")
        broker.publish(JobEvent(
            job_id=job_id, type="completed", status=str(JobStatus.COMPLETED),
            stage=str(JobStage.COMPLETED), progress=1.0,
            message="Score ready to review.",
            project_id=project_id, version_number=number,
            exit_code=result.exit_code,
        ))

    # ------------------------------------------------------------- helpers

    def _conclude(
        self, job_id: str, status: JobStatus, message: str, exit_code: int | None
    ) -> None:
        with Session(get_engine()) as session:
            job = session.get(Job, job_id)
            if job is None:
                return
            project_id, number = job.project_id, job.version_number
            self._finish(session, job, status, message=message, exit_code=exit_code)
            project = session.get(Project, project_id)
            if project is not None and not _has_other_active_job(
                session, project_id, job_id
            ):
                # A project that already has finished audio is still completed;
                # one failed or cancelled attempt does not undo earlier versions.
                # An archived project keeps its archived status either way.
                if project.archived:
                    project.status = ProjectStatus.ARCHIVED
                elif project.primary_version is not None:
                    project.status = ProjectStatus.COMPLETED
                elif status is JobStatus.FAILED:
                    project.status = ProjectStatus.FAILED
                else:
                    project.status = ProjectStatus.CANCELLED
                project.updated_at = utcnow()
                session.add(project)
            session.commit()

        event_type = "failed" if status is JobStatus.FAILED else "cancelled"
        broker.publish(JobEvent(
            job_id=job_id, type=event_type, status=str(status), message=message,
            error=None if status is JobStatus.CANCELLED else message,
            project_id=project_id, version_number=number, exit_code=exit_code,
        ))

    @staticmethod
    def _finish(
        session: Session, job: Job, status: JobStatus, *,
        message: str, exit_code: int | None = None,
    ) -> None:
        job.status = status
        job.message = message[:500]
        job.finished_at = utcnow()
        job.exit_code = exit_code
        if status is JobStatus.COMPLETED:
            job.stage = JobStage.COMPLETED
            job.progress = 1.0
        elif status is JobStatus.FAILED:
            job.error = message
        session.add(job)

    def _republish_positions(self) -> None:
        """Tell every waiting client where it now sits in the queue."""
        with Session(get_engine()) as session:
            waiting = session.exec(
                select(Job).where(Job.status == JobStatus.QUEUED).order_by(Job.created_at)
            ).all()
            for index, job in enumerate(waiting, start=1):
                broker.publish(JobEvent(
                    job_id=job.id, type="queue", status=str(job.status),
                    queue_position=index, project_id=job.project_id,
                    version_number=job.version_number,
                ))


def _has_other_active_job(session: Session, project_id: str, exclude_job_id: str) -> bool:
    """True when the project still has another queued or running job.

    Prevents one job's outcome from overwriting a project status that a second,
    still-active job legitimately owns.
    """
    other = session.exec(
        select(Job).where(
            Job.project_id == project_id,
            Job.id != exclude_job_id,
            Job.status.in_([JobStatus.QUEUED, JobStatus.RUNNING]),
        )
    ).first()
    return other is not None


def _request_from_job(job: Job) -> GenerationRequest:
    from .enums import CotMode

    data = dict(job.request or {})
    cot = data.get("cot", "full")
    return GenerationRequest(
        project_id=job.project_id,
        version_number=job.version_number,
        title=data.get("title", ""),
        style_prompt=data.get("style_prompt", ""),
        lyrics=data.get("lyrics", ""),
        score_abc=data.get("score_abc"),
        instrumental=bool(data.get("instrumental", False)),
        language=data.get("language"),
        vocal_preference=data.get("vocal_preference"),
        cot=CotMode(cot) if cot in set(CotMode) else CotMode.FULL,
        stage="plan" if data.get("stage") == "plan" else "audio",
        seed=data.get("seed"),
        cfg_scale=data.get("cfg_scale"),
        export_mp3=bool(data.get("export_mp3", False)),
        export_wav=bool(data.get("export_wav", False)),
        mp3_bitrate=int(data.get("mp3_bitrate", 320)),
        extra=data.get("extra", {}),
    )


def _ensure_flac(source: Path, target: Path) -> Path:
    """Place the runner's audio at ``target``.

    If the runner already produced FLAC it is moved as-is. Otherwise FFmpeg
    transcodes it; when FFmpeg is absent the original file is kept under its own
    extension so output never depends on FFmpeg being installed.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    if source.suffix.lower() == ".flac":
        if source.resolve() != target.resolve():
            shutil.move(str(source), str(target))
        return target
    if _transcode(source, target, []):
        source.unlink(missing_ok=True)
        return target
    fallback = target.with_suffix(source.suffix)
    if source.resolve() != fallback.resolve():
        shutil.move(str(source), str(fallback))
    return fallback


def _transcode(source: Path, target: Path, extra_args: list[str]) -> bool:
    """Run FFmpeg. Returns False when FFmpeg is missing or the run fails."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not source.is_file():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [ffmpeg, "-y", "-v", "error", "-i", str(source), *extra_args, str(target)],
        capture_output=True, check=False,
    )
    if proc.returncode != 0:
        log.warning("ffmpeg failed for %s: %s", source.name,
                    proc.stderr.decode("utf-8", "replace")[:500])
        return False
    return target.is_file()
