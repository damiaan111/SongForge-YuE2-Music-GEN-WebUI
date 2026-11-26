"""Lyrics writer endpoints: status, streamed generation, unload."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import Field
from sqlmodel import Session, func, select

from ..db import get_session
from ..enums import JobStatus
from ..lyrics import (
    LyricsBusy,
    LyricsPhase,
    LyricsRequest,
    LyricsResult,
    LyricsUnavailable,
    get_writer,
)
from ..models import Job
from ..schemas import _Base
from .deps import get_queue, get_settings_row
from .jobs import SSE_HEADERS

router = APIRouter(prefix="/lyrics", tags=["lyrics"])
log = logging.getLogger("songforge.lyrics")

# Loading the model can be silent for anything up to two minutes: the first
# load after a download or a reboot, a hard disk, a machine short on memory.
# Whatever sits between the browser and this process - the web app's own
# proxy drops a connection after 30 quiet seconds - reads that silence as a
# dead server and hangs up, which Ollama answers by abandoning the load. The
# next attempt then starts from nothing and fails the same way, forever.
#
# So nothing that waits on the model is ever silent for long, and nothing that
# loads it is tied to the life of one HTTP request.
KEEP_ALIVE_SECONDS = 10.0
_background: set[asyncio.Task] = set()


async def with_keep_alive(frames: AsyncIterator[str],
                          interval: float = KEEP_ALIVE_SECONDS) -> AsyncIterator[str]:
    """Pass frames through, and send an SSE comment whenever they stop coming.

    A comment frame (a line starting with a colon) is ignored by every SSE
    reader, including the one in the web app, and counts as traffic to
    everything in between.
    """
    queue: asyncio.Queue = asyncio.Queue()
    finished = object()

    async def pump() -> None:
        try:
            async for frame in frames:
                await queue.put(frame)
        finally:
            await queue.put(finished)

    task = asyncio.create_task(pump())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=interval)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
                continue
            if item is finished:
                break
            yield item
    finally:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


class LyricsGenerateRequest(_Base):
    idea: Annotated[str, Field(max_length=2_000)] = ""
    language: Annotated[str, Field(max_length=40)] = "English"
    # YuE2's default audio token ceiling is about six minutes; allow a little
    # more for users who raise it.
    minutes: Annotated[float, Field(ge=0.5, le=8.0)] = 3.0
    style_hint: Annotated[str, Field(max_length=1_000)] = ""
    mood: Annotated[str, Field(max_length=200)] = ""
    existing_lyrics: Annotated[str, Field(max_length=40_000)] = ""
    instruction: Annotated[str, Field(max_length=1_000)] = ""


class LyricsStatus(_Base):
    enabled: bool
    ollama_running: bool
    ollama_version: str | None = None
    model: str
    model_installed: bool
    installed_models: list[str] = Field(default_factory=list)
    loaded: bool
    loaded_vram_bytes: int = 0
    gpu_busy: bool
    writing: bool
    # The model is being read into the GPU right now. A write requested during
    # it waits for it rather than failing.
    loading: bool = False


def _gpu_busy(session: Session) -> bool:
    if get_queue().active_job_id:
        return True
    queued = session.exec(
        select(func.count()).select_from(Job).where(Job.status == JobStatus.QUEUED)
    ).one()
    return queued > 0


@router.get("/status", response_model=LyricsStatus, summary="Is the local lyrics model ready?")
async def lyrics_status(session: Session = Depends(get_session)) -> LyricsStatus:
    settings = get_settings_row(session)
    info = await get_writer().status(settings.lyrics_model, gpu_busy=_gpu_busy(session))
    return LyricsStatus(enabled=settings.lyrics_enabled, **info)


@router.post("/generate", summary="Write lyrics with the local model (Server-Sent Events)")
async def generate_lyrics(
    payload: LyricsGenerateRequest, session: Session = Depends(get_session)
) -> StreamingResponse:
    """Streams ``token`` events while writing, then one ``done`` or ``error`` event.

    Refused up front (409) while YuE2 is rendering or queued, so the browser
    gets an ordinary error instead of a stream that fails immediately.
    """
    settings = get_settings_row(session)
    if not settings.lyrics_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, "The lyrics writer is turned off in Settings.")
    if not payload.idea.strip() and not payload.existing_lyrics.strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Describe what the song is about, or give lyrics to revise.",
        )
    writer = get_writer()
    busy = _gpu_busy(session)
    # `writing`, not `busy`: a model that is still warming up is loading for
    # this very request, and write() waits for it.
    if busy or writer.writing:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "YuE2 is rendering a song, and the lyrics model cannot share the GPU with it. "
            "Lyrics can be written as soon as the queue is empty."
            if busy else "Lyrics are already being written. Wait for them to finish.",
        )
    model = settings.lyrics_model
    request = LyricsRequest(**payload.model_dump())

    async def frames():
        try:
            async for item in writer.write(request, model, gpu_busy=False):
                if isinstance(item, LyricsResult):
                    yield _frame("done", item.__dict__)
                elif isinstance(item, LyricsPhase):
                    yield _frame("status", {"phase": item.phase, "message": item.message})
                else:
                    yield _frame("token", {"text": item})
        except LyricsBusy as exc:
            yield _frame("error", {"message": str(exc), "busy": True})
        except LyricsUnavailable as exc:
            yield _frame("error", {"message": str(exc)})
        except Exception as exc:  # noqa: BLE001 - reported to the user, never a silent hang
            yield _frame("error", {"message": f"Lyrics writing failed: {type(exc).__name__}: {exc}"})

    return StreamingResponse(
        with_keep_alive(frames()), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/warmup", summary="Load the lyrics model ahead of the first request")
async def warm_up_lyrics_model(session: Session = Depends(get_session)) -> dict:
    """Best-effort: the Lyrics panel calls this when it opens, so the ~17 s
    load happens while the user is still typing their idea."""
    settings = get_settings_row(session)
    if not settings.lyrics_enabled:
        return {"loaded": False, "loading": False, "reason": "disabled"}
    writer = get_writer()
    if writer.busy:
        return {"loaded": False, "loading": writer.warming}
    if _gpu_busy(session):
        return {"loaded": False, "loading": False,
                "reason": "YuE2 is using the GPU; the lyrics model will load when it is free."}
    model = settings.lyrics_model

    async def load() -> None:
        try:
            seconds = await writer.warm_up(model, gpu_busy=False)
            log.info("lyrics model %s warmed up in %.1fs", model, seconds)
        except (LyricsUnavailable, LyricsBusy) as exc:
            log.info("lyrics warm-up skipped: %s", exc)
        except Exception:  # noqa: BLE001 - best-effort; never takes the app down
            log.exception("lyrics warm-up failed")

    # In the background, and answered at once: the load must not depend on
    # this request staying open. The panel polls /status to see it finish.
    task = asyncio.create_task(load())
    _background.add(task)
    task.add_done_callback(_background.discard)
    return {"loaded": False, "loading": True}


@router.post("/unload", summary="Free the GPU from the lyrics model now")
async def unload_lyrics_model() -> dict:
    freed = await get_writer().unload_all()
    return {"unloaded": freed}


def _frame(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
