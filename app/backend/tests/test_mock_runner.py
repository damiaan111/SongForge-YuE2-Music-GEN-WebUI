"""MockRunner integration tests.

The MockRunner is a working simulation, so these assert real behaviour: real
audio on disk, ordered stages, and prompt cancellation.
"""
from __future__ import annotations

import asyncio
import wave
from pathlib import Path

import pytest

from songforge.enums import CotMode, JobStage, RunnerKind
from songforge.runners.base import GenerationRequest, RunnerEvent, RunnerResult
from songforge.runners.mock import MockRunner


def make_request(**overrides) -> GenerationRequest:
    base = {
        "project_id": "test-project",
        "version_number": 1,
        "title": "Test Song",
        "style_prompt": "dream pop, hazy guitars",
        "lyrics": "[Verse]\nA line of words\n[Chorus]\nAnother line",
        "seed": 4242,
    }
    base.update(overrides)
    return GenerationRequest(**base)


async def collect(runner: MockRunner, request: GenerationRequest, out: Path):
    events: list[RunnerEvent] = []
    result: RunnerResult | None = None
    async for item in runner.generate(request, out):
        if isinstance(item, RunnerResult):
            result = item
        else:
            events.append(item)
    return events, result


async def test_produces_playable_audio(tmp_path: Path) -> None:
    runner = MockRunner(duration_seconds=2.0, total_runtime_seconds=0.2)
    events, result = await collect(runner, make_request(), tmp_path / "v1")

    assert result is not None
    assert result.exit_code == 0
    assert result.flac_path is not None and result.flac_path.is_file()

    # Not a stub: the file is a valid, non-empty, stereo WAV of the right length.
    with wave.open(str(result.flac_path), "rb") as audio:
        assert audio.getnchannels() == 2
        assert audio.getframerate() == 44_100
        frames = audio.getnframes()
    assert frames == pytest.approx(2.0 * 44_100, rel=0.01)
    assert result.flac_path.stat().st_size > 10_000
    assert events


async def test_stages_are_ordered_and_progress_is_monotonic(tmp_path: Path) -> None:
    runner = MockRunner(duration_seconds=1.0, total_runtime_seconds=0.2)
    events, result = await collect(runner, make_request(), tmp_path / "v1")

    stages = [e.stage for e in events]
    expected = [
        JobStage.LOADING_MODEL, JobStage.PLANNING, JobStage.GENERATING,
        JobStage.DECODING, JobStage.EXPORTING, JobStage.COMPLETED,
    ]
    first_seen = [s for i, s in enumerate(stages) if i == 0 or stages[i - 1] != s]
    assert [s for s in first_seen if s in expected] == expected

    progress = [e.progress for e in events if e.progress is not None]
    assert progress == sorted(progress)
    assert progress[-1] == pytest.approx(1.0)
    assert result is not None


async def test_same_seed_produces_identical_audio(tmp_path: Path) -> None:
    runner = MockRunner(duration_seconds=1.0, total_runtime_seconds=0.1)
    _, first = await collect(runner, make_request(seed=7), tmp_path / "a")
    _, second = await collect(runner, make_request(seed=7), tmp_path / "b")

    assert first is not None and second is not None
    assert first.seed == second.seed == 7
    assert first.flac_path.read_bytes() == second.flac_path.read_bytes()


async def test_different_seeds_differ(tmp_path: Path) -> None:
    runner = MockRunner(duration_seconds=1.0, total_runtime_seconds=0.1)
    _, first = await collect(runner, make_request(seed=1), tmp_path / "a")
    _, second = await collect(runner, make_request(seed=2), tmp_path / "b")
    assert first.flac_path.read_bytes() != second.flac_path.read_bytes()


async def test_emits_score_unless_planning_is_off(tmp_path: Path) -> None:
    runner = MockRunner(duration_seconds=1.0, total_runtime_seconds=0.1)
    _, with_plan = await collect(runner, make_request(cot=CotMode.FULL), tmp_path / "a")
    _, without = await collect(runner, make_request(cot=CotMode.OFF), tmp_path / "b")

    assert with_plan.score_abc is not None and with_plan.score_abc.startswith("X:1")
    assert without.score_abc is None


async def test_cancellation_stops_promptly(tmp_path: Path) -> None:
    runner = MockRunner(duration_seconds=5.0, total_runtime_seconds=6.0)
    started = asyncio.Event()

    async def run() -> None:
        async for _ in runner.generate(make_request(), tmp_path / "v1"):
            started.set()

    task = asyncio.create_task(run())
    await asyncio.wait_for(started.wait(), timeout=5.0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()


async def test_failure_mode_raises(tmp_path: Path) -> None:
    runner = MockRunner(duration_seconds=1.0, total_runtime_seconds=0.1, fail=True)
    with pytest.raises(RuntimeError, match="Simulated generation failure"):
        await collect(runner, make_request(), tmp_path / "v1")


async def test_diagnose_always_succeeds() -> None:
    result = await MockRunner().diagnose()
    assert result.ok is True
    assert result.exit_code == 0


def test_capabilities_are_declared() -> None:
    caps = MockRunner().capabilities
    assert caps.kind is RunnerKind.MOCK
    assert caps.supports_cancel and caps.supports_progress_percent
    assert JobStage.COMPLETED in caps.stages
    # The simulation must say so, so nothing presents it as real generation.
    assert "imulat" in caps.notes


def test_build_command_has_no_shell_metacharacters() -> None:
    argv = MockRunner().build_command(make_request(), Path("/tmp/out"))
    assert isinstance(argv, list)
    assert all(isinstance(part, str) for part in argv)
