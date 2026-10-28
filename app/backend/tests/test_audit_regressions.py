"""Regressions for defects found in the Phase 1 audit.

Each test names the behaviour that was wrong, so a reintroduction is obvious.
"""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from songforge.enums import JobStatus, ProjectStatus, RunnerKind

from .conftest import wait_for


def make_project(client, **overrides) -> str:
    payload = {
        "title": "Audit Subject",
        "style_prompt": "downtempo, warm keys",
        "lyrics": "[Verse]\nchecking the wiring",
    }
    payload.update(overrides)
    response = client.post("/api/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def run_to_completion(client, project_id: str) -> dict:
    job = client.post(f"/api/projects/{project_id}/generate", json={}).json()
    assert wait_for(
        lambda: client.get(f"/api/jobs/{job['id']}").json()["status"] == "completed",
        timeout=60,
    ), client.get(f"/api/jobs/{job['id']}").json()
    return client.get(f"/api/jobs/{job['id']}").json()


# ------------------------------------------- diagnostics must not 500 on bad config


def test_diagnostics_reports_a_disallowed_executable(client) -> None:
    """Diagnostics is where a misconfiguration is explained, not where it crashes."""
    client.put("/api/settings", json={
        "runner_kind": "yue2_cli",
        "yue2_executable": "notepad.exe",
        "model_path": "D:/models/YuE2-3B",
    })
    response = client.post("/api/diagnostics/runner")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert "yue2" in body["summary"].lower()
    assert any(not check["ok"] for check in body["checks"])


# ------------------------------------------------------ project status after failure


def test_failed_job_does_not_undo_a_completed_project(client, fast_mock, monkeypatch) -> None:
    """A later failure must not mark a project with finished audio as failed."""
    from songforge.runners import mock as mock_module

    project_id = make_project(client)
    run_to_completion(client, project_id)
    assert client.get(f"/api/projects/{project_id}").json()["status"] == "completed"

    original_init = mock_module.MockRunner.__init__

    def failing(self, **kwargs):
        kwargs["fail"] = True
        original_init(self, **kwargs)

    monkeypatch.setattr(mock_module.MockRunner, "__init__", failing)
    job = client.post(f"/api/projects/{project_id}/generate", json={}).json()
    assert wait_for(
        lambda: client.get(f"/api/jobs/{job['id']}").json()["status"] == "failed",
        timeout=60,
    )

    project = client.get(f"/api/projects/{project_id}").json()
    assert project["status"] == ProjectStatus.COMPLETED
    assert project["primary_version"] == 1
    # The failed attempt is still visible as a failed job.
    assert client.get(f"/api/jobs/{job['id']}").json()["error"]


def test_cancelled_job_does_not_undo_a_completed_project(client, fast_mock) -> None:
    project_id = make_project(client)
    run_to_completion(client, project_id)

    blocker = make_project(client, title="Blocker")
    client.post(f"/api/projects/{blocker}/generate", json={})
    queued = client.post(f"/api/projects/{project_id}/generate", json={}).json()
    assert client.post(f"/api/jobs/{queued['id']}/cancel").json()["status"] == "cancelled"

    assert client.get(f"/api/projects/{project_id}").json()["status"] == ProjectStatus.COMPLETED


# --------------------------------------------------------- download flags are honest


def test_version_flags_match_what_is_on_disk(client, fast_mock, runtime_dir: Path) -> None:
    """has_flac/has_mp3/has_wav must describe real files, not intentions."""
    project_id = make_project(client)
    run_to_completion(client, project_id)

    version = client.get(f"/api/projects/{project_id}/versions").json()[0]
    root = runtime_dir / "projects" / project_id / "versions" / "v1"

    assert version["has_flac"] == (root / "song.flac").is_file()
    assert version["has_mp3"] == (root / "song.mp3").is_file()
    assert version["has_wav"] == (root / "song.wav").is_file()

    # Every flag that is true must correspond to a download that succeeds.
    for key, flag in (("flac", "has_flac"), ("mp3", "has_mp3"), ("wav", "has_wav")):
        expected = 200 if version[flag] else 404
        got = client.get(f"/api/projects/{project_id}/download/{key}?version=1")
        assert got.status_code == expected, (key, version[flag], got.status_code)


def test_no_ffmpeg_still_produces_playable_audio(
    client, fast_mock, runtime_dir: Path, monkeypatch
) -> None:
    """FFmpeg is never required to produce output; the flags must stay truthful."""
    import songforge.queue as queue_module
    import songforge.storage as storage_module

    monkeypatch.setattr(queue_module.shutil, "which", lambda _name: None)
    monkeypatch.setattr(storage_module.shutil, "which", lambda _name: None)

    project_id = make_project(client)
    run_to_completion(client, project_id)

    version = client.get(f"/api/projects/{project_id}/versions").json()[0]
    root = runtime_dir / "projects" / project_id / "versions" / "v1"
    assert (root / "song.wav").is_file(), "the runner's own output must be kept"
    assert version["has_flac"] is False, "no FLAC exists without FFmpeg"
    assert version["has_wav"] is True

    assert client.get(f"/api/projects/{project_id}/download/flac?version=1").status_code == 404
    assert client.get(f"/api/projects/{project_id}/download/wav?version=1").status_code == 200
    # Playback still works: /stream falls back to whatever audio exists.
    assert client.get(f"/api/projects/{project_id}/stream").status_code == 200


# ------------------------------------------------------------- per-job capabilities


def test_job_keeps_the_capability_of_its_own_runner(client, fast_mock) -> None:
    """Switching runners must not rewrite history on past jobs."""
    project_id = make_project(client)
    job = run_to_completion(client, project_id)
    assert job["runner_kind"] == RunnerKind.MOCK
    assert job["supports_progress_percent"] is True

    client.put("/api/settings", json={
        "runner_kind": "yue2_cli", "model_path": "D:/models/YuE2-3B",
    })
    after = client.get(f"/api/jobs/{job['id']}").json()
    assert after["runner_kind"] == RunnerKind.MOCK
    assert after["supports_progress_percent"] is True, (
        "a completed mock job must keep its progress bar"
    )


# ------------------------------------------------------------------ downloads / zip


def test_every_advertised_download_key_works(client, fast_mock) -> None:
    project_id = make_project(client)
    run_to_completion(client, project_id)

    for key in ("waveform", "log", "metadata", "command"):
        response = client.get(f"/api/projects/{project_id}/download/{key}?version=1")
        assert response.status_code == 200, (key, response.status_code)
        assert response.content, f"{key} download was empty"

    metadata = client.get(f"/api/projects/{project_id}/download/metadata?version=1").json()
    assert metadata["version"] == 1
    assert metadata["runner"] == RunnerKind.MOCK


def test_export_zip_contains_the_project_tree(client, fast_mock) -> None:
    project_id = make_project(client)
    run_to_completion(client, project_id)

    response = client.get(f"/api/projects/{project_id}/export.zip")
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"

    from io import BytesIO

    with zipfile.ZipFile(BytesIO(response.content)) as archive:
        names = set(archive.namelist())
        assert "project.json" in names
        assert "lyrics-v1.txt" in names
        assert "style-v1.txt" in names
        assert "request-v1.json" in names
        assert any(n.startswith("versions/v1/") for n in names)
        assert "versions/v1/metadata.json" in names
        # Nothing escapes the archive root.
        for name in names:
            assert not name.startswith("/") and ".." not in name.split("/")
        # The manifest inside the zip is real JSON.
        assert json.loads(archive.read("project.json"))["id"] == project_id


def test_quick_generate_creates_and_queues(client, fast_mock) -> None:
    response = client.post("/api/projects/quick", json={
        "prompt": "lo-fi hip hop, rainy window, mellow",
        "lyrics": "[Verse]\nrain on the glass",
        "instrumental": False,
    })
    assert response.status_code == 202, response.text
    job = response.json()
    assert job["version_number"] == 1
    settled = wait_for(
        lambda: client.get(f"/api/jobs/{job['id']}").json()["status"] == "completed",
        timeout=60,
    )
    assert settled
    assert client.get(f"/api/projects/{job['project_id']}").json()["title"]


def test_quick_generate_rejects_a_blank_prompt(client) -> None:
    assert client.post("/api/projects/quick", json={"prompt": "   "}).status_code == 422


def test_quick_generate_without_lyrics_explains_why(client) -> None:
    """YuE2 requires lyrics, so Quick mode must say so rather than fail opaquely."""
    response = client.post("/api/projects/quick", json={"prompt": "dream pop"})
    assert response.status_code == 422
    assert "lyrics" in response.json()["detail"].lower()


# -------------------------------------------------------------------------- SSE


def test_job_events_stream_reports_progress(live_server, fast_mock) -> None:
    """Functional check of the SSE endpoint against a real HTTP server.

    TestClient buffers streaming responses, so an in-process client would hang
    here rather than observing frames as they are produced.
    """
    import httpx

    base = live_server
    with httpx.Client(base_url=base, timeout=60.0) as http:
        created = http.post("/api/projects", json={
            "title": "SSE Subject", "style_prompt": "ambient",
            "lyrics": "[Verse]\nlistening",
        })
        assert created.status_code == 201, created.text
        project_id = created.json()["id"]
        job = http.post(f"/api/projects/{project_id}/generate", json={}).json()

        frames: list[dict] = []
        event_name: str | None = None
        with http.stream("GET", f"/api/jobs/{job['id']}/events") as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith("text/event-stream")
            for line in response.iter_lines():
                if line.startswith("event:"):
                    event_name = line.split(":", 1)[1].strip()
                elif line.startswith("data:"):
                    payload = json.loads(line.split(":", 1)[1])
                    payload["_event"] = event_name
                    frames.append(payload)
                    if event_name in {"completed", "failed", "cancelled"}:
                        break

    assert frames, "no SSE frames were received"
    assert frames[-1]["_event"] == "completed"
    assert frames[-1]["job_id"] == job["id"]
    stages = [f.get("stage") for f in frames if f.get("stage")]
    assert "generating" in stages
    assert stages[-1] == "completed"


def test_event_history_is_bounded() -> None:
    """The broker must not retain a tail for every job it has ever seen."""
    from songforge.events import MAX_TRACKED_JOBS, EventBroker, JobEvent

    broker = EventBroker()
    for index in range(MAX_TRACKED_JOBS + 50):
        broker.publish(JobEvent(job_id=f"job-{index}", type="stage", stage="generating"))
    assert len(broker._recent) <= MAX_TRACKED_JOBS


# ----------------------------------------------------------- waveform correctness


def test_waveform_uses_all_channels(tmp_path: Path) -> None:
    """A stereo file with signal only on the right must not render as silence."""
    import struct
    import wave

    from songforge.storage import build_waveform

    path = tmp_path / "right-only.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(8000)
        out.writeframes(b"".join(struct.pack("<hh", 0, 20000) for _ in range(8000)))

    data = build_waveform(path, tmp_path / "waveform.json")
    assert data["available"] is True
    assert max(data["peaks"]) > 0.5, "right-channel signal was reported as silence"


# ------------------------------------------------------ concurrent version numbers


def test_concurrent_generate_allocates_distinct_versions(client, fast_mock) -> None:
    """Two Generate presses must not collide on the same version number."""
    import threading

    project_id = make_project(client)
    results: list[tuple[int, int | None]] = []
    barrier = threading.Barrier(2)
    lock = threading.Lock()

    def submit() -> None:
        barrier.wait()
        response = client.post(f"/api/projects/{project_id}/generate", json={})
        body = response.json() if response.content else {}
        with lock:
            results.append((response.status_code, body.get("version_number")))

    threads = [threading.Thread(target=submit) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert len(results) == 2
    codes = [code for code, _ in results]
    assert all(code in (202, 409) for code in codes), results
    numbers = [n for code, n in results if code == 202]
    assert len(numbers) == len(set(numbers)), f"duplicate version numbers: {results}"
    assert 500 not in codes
