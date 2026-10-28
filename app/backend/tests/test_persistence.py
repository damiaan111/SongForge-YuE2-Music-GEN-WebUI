"""Persistence across a backend restart.

Proves the requirement that projects survive a restart and that jobs left
running by a crash are marked interrupted without losing their logs.
"""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from songforge.enums import JobStatus
from songforge.models import Job, Project

from .conftest import needs_ffmpeg, wait_for


def restart(runtime_dir: Path) -> TestClient:
    """Build a brand-new app against the same runtime directory."""
    from songforge import config, db
    from songforge.main import create_app

    config.get_config.cache_clear()
    db._engine = None
    return TestClient(create_app())


@needs_ffmpeg
def test_projects_and_versions_survive_a_restart(runtime_dir: Path, fast_mock) -> None:
    from songforge.main import create_app

    with TestClient(create_app()) as client:
        created = client.post("/api/projects", json={
            "title": "Persistent Song",
            "style_prompt": "ambient, slow strings",
            "lyrics": "[Verse]\nStill here tomorrow",
            "tags": ["ambient", "test"],
        })
        assert created.status_code == 201
        project_id = created.json()["id"]

        job = client.post(f"/api/projects/{project_id}/generate", json={}).json()
        assert wait_for(
            lambda: client.get(f"/api/jobs/{job['id']}").json()["status"] == "completed",
            timeout=60,
        )
        audio_before = client.get(
            f"/api/projects/{project_id}/download/flac?version=1"
        ).content
        assert len(audio_before) > 1000

    # --- process restart ---
    with restart(runtime_dir) as client:
        listing = client.get("/api/projects").json()
        assert listing["total"] == 1

        detail = client.get(f"/api/projects/{project_id}").json()
        assert detail["title"] == "Persistent Song"
        assert detail["tags"] == ["ambient", "test"]
        assert detail["primary_version"] == 1
        assert len(detail["versions"]) == 1

        # The generated audio is byte-identical after the restart.
        after = client.get(f"/api/projects/{project_id}/download/flac?version=1").content
        assert after == audio_before

        # And the log is still readable.
        assert client.get(f"/api/jobs/{job['id']}/log").json()["lines"]


def test_running_job_is_marked_interrupted_after_a_crash(runtime_dir: Path) -> None:
    """A job left 'running' by a killed process must not stay running forever."""
    from songforge import db
    from songforge.main import create_app

    with TestClient(create_app()) as client:
        created = client.post("/api/projects", json={
            "title": "Crashed", "style_prompt": "noise", "lyrics": "[Verse]\nx",
        })
        project_id = created.json()["id"]

    # Simulate a crash: a job row stuck in RUNNING with a log already on disk.
    from songforge import storage

    with Session(db.get_engine()) as session:
        job = Job(project_id=project_id, version_number=1, status=JobStatus.RUNNING,
                  message="was running")
        session.add(job)
        session.commit()
        job_id = job.id
    storage.append_log(project_id, 1, "line written before the crash")

    with restart(runtime_dir) as client:
        state = client.get(f"/api/jobs/{job_id}").json()
        assert state["status"] == "interrupted"
        assert "stopped" in (state["error"] or "").lower()

        # The log survived; nothing was cleaned up behind the user's back.
        lines = client.get(f"/api/jobs/{job_id}/log").json()["lines"]
        assert "line written before the crash" in lines


def test_queued_jobs_survive_a_restart(runtime_dir: Path, fast_mock) -> None:
    from songforge import db
    from songforge.main import create_app

    with TestClient(create_app()) as client:
        first = client.post("/api/projects", json={
            "title": "A", "style_prompt": "x", "lyrics": "[Verse]\na"}).json()["id"]
        client.post(f"/api/projects/{first}/generate", json={})

    # Add a queued job directly, as though the process died before running it.
    with Session(db.get_engine()) as session:
        project = session.exec(select(Project)).first()
        job = Job(project_id=project.id, version_number=5, status=JobStatus.QUEUED,
                  request={"style_prompt": "x", "lyrics": "y", "title": "A"})
        session.add(job)
        session.commit()
        queued_id = job.id

    with restart(runtime_dir) as client:
        # The queued job is still there and gets picked up by the new worker.
        assert wait_for(
            lambda: client.get(f"/api/jobs/{queued_id}").json()["status"]
            in {"completed", "running", "failed"},
            timeout=60,
        )


def test_settings_survive_a_restart(runtime_dir: Path) -> None:
    from songforge.main import create_app

    with TestClient(create_app()) as client:
        updated = client.put("/api/settings", json={
            "gpu_index": 0,
            "memory_budget_gib": 10.5,
            "mp3_bitrate": 192,
            "theme": "dark",
            "model_path": "/models/YuE2-3B",
        })
        assert updated.status_code == 200

    with restart(runtime_dir) as client:
        settings = client.get("/api/settings").json()
        assert settings["memory_budget_gib"] == 10.5
        assert settings["mp3_bitrate"] == 192
        assert settings["model_path"].endswith("YuE2-3B")


def test_project_files_exist_on_disk(runtime_dir: Path, fast_mock) -> None:
    """The documented folder layout is actually produced."""
    from songforge.main import create_app

    with TestClient(create_app()) as client:
        created = client.post("/api/projects", json={
            "title": "Layout", "style_prompt": "folk",
            "lyrics": "[Verse]\nOn disk",
        })
        project_id = created.json()["id"]
        job = client.post(f"/api/projects/{project_id}/generate", json={}).json()
        assert wait_for(
            lambda: client.get(f"/api/jobs/{job['id']}").json()["status"] == "completed",
            timeout=60,
        )

    root = runtime_dir / "projects" / project_id
    assert (root / "project.json").is_file()
    assert (root / "lyrics-v1.txt").is_file()
    assert (root / "style-v1.txt").is_file()
    assert (root / "request-v1.json").is_file()

    version = root / "versions" / "v1"
    assert (version / "waveform.json").is_file()
    assert (version / "generation.log").is_file()
    assert (version / "runner-command.txt").is_file()
    assert (version / "metadata.json").is_file()
    # FLAC when FFmpeg is available, WAV otherwise - but always some audio.
    assert (version / "song.flac").is_file() or (version / "song.wav").is_file()


def test_generated_cover_art_is_gone(runtime_dir: Path, fast_mock) -> None:
    """Cover art was dropped; nothing should write or advertise it."""
    from songforge import storage
    from songforge.main import create_app

    assert not hasattr(storage, "build_artwork")
    assert "artwork" not in storage.DOWNLOADABLE

    with TestClient(create_app()) as client:
        created = client.post("/api/projects", json={
            "title": "No cover", "style_prompt": "folk",
            "lyrics": "[Verse]\nNothing to look at",
        })
        project_id = created.json()["id"]
        job = client.post(f"/api/projects/{project_id}/generate", json={}).json()
        assert wait_for(
            lambda: client.get(f"/api/jobs/{job['id']}").json()["status"] == "completed",
            timeout=60,
        )
        assert client.get(
            f"/api/projects/{project_id}/download/artwork?version=1"
        ).status_code == 404
        versions = client.get(f"/api/projects/{project_id}/versions").json()
        assert "has_artwork" not in versions[0]

    assert not (runtime_dir / "projects" / project_id / "versions" / "v1" / "artwork.png").exists()
