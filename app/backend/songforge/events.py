"""In-process pub/sub for job progress, consumed by the SSE endpoint.

Each subscriber gets its own bounded queue. A slow client is dropped from the
broadcast rather than being allowed to stall the queue worker.
"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any

# Bounded so one stalled browser tab cannot grow memory without limit.
SUBSCRIBER_BUFFER = 256

# How many jobs keep a replayable tail. Bounded so a long-running process
# cannot accumulate history for every job it has ever seen.
MAX_TRACKED_JOBS = 200


@dataclass(slots=True)
class JobEvent:
    job_id: str
    type: str
    status: str | None = None
    stage: str | None = None
    progress: float | None = None
    message: str = ""
    log_line: str | None = None
    queue_position: int | None = None
    project_id: str | None = None
    version_number: int | None = None
    error: str | None = None
    exit_code: int | None = None
    at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_sse(self) -> str:
        payload = {k: v for k, v in asdict(self).items() if v is not None}
        return f"event: {self.type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


class EventBroker:
    """Fan-out of job events to any number of SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[int, tuple[str | None, asyncio.Queue[JobEvent | None]]] = {}
        self._next_id = 0
        self._lock = asyncio.Lock()
        # Replayed to a late subscriber so a reconnecting browser is not blank.
        self._recent: dict[str, list[JobEvent]] = {}

    async def subscribe(self, job_id: str | None = None) -> tuple[int, asyncio.Queue]:
        async with self._lock:
            token = self._next_id
            self._next_id += 1
            queue: asyncio.Queue[JobEvent | None] = asyncio.Queue(maxsize=SUBSCRIBER_BUFFER)
            self._subscribers[token] = (job_id, queue)
        if job_id:
            for event in self._recent.get(job_id, []):
                with_nowait(queue, event)
        return token, queue

    async def unsubscribe(self, token: int) -> None:
        async with self._lock:
            entry = self._subscribers.pop(token, None)
        if entry is not None:
            with_nowait(entry[1], None)

    def publish(self, event: JobEvent) -> None:
        """Non-blocking broadcast. Safe to call from the worker's event loop."""
        # Only replayable frames are retained, and only for a bounded number of
        # recent jobs: full logs live on disk, not in memory.
        if event.type in {"status", "stage", "completed", "failed", "cancelled"}:
            history = self._recent.setdefault(event.job_id, [])
            history.append(event)
            del history[:-50]
            while len(self._recent) > MAX_TRACKED_JOBS:
                # dicts preserve insertion order, so this drops the oldest job.
                self._recent.pop(next(iter(self._recent)))

        for job_id, queue in list(self._subscribers.values()):
            if job_id is not None and job_id != event.job_id:
                continue
            with_nowait(queue, event)

    def forget(self, job_id: str) -> None:
        self._recent.pop(job_id, None)

    async def stream(self, token: int, queue: asyncio.Queue) -> AsyncIterator[str]:
        """Yield SSE frames until the subscriber is closed or the client leaves."""
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    # Comment frame doubles as a keep-alive through proxies.
                    yield ": keep-alive\n\n"
                    continue
                if event is None:
                    break
                yield event.to_sse()
        finally:
            await self.unsubscribe(token)


def with_nowait(queue: asyncio.Queue, item: Any) -> None:
    """Enqueue without blocking; drop the oldest item if the client is behind."""
    try:
        queue.put_nowait(item)
    except asyncio.QueueFull:
        try:
            queue.get_nowait()
            queue.put_nowait(item)
        except (asyncio.QueueEmpty, asyncio.QueueFull):
            pass


broker = EventBroker()
