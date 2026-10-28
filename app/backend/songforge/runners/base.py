"""Runner abstraction.

A runner turns a :class:`GenerationRequest` into audio files on disk, emitting
progress events as it goes. Implementations must:

* never use ``shell=True`` - build an argument list;
* honour cancellation promptly;
* report only the stages they genuinely observe.
"""
from __future__ import annotations

import abc
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..enums import CotMode, JobStage, RunnerKind


@dataclass(frozen=True, slots=True)
class RunnerCapabilities:
    """What a runner actually supports.

    The UI reads this to decide which controls to show. A control backed by no
    capability is hidden rather than shown-and-ignored.
    """
    kind: RunnerKind
    display_name: str
    supports_lyrics: bool = True
    supports_instrumental: bool = False
    supports_score_abc: bool = False
    supports_planning: bool = False
    supports_seed: bool = True
    supports_cfg_scale: bool = False
    supports_duration_target: bool = False
    supports_cancel: bool = True
    supports_progress_percent: bool = True
    # Can plan a score without rendering audio, so the user can edit the score
    # before committing GPU time to synthesis.
    supports_plan_stage: bool = False
    # Per-request sampling (score and audio stages) and synthesis-step
    # overrides. yue2 only accepts these through --request/--config JSON files.
    supports_sampling_overrides: bool = False
    emits_score: bool = False
    stages: tuple[JobStage, ...] = (JobStage.GENERATING, JobStage.COMPLETED)
    notes: str = ""


@dataclass(slots=True)
class GenerationRequest:
    """Everything a runner needs for one generation. Serialised to request.json."""
    project_id: str
    version_number: int
    title: str = ""
    style_prompt: str = ""
    lyrics: str = ""
    score_abc: str | None = None
    instrumental: bool = False
    language: str | None = None
    vocal_preference: str | None = None
    cot: CotMode = CotMode.FULL
    # "plan" stops after the symbolic score; "audio" renders the full song.
    stage: str = "audio"
    seed: int | None = None
    cfg_scale: float | None = None
    export_mp3: bool = False
    export_wav: bool = False
    mp3_bitrate: int = 320
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "project_id": self.project_id,
            "version_number": self.version_number,
            "title": self.title,
            "style_prompt": self.style_prompt,
            "lyrics": self.lyrics,
            "score_abc": self.score_abc,
            "instrumental": self.instrumental,
            "language": self.language,
            "vocal_preference": self.vocal_preference,
            "cot": str(self.cot),
            "stage": self.stage,
            "seed": self.seed,
            "cfg_scale": self.cfg_scale,
            "export_mp3": self.export_mp3,
            "export_wav": self.export_wav,
            "mp3_bitrate": self.mp3_bitrate,
            "extra": self.extra,
        }


@dataclass(slots=True)
class RunnerEvent:
    """One progress update. ``progress`` is 0..1 or None when unknown."""
    stage: JobStage
    message: str = ""
    progress: float | None = None
    log_line: str | None = None
    at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass(slots=True)
class RunnerResult:
    """Outcome of a completed run. Paths are absolute and already on disk."""
    flac_path: Path | None = None
    score_abc: str | None = None
    duration_seconds: float | None = None
    sample_rate: int | None = None
    seed: int | None = None
    exit_code: int = 0
    command: str = ""
    # Everything the runner learned about the run itself. Kept as plain dicts so
    # a runner can report what it has without the schema constraining it.
    truncated: dict | None = None   # e.g. {"abc": false, "semantic": true}
    identity: str | None = None     # reproducibility hash of request+config+weights
    weights: dict | None = None     # model and VAE checksums
    timing: dict | None = None      # per-stage seconds, tokens/s, backend used
    # Extra files to copy into the version directory, keyed by download key.
    artifacts: dict = field(default_factory=dict)
    # True when the run produced a score but deliberately no audio.
    plan_only: bool = False


class RunnerError(RuntimeError):
    """Generation failed. ``exit_code`` is the process code where applicable."""

    def __init__(self, message: str, *, exit_code: int | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code


class RunnerCancelled(RunnerError):
    """Raised when a run was cancelled cooperatively."""

    def __init__(self, message: str = "Generation cancelled.") -> None:
        super().__init__(message, exit_code=None)


@dataclass(frozen=True, slots=True)
class DiagnosticResult:
    """Outcome of a safe, non-generating probe of the runner configuration."""
    ok: bool
    summary: str
    command: str = ""
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    checks: list[dict] = field(default_factory=list)


class BaseRunner(abc.ABC):
    """Typed interface every runner implements."""

    @property
    @abc.abstractmethod
    def capabilities(self) -> RunnerCapabilities: ...

    @abc.abstractmethod
    def build_command(self, request: GenerationRequest, output_dir: Path) -> list[str]:
        """Return the argv list that would be executed. Used for command preview."""

    @abc.abstractmethod
    async def diagnose(self) -> DiagnosticResult:
        """Safely verify configuration without generating audio."""

    @abc.abstractmethod
    def generate(
        self, request: GenerationRequest, output_dir: Path
    ) -> AsyncIterator[RunnerEvent | RunnerResult]:
        """Run generation, yielding events and finally exactly one RunnerResult.

        Implemented as an async generator. Cancellation arrives as
        ``asyncio.CancelledError`` at a yield point; clean up and re-raise.
        """
