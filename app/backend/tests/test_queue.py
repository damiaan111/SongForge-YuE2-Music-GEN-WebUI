"""Queue, versioning and validation tests, exercised through the HTTP API."""
from __future__ import annotations

from pathlib import Path

import pytest

from songforge.enums import JobStatus, ProjectStatus

from .conftest import wait_for


def create_project(client, **overrides) -> dict:
    payload = {
        "title": "Night Drive",
        "style_prompt": "synthwave, analog pads, steady beat",
        "lyrics": "[Verse]\nNeon on the dashboard\n[Chorus]\nDriving through the night",
    }
    payload.update(overrides)
    response = client.post("/api/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def wait_for_job(client, job_id: str, *, timeout: float = 60.0) -> dict:
    state: dict = {}

    def done() -> bool:
        state.update(client.get(f"/api/jobs/{job_id}").json())
        return state["status"] in {"completed", "failed", "cancelled", "interrupted"}

    assert wait_for(done, timeout=timeout), f"job did not settle: {state}"
    return state


# ------------------------------------------------------------- versioning


def test_versions_increment_and_audio_is_immutable(client, fast_mock) -> None:
    project = create_project(client)
    pid = project["id"]

    first = client.post(f"/api/projects/{pid}/generate", json={})
    assert first.status_code == 202
    job_one = wait_for_job(client, first.json()["id"])
    assert job_one["status"] == "completed"
    assert job_one["version_number"] == 1

    detail = client.get(f"/api/projects/{pid}").json()
    original_audio = Path(
        client.get(f"/api/projects/{pid}/download/flac?version=1").request.url.path
    )
    assert detail["primary_version"] == 1

    audio_one = client.get(f"/api/projects/{pid}/download/flac?version=1").content
    assert len(audio_one) > 1000

    second = client.post(f"/api/projects/{pid}/generate", json={})
    job_two = wait_for_job(client, second.json()["id"])
    assert job_two["version_number"] == 2
    assert job_two["status"] == "completed"

    # Version 1's audio is untouched by the second generation.
    assert client.get(f"/api/projects/{pid}/download/flac?version=1").content == audio_one

    versions = client.get(f"/api/projects/{pid}/versions").json()
    assert [v["number"] for v in versions] == [1, 2]
    assert original_audio is not None


def test_draft_edits_do_not_change_a_completed_version(client, fast_mock) -> None:
    project = create_project(client)
    pid = project["id"]
    job = client.post(f"/api/projects/{pid}/generate", json={}).json()
    wait_for_job(client, job["id"])

    before = client.get(f"/api/projects/{pid}/versions").json()[0]
    client.put(f"/api/projects/{pid}/draft",
               json={"lyrics": "[Verse]\nCompletely different words"})
    after = client.get(f"/api/projects/{pid}/versions").json()[0]

    assert after["lyrics"] == before["lyrics"]
    assert client.get(f"/api/projects/{pid}").json()["lyrics"] != before["lyrics"]


def test_set_primary_version(client, fast_mock) -> None:
    project = create_project(client)
    pid = project["id"]
    for _ in range(2):
        job = client.post(f"/api/projects/{pid}/generate", json={}).json()
        wait_for_job(client, job["id"])

    updated = client.put(f"/api/projects/{pid}", json={"primary_version": 2})
    assert updated.status_code == 200
    assert updated.json()["primary_version"] == 2
    flags = {v["number"]: v["is_primary"] for v in updated.json()["versions"]}
    assert flags == {1: False, 2: True}


def test_set_primary_rejects_unknown_version(client) -> None:
    pid = create_project(client)["id"]
    assert client.put(f"/api/projects/{pid}", json={"primary_version": 9}).status_code == 404


# ------------------------------------------------------------------ queue


def test_one_job_at_a_time_and_queue_positions(client, fast_mock) -> None:
    first_id = create_project(client, title="First")["id"]
    second_id = create_project(client, title="Second")["id"]

    job_a = client.post(f"/api/projects/{first_id}/generate", json={}).json()
    job_b = client.post(f"/api/projects/{second_id}/generate", json={}).json()

    # The second job waits; it is never started concurrently.
    listing = client.get("/api/jobs").json()
    assert len([j for j in listing["items"] if j["status"] == "running"]) <= 1

    wait_for_job(client, job_a["id"])
    wait_for_job(client, job_b["id"])
    assert client.get(f"/api/jobs/{job_a['id']}").json()["status"] == "completed"
    assert client.get(f"/api/jobs/{job_b['id']}").json()["status"] == "completed"


def test_cancel_queued_job_is_immediate(client, fast_mock) -> None:
    busy = create_project(client, title="Busy")["id"]
    waiting = create_project(client, title="Waiting")["id"]

    client.post(f"/api/projects/{busy}/generate", json={})
    queued = client.post(f"/api/projects/{waiting}/generate", json={}).json()

    response = client.post(f"/api/jobs/{queued['id']}/cancel")
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"

    project = client.get(f"/api/projects/{waiting}").json()
    assert project["status"] == ProjectStatus.CANCELLED


def test_cancel_completed_job_is_rejected(client, fast_mock) -> None:
    pid = create_project(client)["id"]
    job = client.post(f"/api/projects/{pid}/generate", json={}).json()
    wait_for_job(client, job["id"])
    assert client.post(f"/api/jobs/{job['id']}/cancel").status_code == 409


def test_retry_creates_a_new_version_and_keeps_the_old_log(client, fast_mock,
                                                           monkeypatch) -> None:
    from songforge.runners import mock as mock_module

    pid = create_project(client)["id"]
    original_init = mock_module.MockRunner.__init__

    def failing(self, **kwargs):
        kwargs["fail"] = True
        original_init(self, **kwargs)

    monkeypatch.setattr(mock_module.MockRunner, "__init__", failing)
    job = client.post(f"/api/projects/{pid}/generate", json={}).json()
    failed = wait_for_job(client, job["id"])
    assert failed["status"] == "failed"
    assert failed["error"]

    monkeypatch.setattr(mock_module.MockRunner, "__init__", original_init)
    retry = client.post(f"/api/jobs/{job['id']}/retry")
    assert retry.status_code == 202
    assert retry.json()["retry_of"] == job["id"]
    assert retry.json()["version_number"] == 2

    settled = wait_for_job(client, retry.json()["id"])
    assert settled["status"] == "completed"
    # The failed attempt keeps its own log.
    assert client.get(f"/api/jobs/{job['id']}/log").json()["lines"]


def test_retry_of_completed_job_is_rejected(client, fast_mock) -> None:
    pid = create_project(client)["id"]
    job = client.post(f"/api/projects/{pid}/generate", json={}).json()
    wait_for_job(client, job["id"])
    assert client.post(f"/api/jobs/{job['id']}/retry").status_code == 409


# ------------------------------------------------------------- validation


def test_generate_requires_a_style_prompt(client) -> None:
    pid = create_project(client, style_prompt="")["id"]
    response = client.post(f"/api/projects/{pid}/generate", json={})
    assert response.status_code == 422
    assert "style" in response.json()["detail"].lower()


def test_generate_requires_lyrics_unless_instrumental(client) -> None:
    pid = create_project(client, lyrics="")["id"]
    response = client.post(f"/api/projects/{pid}/generate", json={})
    assert response.status_code == 422
    assert "lyrics" in response.json()["detail"].lower()


def test_unsupported_option_is_rejected_not_ignored(client) -> None:
    """A runner without a capability must refuse the option, never drop it."""
    from songforge.runners.mock import MockRunner

    pid = create_project(client)["id"]
    caps = MockRunner().capabilities
    assert caps.supports_cfg_scale  # the mock does support it

    # Switch to the yue2 runner, which has no instrumental mode.
    client.put("/api/settings", json={
        "runner_kind": "yue2_cli",
        "model_path": "D:/nonexistent-model",
    })
    response = client.post(f"/api/projects/{pid}/generate", json={"instrumental": True})
    assert response.status_code in (409, 422)


def test_manual_seed_requires_a_value(client) -> None:
    pid = create_project(client)["id"]
    response = client.post(f"/api/projects/{pid}/generate",
                           json={"seed_mode": "manual"})
    assert response.status_code == 422


def test_seed_is_recorded_and_reusable(client, fast_mock) -> None:
    pid = create_project(client)["id"]
    job = client.post(f"/api/projects/{pid}/generate",
                      json={"seed_mode": "manual", "seed": 12345}).json()
    wait_for_job(client, job["id"])
    version = client.get(f"/api/projects/{pid}/versions").json()[0]
    assert version["seed"] == 12345


def test_oversized_input_is_rejected(client) -> None:
    response = client.post("/api/projects", json={
        "title": "Too long", "style_prompt": "x" * 5_000,
    })
    assert response.status_code == 422


def test_unknown_field_is_rejected(client) -> None:
    response = client.post("/api/projects", json={"title": "X", "nope": 1})
    assert response.status_code == 422


# ---------------------------------------------------------------- deleting


def test_delete_requires_confirmation(client) -> None:
    pid = create_project(client)["id"]
    assert client.delete(f"/api/projects/{pid}").status_code == 400
    assert client.delete(f"/api/projects/{pid}?confirm=true").status_code == 204
    assert client.get(f"/api/projects/{pid}").status_code == 404


def test_delete_removes_files(client, fast_mock, runtime_dir: Path) -> None:
    pid = create_project(client)["id"]
    job = client.post(f"/api/projects/{pid}/generate", json={}).json()
    wait_for_job(client, job["id"])

    project_path = runtime_dir / "projects" / pid
    assert project_path.is_dir()
    client.delete(f"/api/projects/{pid}?confirm=true")
    assert not project_path.exists()


def test_delete_is_blocked_while_a_job_is_active(client, fast_mock) -> None:
    busy = create_project(client, title="Busy")["id"]
    waiting = create_project(client, title="Waiting")["id"]
    client.post(f"/api/projects/{busy}/generate", json={})
    client.post(f"/api/projects/{waiting}/generate", json={})
    assert client.delete(f"/api/projects/{waiting}?confirm=true").status_code == 409
