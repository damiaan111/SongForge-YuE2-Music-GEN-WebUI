"""Shared enumerations for job lifecycle and project state."""
from __future__ import annotations

from enum import StrEnum


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"

    @property
    def is_terminal(self) -> bool:
        return self in _TERMINAL_JOB


_TERMINAL_JOB = frozenset(
    {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED, JobStatus.INTERRUPTED}
)


class JobStage(StrEnum):
    """Pipeline stages. A runner only reports the stages it actually supports."""
    QUEUED = "queued"
    LOADING_MODEL = "loading_model"
    PLANNING = "planning"
    GENERATING = "generating"
    DECODING = "decoding"
    EXPORTING = "exporting"
    COMPLETED = "completed"


class ProjectStatus(StrEnum):
    DRAFT = "draft"
    QUEUED = "queued"
    GENERATING = "generating"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    ARCHIVED = "archived"


class CotMode(StrEnum):
    """Symbolic planning mode, mapped to the yue2 CLI ``--cot`` flag."""
    FULL = "full"
    MELODY = "melody"
    OFF = "off"


class SeedMode(StrEnum):
    RANDOM = "random"
    LOCKED = "locked"
    MANUAL = "manual"


class RunnerKind(StrEnum):
    MOCK = "mock"
    YUE2_CLI = "yue2_cli"
