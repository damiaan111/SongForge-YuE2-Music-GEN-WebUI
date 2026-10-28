"""SQLModel tables.

Generated audio is immutable: a completed :class:`Version` is never rewritten.
Edits accumulate on :class:`Project` as draft fields until a new version is made.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Column, Index, UniqueConstraint
from sqlalchemy.types import JSON, Text
from sqlmodel import Field, SQLModel

from .enums import JobStage, JobStatus, ProjectStatus, RunnerKind


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


class Project(SQLModel, table=True):
    __tablename__ = "projects"

    id: str = Field(default_factory=new_uuid, primary_key=True)
    slug: str = Field(default="untitled", index=True)
    title: str = Field(default="Untitled", index=True)

    # --- draft fields: edited freely, consumed when a version is generated ---
    style_prompt: str = Field(default="", sa_column=Column(Text))
    lyrics: str = Field(default="", sa_column=Column(Text))
    score_abc: str | None = Field(default=None, sa_column=Column(Text))
    notes: str = Field(default="", sa_column=Column(Text))

    instrumental: bool = False
    language: str | None = None
    vocal_preference: str | None = None
    tags: list[str] = Field(default_factory=list, sa_column=Column(JSON))

    # Last-used generation settings, replayed as defaults for the next version.
    settings: dict = Field(default_factory=dict, sa_column=Column(JSON))

    status: ProjectStatus = Field(default=ProjectStatus.DRAFT, index=True)
    primary_version: int | None = None
    favourite: bool = Field(default=False, index=True)
    archived: bool = Field(default=False, index=True)
    play_count: int = 0
    last_played_at: datetime | None = None

    created_at: datetime = Field(default_factory=utcnow, index=True)
    updated_at: datetime = Field(default_factory=utcnow, index=True)


class Version(SQLModel, table=True):
    """An immutable generated result. Only ``is_primary`` may change after completion."""
    __tablename__ = "versions"
    __table_args__ = (
        UniqueConstraint("project_id", "number", name="uq_version_project_number"),
        Index("ix_version_project", "project_id"),
    )

    id: str = Field(default_factory=new_uuid, primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    number: int

    title: str = ""
    style_prompt: str = Field(default="", sa_column=Column(Text))
    lyrics: str = Field(default="", sa_column=Column(Text))
    score_abc: str | None = Field(default=None, sa_column=Column(Text))

    request: dict = Field(default_factory=dict, sa_column=Column(JSON))
    runner_kind: RunnerKind = RunnerKind.MOCK
    runner_command: str = Field(default="", sa_column=Column(Text))

    duration_seconds: float | None = None
    sample_rate: int | None = None
    seed: int | None = None
    has_flac: bool = False
    has_mp3: bool = False
    has_wav: bool = False
    has_waveform: bool = False

    # The runner's own report on the run: truncation, reproducibility identity,
    # weight checksums and per-stage timing. Shape varies by runner, so it is
    # stored as JSON rather than flattened into columns.
    result: dict = Field(default_factory=dict, sa_column=Column(JSON))

    # A plan-only version has a score and no audio; it is a staging point for
    # editing before committing GPU time to synthesis.
    is_plan_only: bool = False

    # Takes queued by one Generate press with candidates > 1 share this id, so
    # they can be compared as a set. None for a single take.
    candidate_group: str | None = Field(default=None, index=True)

    is_primary: bool = False
    created_at: datetime = Field(default_factory=utcnow, index=True)


class Job(SQLModel, table=True):
    """Queue entry. Persisted so a restart can mark in-flight work interrupted."""
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_job_status_created", "status", "created_at"),)

    id: str = Field(default_factory=new_uuid, primary_key=True)
    project_id: str = Field(foreign_key="projects.id", index=True)
    version_number: int

    status: JobStatus = Field(default=JobStatus.QUEUED, index=True)
    stage: JobStage = Field(default=JobStage.QUEUED)
    progress: float = 0.0
    message: str = ""
    error: str | None = Field(default=None, sa_column=Column(Text))
    exit_code: int | None = None

    runner_kind: RunnerKind = RunnerKind.MOCK
    request: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Set when this job is a retry, so the UI can show provenance.
    retry_of: str | None = None

    created_at: datetime = Field(default_factory=utcnow, index=True)
    started_at: datetime | None = None
    finished_at: datetime | None = None


class AppSettings(SQLModel, table=True):
    """Single-row table (id == 1) holding runtime-editable preferences."""
    __tablename__ = "app_settings"

    id: int = Field(default=1, primary_key=True)

    runner_kind: RunnerKind = RunnerKind.MOCK
    python_executable: str = ""
    yue2_executable: str = ""
    model_path: str = ""
    vae_path: str = ""
    gpu_index: int = 0
    # A neutral default for a 12 GB card. Setup overwrites it from the
    # hardware profile on first start; see hardware_profile.py.
    memory_budget_gib: float = 11.0
    offload_ar: bool = True
    backend_mode: str = "torch-eager"
    quantization: str = "none"
    offline_mode: bool = True
    command_template: str = Field(default="", sa_column=Column(Text))
    # Long songs need it on this hardware; see runners/yue2_launch.py.
    memory_efficient_attention: bool = True
    # Local lyrics writer (Ollama). Entirely optional: when Ollama is absent
    # the app says so and you write your own lyrics. The model is loaded only
    # while writing and unloaded before any YuE2 render, because on most
    # cards the two do not fit at once.
    lyrics_enabled: bool = True
    lyrics_model: str = "gemma4:12b"

    default_cot: str = "full"
    default_cfg_scale: float = 1.0
    export_mp3: bool = True
    export_wav: bool = False
    mp3_bitrate: int = 320
    theme: str = "dark"
    default_style_prompt: str = Field(default="", sa_column=Column(Text))
    default_language: str = "en"

    wizard_completed: bool = False
    updated_at: datetime = Field(default_factory=utcnow)
