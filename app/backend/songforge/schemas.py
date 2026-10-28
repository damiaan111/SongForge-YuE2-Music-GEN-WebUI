"""Pydantic request and response models.

Every field a client can send is validated and length-bounded here, so handlers
never see unbounded or untyped input.
"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .enums import CotMode, JobStage, JobStatus, ProjectStatus, RunnerKind, SeedMode

# Bounds chosen to be generous for real songs while still bounded.
MAX_TITLE = 200
MAX_STYLE = 4_000
MAX_LYRICS = 40_000
MAX_SCORE = 200_000
MAX_NOTES = 20_000
MAX_TAGS = 40
# An upper bound on any version number reaching the database. SQLite raises
# OverflowError - not ValueError - for integers that do not fit in 64 bits, and
# that escapes the error handlers as a 500, so every version parameter is
# bounded at the edge rather than at the query.
MAX_VERSION_NUMBER = 1_000_000

Title = Annotated[str, Field(max_length=MAX_TITLE)]
StyleText = Annotated[str, Field(max_length=MAX_STYLE)]
LyricsText = Annotated[str, Field(max_length=MAX_LYRICS)]
ScoreText = Annotated[str, Field(max_length=MAX_SCORE)]


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


# --------------------------------------------------------------------- tags


def _clean_tags(value: list[str] | None) -> list[str]:
    if not value:
        return []
    seen: list[str] = []
    for raw in value[:MAX_TAGS]:
        tag = " ".join(str(raw).split())[:40]
        if tag and tag not in seen:
            seen.append(tag)
    return seen


# ------------------------------------------------------------------ health


class HealthResponse(_Base):
    status: Literal["ok"] = "ok"
    version: str
    database: bool
    runner_kind: RunnerKind
    runner_ready: bool
    ffmpeg: bool
    active_job_id: str | None = None
    queued_jobs: int = 0
    projects: int = 0


# ---------------------------------------------------------------- settings


class RunnerCapabilitiesOut(_Base):
    kind: RunnerKind
    display_name: str
    supports_lyrics: bool
    supports_instrumental: bool
    supports_score_abc: bool
    supports_planning: bool
    supports_seed: bool
    supports_cfg_scale: bool
    supports_duration_target: bool
    supports_cancel: bool
    supports_plan_stage: bool
    supports_sampling_overrides: bool = False
    supports_progress_percent: bool
    emits_score: bool
    stages: list[JobStage]
    notes: str = ""


class HardwareOut(_Base):
    """The accelerator setup found, for display only."""
    vendor: str
    name: str
    memory_gib: float | None = None
    compute: str | None = None
    torch: str = ""
    description: str = ""


class SettingsOut(_Base):
    runner_kind: RunnerKind
    python_executable: str
    yue2_executable: str
    model_path: str
    vae_path: str
    gpu_index: int
    memory_budget_gib: float
    offload_ar: bool
    backend_mode: str
    quantization: str
    offline_mode: bool
    command_template: str
    memory_efficient_attention: bool = True
    lyrics_enabled: bool = True
    lyrics_model: str = "gemma4:12b"
    default_cot: CotMode
    default_cfg_scale: float
    export_mp3: bool
    export_wav: bool
    mp3_bitrate: int
    theme: str
    default_style_prompt: str
    default_language: str
    wizard_completed: bool

    capabilities: RunnerCapabilitiesOut
    command_preview: list[str] = Field(default_factory=list)
    configuration_issues: list[str] = Field(default_factory=list)
    # The shipped template, so Settings can offer "reset" without the client
    # having to keep its own copy of the string in sync.
    default_command_template: str = ""
    # Where the app stores things. Shown in Settings; nothing secret here.
    projects_dir: str = ""
    models_dir: str = ""
    ffmpeg_available: bool = False
    # What setup detected, so the UI can name the card the user actually has
    # instead of the one this was developed on. None when setup never ran.
    hardware: HardwareOut | None = None


class SettingsUpdate(_Base):
    """All fields optional - a PUT patches only what it names."""
    runner_kind: RunnerKind | None = None
    python_executable: Annotated[str, Field(max_length=500)] | None = None
    yue2_executable: Annotated[str, Field(max_length=500)] | None = None
    model_path: Annotated[str, Field(max_length=500)] | None = None
    vae_path: Annotated[str, Field(max_length=500)] | None = None
    gpu_index: Annotated[int, Field(ge=0, le=15)] | None = None
    memory_budget_gib: Annotated[float, Field(gt=0, le=512)] | None = None
    offload_ar: bool | None = None
    backend_mode: Literal["torch", "torch-eager", "vllm"] | None = None
    quantization: Literal["none", "fp8"] | None = None
    offline_mode: bool | None = None
    command_template: Annotated[str, Field(max_length=4_000)] | None = None
    memory_efficient_attention: bool | None = None
    lyrics_enabled: bool | None = None
    # An Ollama model tag, e.g. gemma4:12b. Checked against installed models on use.
    lyrics_model: Annotated[str, Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9._:/-]+$")] | None = None
    default_cot: CotMode | None = None
    default_cfg_scale: Annotated[float, Field(ge=0.0, le=20.0)] | None = None
    export_mp3: bool | None = None
    export_wav: bool | None = None
    mp3_bitrate: Literal[128, 192, 256, 320] | None = None
    theme: Literal["dark", "light", "system"] | None = None
    default_style_prompt: StyleText | None = None
    default_language: Annotated[str, Field(max_length=40)] | None = None
    wizard_completed: bool | None = None


class DiagnosticCheck(_Base):
    name: str
    ok: bool
    detail: str = ""


class DiagnosticsResponse(_Base):
    ok: bool
    summary: str
    command: str = ""
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    checks: list[DiagnosticCheck] = Field(default_factory=list)


# ---------------------------------------------------------------- projects


class ProjectCreate(_Base):
    title: Title = "Untitled"
    style_prompt: StyleText = ""
    lyrics: LyricsText = ""
    instrumental: bool = False
    language: Annotated[str, Field(max_length=40)] | None = None
    vocal_preference: Annotated[str, Field(max_length=80)] | None = None
    tags: list[Annotated[str, Field(max_length=40)]] = Field(
        default_factory=list, max_length=MAX_TAGS
    )
    notes: Annotated[str, Field(max_length=MAX_NOTES)] = ""

    _tags = field_validator("tags")(lambda cls, v: _clean_tags(v))

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        return cleaned or "Untitled"


class ProjectUpdate(_Base):
    title: Title | None = None
    style_prompt: StyleText | None = None
    lyrics: LyricsText | None = None
    score_abc: ScoreText | None = None
    notes: Annotated[str, Field(max_length=MAX_NOTES)] | None = None
    instrumental: bool | None = None
    language: Annotated[str, Field(max_length=40)] | None = None
    vocal_preference: Annotated[str, Field(max_length=80)] | None = None
    tags: Annotated[
        list[Annotated[str, Field(max_length=40)]], Field(max_length=MAX_TAGS)
    ] | None = None
    favourite: bool | None = None
    archived: bool | None = None
    primary_version: Annotated[int, Field(ge=1, le=MAX_VERSION_NUMBER)] | None = None

    _tags = field_validator("tags")(lambda cls, v: _clean_tags(v) if v is not None else None)

    @field_validator("title")
    @classmethod
    def _title_not_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        return cleaned or "Untitled"


class DraftUpdate(_Base):
    """Autosaved draft edits. Never touches a completed version."""
    title: Title | None = None
    style_prompt: StyleText | None = None
    lyrics: LyricsText | None = None
    notes: Annotated[str, Field(max_length=MAX_NOTES)] | None = None


class ScoreUpdate(_Base):
    score_abc: ScoreText


class VersionOut(_Base):
    id: str
    project_id: str
    number: int
    title: str
    style_prompt: str
    lyrics: str
    score_abc: str | None
    request: dict[str, Any] = Field(default_factory=dict)
    runner_kind: RunnerKind
    runner_command: str
    duration_seconds: float | None
    sample_rate: int | None
    seed: int | None
    has_flac: bool
    has_mp3: bool
    has_wav: bool
    has_waveform: bool
    result: dict[str, Any] = Field(default_factory=dict)
    is_plan_only: bool = False
    is_primary: bool
    created_at: datetime
    # The status of the job that produces this version. A version row exists
    # from the moment its job is queued, so without this a failed or cancelled
    # take is indistinguishable from a queued one. "completed" for versions
    # with no job on record.
    status: JobStatus = JobStatus.COMPLETED
    candidate_group: str | None = None


class ProjectOut(_Base):
    id: str
    slug: str
    title: str
    style_prompt: str
    lyrics: str
    score_abc: str | None
    notes: str
    instrumental: bool
    language: str | None
    vocal_preference: str | None
    tags: list[str]
    settings: dict[str, Any]
    status: ProjectStatus
    primary_version: int | None
    favourite: bool
    archived: bool
    play_count: int
    last_played_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # Versions that actually finished (audio or a score). Queued, failed and
    # cancelled attempts are not counted.
    version_count: int = 0
    latest_version: int | None = None
    active_job_id: str | None = None
    # Length of the primary version's audio, for the Library card.
    duration_seconds: float | None = None


class ProjectDetail(ProjectOut):
    versions: list[VersionOut] = Field(default_factory=list)


class ProjectListResponse(_Base):
    items: list[ProjectOut]
    total: int
    limit: int
    offset: int


# -------------------------------------------------------------------- jobs


class SamplingOverride(_Base):
    """Partial override of one yue2 sampling stage.

    Bounds mirror yue2/protocol.py Sampling.__post_init__ exactly, so a value
    the model would refuse after loading is refused here instead. Unset fields
    keep the model's defaults.
    """
    temperature: Annotated[float, Field(ge=0.0, le=5.0)] | None = None
    top_p: Annotated[float, Field(gt=0.0, le=1.0)] | None = None
    top_k: Annotated[int, Field(ge=1, le=100_000)] | None = None
    repetition_penalty: Annotated[float, Field(gt=0.0, le=10.0)] | None = None
    penalty_window: Annotated[int, Field(ge=1, le=100)] | None = None
    min_tokens: Annotated[int, Field(ge=0, le=24_576)] | None = None
    max_tokens: Annotated[int, Field(ge=1, le=24_576)] | None = None

    @model_validator(mode="after")
    def _min_not_above_max(self) -> "SamplingOverride":
        if (
            self.min_tokens is not None and self.max_tokens is not None
            and self.min_tokens > self.max_tokens
        ):
            raise ValueError("min_tokens cannot exceed max_tokens")
        return self

    def overrides(self) -> dict[str, Any]:
        return self.model_dump(exclude_none=True)


class GenerateRequest(_Base):
    """Submit a generation. Unsupported options are rejected, never ignored."""
    title: Title | None = None
    style_prompt: StyleText | None = None
    lyrics: LyricsText | None = None
    score_abc: ScoreText | None = None
    instrumental: bool | None = None
    language: Annotated[str, Field(max_length=40)] | None = None
    vocal_preference: Annotated[str, Field(max_length=80)] | None = None
    cot: CotMode | None = None
    # "plan" stops after the symbolic score so it can be reviewed and edited
    # before audio is rendered; "audio" runs the whole pipeline.
    stage: Literal["plan", "audio"] = "audio"
    seed_mode: SeedMode = SeedMode.RANDOM
    # yue2 accepts a seed in [0, 2**63). Random draws still use 2**31.
    seed: Annotated[int, Field(ge=0, le=2**63 - 1)] | None = None
    # yue2/protocol.py SongRequest allows 0-20; do not narrow it here.
    cfg_scale: Annotated[float, Field(ge=0.0, le=20.0)] | None = None
    export_mp3: bool | None = None
    export_wav: bool | None = None
    # Best-of-N. One yue2 run produces exactly one song, so N candidates are N
    # queued jobs, run one after another. The first honours seed_mode; the rest
    # draw fresh random seeds, since identical seeds would give identical songs.
    candidates: Annotated[int, Field(ge=1, le=8)] = 1
    # Advanced. Only accepted by runners reporting supports_sampling_overrides.
    abc_sampling: SamplingOverride | None = None
    semantic_sampling: SamplingOverride | None = None
    # Flow-matching synthesis steps (yue2 default 32). Roughly linear in the
    # synthesis stage's time.
    ode_steps: Annotated[int, Field(ge=1, le=256)] | None = None



class QuickGenerateRequest(_Base):
    """Quick mode: a description, plus lyrics when the runner needs them.

    YuE2 refuses a request without lyrics (yue2/pipeline.py raises
    "Provide style and lyrics"), so Quick mode carries a lyrics field rather
    than promising a one-box flow the model cannot honour.
    """
    prompt: StyleText
    lyrics: LyricsText = ""
    title: Title | None = None
    instrumental: bool = False
    tags: list[Annotated[str, Field(max_length=40)]] = Field(
        default_factory=list, max_length=MAX_TAGS
    )

    _tags = field_validator("tags")(lambda cls, v: _clean_tags(v))

    @field_validator("prompt")
    @classmethod
    def _prompt_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Describe the song you want before generating.")
        return value


class JobOut(_Base):
    id: str
    project_id: str
    project_title: str = ""
    version_number: int
    status: JobStatus
    stage: JobStage
    progress: float
    message: str
    error: str | None
    exit_code: int | None
    runner_kind: RunnerKind
    request: dict[str, Any] = Field(default_factory=dict)
    retry_of: str | None
    # Other jobs queued by the same Generate press (candidates > 1). Only
    # filled on the response to that press.
    sibling_job_ids: list[str] = Field(default_factory=list)
    queue_position: int | None = None
    supports_progress_percent: bool = True
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class JobListResponse(_Base):
    items: list[JobOut]
    active_job_id: str | None = None


class JobLogResponse(_Base):
    job_id: str
    lines: list[str]
    truncated: bool = False


# ----------------------------------------------------------------- estimate


class EstimateRequest(_Base):
    """A draft to measure against YuE2's length and context ceilings."""
    style_prompt: StyleText = ""
    lyrics: LyricsText = ""
    score_abc: ScoreText = ""
    cot: CotMode = CotMode.FULL
    instrumental: bool = False


class EstimateResponse(_Base):
    """What ``budget.estimate`` found. Advisory: nothing here blocks a render."""
    seconds: float
    max_seconds: float
    music_tokens: int
    music_cap: int
    prompt_tokens: int
    plan_tokens: int
    context_tokens: int
    context_total: int
    verdict: Literal["ok", "tight", "over_length", "over_context"]
    headline: str
    detail: str
    advice: str
