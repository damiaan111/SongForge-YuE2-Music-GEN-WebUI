"""MockRunner - a complete, working simulation of a generation run.

This is not a placeholder: it produces a real, playable audio file, streams
realistic staged progress, writes logs and honours cancellation. It exists so
the whole application can be exercised end to end without a GPU, and so the
queue and UI can be tested deterministically.
"""
from __future__ import annotations

import asyncio
import math
import random
import struct
import wave
from collections.abc import AsyncIterator
from pathlib import Path

from ..enums import CotMode, JobStage, RunnerKind
from .base import (
    BaseRunner,
    DiagnosticResult,
    GenerationRequest,
    RunnerCapabilities,
    RunnerEvent,
    RunnerResult,
)

SAMPLE_RATE = 44_100

# (stage, human label, share of total wall time, progress at end of stage)
_SCRIPT: tuple[tuple[JobStage, str, float, float], ...] = (
    (JobStage.LOADING_MODEL, "Loading mock model weights", 0.12, 0.10),
    (JobStage.PLANNING, "Sketching symbolic plan", 0.18, 0.28),
    (JobStage.GENERATING, "Generating semantic tokens", 0.40, 0.72),
    (JobStage.DECODING, "Decoding latents to audio", 0.22, 0.92),
    (JobStage.EXPORTING, "Writing output files", 0.08, 1.00),
)

# A pentatonic-ish set reads as musical rather than as a test tone.
_SCALE_SEMITONES = (0, 2, 4, 7, 9, 12, 14, 16)


class MockRunner(BaseRunner):
    """Simulates generation. ``duration_seconds`` controls the rendered audio."""

    def __init__(
        self,
        *,
        duration_seconds: float = 12.0,
        total_runtime_seconds: float = 9.0,
        fail: bool = False,
    ) -> None:
        self.duration_seconds = max(1.0, duration_seconds)
        self.total_runtime_seconds = max(0.1, total_runtime_seconds)
        self._fail = fail

    @property
    def capabilities(self) -> RunnerCapabilities:
        return RunnerCapabilities(
            kind=RunnerKind.MOCK,
            display_name="Mock runner (simulation)",
            supports_lyrics=True,
            supports_instrumental=True,
            supports_score_abc=True,
            supports_planning=True,
            supports_seed=True,
            supports_cfg_scale=True,
            supports_duration_target=True,
            supports_cancel=True,
            supports_plan_stage=True,
            supports_progress_percent=True,
            emits_score=True,
            stages=tuple(stage for stage, *_ in _SCRIPT) + (JobStage.COMPLETED,),
            notes=(
                "Simulated output for development and testing. Audio is "
                "synthesised locally and is not a real YuE2 generation."
            ),
        )

    def build_command(self, request: GenerationRequest, output_dir: Path) -> list[str]:
        seed = str(request.seed) if request.seed is not None else "auto"
        return [
            "<mock-runner>",
            "--project", request.project_id,
            "--version", str(request.version_number),
            "--cot", str(request.cot),
            "--stage", request.stage,
            "--seed", seed,
            "--output", str(output_dir),
        ]

    async def diagnose(self) -> DiagnosticResult:
        return DiagnosticResult(
            ok=True,
            summary="Mock runner is always available. No GPU or model required.",
            command="<mock-runner> --self-test",
            exit_code=0,
            stdout="mock runner ready",
            checks=[{"name": "Mock runner", "ok": True, "detail": "built in"}],
        )

    async def generate(
        self, request: GenerationRequest, output_dir: Path
    ) -> AsyncIterator[RunnerEvent | RunnerResult]:
        output_dir.mkdir(parents=True, exist_ok=True)
        seed = request.seed if request.seed is not None else random.randrange(2**31)
        rng = random.Random(seed)
        command = " ".join(self.build_command(request, output_dir))

        yield RunnerEvent(
            stage=JobStage.QUEUED,
            message="Mock run starting",
            progress=0.0,
            log_line=f"$ {command}",
        )

        # A plan-only run stops after the symbolic score; no audio is rendered.
        plan_only = request.stage == "plan"
        script = _SCRIPT[:2] if plan_only else _SCRIPT

        progress_from = 0.0
        for stage, label, time_share, progress_to in script:
            yield RunnerEvent(
                stage=stage, message=label, progress=progress_from,
                log_line=f"[{stage}] {label}",
            )
            steps = 6
            step_delay = (self.total_runtime_seconds * time_share) / steps
            for i in range(1, steps + 1):
                # Cancellation arrives here as CancelledError. Partial files are
                # deliberately left on disk for inspection.
                await asyncio.sleep(step_delay)
                fraction = progress_from + (progress_to - progress_from) * (i / steps)
                yield RunnerEvent(stage=stage, message=label, progress=fraction)
            if self._fail and stage is JobStage.GENERATING:
                raise RuntimeError("Simulated generation failure (MockRunner fail=True)")
            progress_from = progress_to

        score = self._render_score(request, rng) if request.cot is not CotMode.OFF else None

        if plan_only:
            yield RunnerEvent(
                stage=JobStage.COMPLETED, message="Mock plan complete",
                progress=1.0, log_line="[completed] plan only, exit code 0",
            )
            yield RunnerResult(
                flac_path=None, score_abc=score, seed=seed,
                exit_code=0, command=command, plan_only=True,
            )
            return

        audio_path = self._render_audio(output_dir, rng)
        yield RunnerEvent(
            stage=JobStage.COMPLETED, message="Mock generation complete",
            progress=1.0, log_line="[completed] exit code 0",
        )
        yield RunnerResult(
            flac_path=audio_path,
            score_abc=score,
            duration_seconds=self.duration_seconds,
            sample_rate=SAMPLE_RATE,
            seed=seed,
            exit_code=0,
            command=command,
        )

    # ------------------------------------------------------------------ audio

    def _render_audio(self, output_dir: Path, rng: random.Random) -> Path:
        """Synthesise a short stereo phrase.

        Written as WAV through the stdlib so FFmpeg is never required to create
        output. The queue transcodes to FLAC afterwards when FFmpeg is present.
        """
        path = output_dir / "song.wav"
        total_frames = int(SAMPLE_RATE * self.duration_seconds)
        root = rng.choice((220.0, 246.94, 261.63, 293.66))
        beat_frames = int(SAMPLE_RATE * 0.5)
        release_frames = SAMPLE_RATE * 0.5

        with wave.open(str(path), "wb") as out:
            out.setnchannels(2)
            out.setsampwidth(2)
            out.setframerate(SAMPLE_RATE)
            chunk = bytearray()
            note_hz = root
            for frame in range(total_frames):
                if frame % beat_frames == 0:
                    note_hz = root * 2 ** (rng.choice(_SCALE_SEMITONES) / 12)
                t = frame / SAMPLE_RATE
                beat_pos = (frame % beat_frames) / beat_frames
                envelope = math.exp(-3.0 * beat_pos)
                fade = min(1.0, (total_frames - frame) / release_frames)
                tone = (
                    math.sin(2 * math.pi * note_hz * t)
                    + 0.35 * math.sin(2 * math.pi * note_hz * 2 * t)
                    + 0.20 * math.sin(2 * math.pi * root * 0.5 * t)
                )
                value = tone * envelope * fade * 0.22
                left = int(max(-1.0, min(1.0, value)) * 32767)
                right = int(max(-1.0, min(1.0, value * 0.94)) * 32767)
                chunk += struct.pack("<hh", left, right)
                if len(chunk) >= 1 << 18:
                    out.writeframes(bytes(chunk))
                    chunk.clear()
            if chunk:
                out.writeframes(bytes(chunk))
        return path

    def _render_score(self, request: GenerationRequest, rng: random.Random) -> str:
        notes = "CDEFGABc"
        bars = [" ".join(rng.choice(notes) for _ in range(4)) for _ in range(4)]
        title = request.title or "Mock Sketch"
        return (
            "X:1\n"
            f"T:{title}\n"
            "M:4/4\n"
            "L:1/8\n"
            "K:C\n"
            + " | ".join(bars)
            + " |]\n"
        )
