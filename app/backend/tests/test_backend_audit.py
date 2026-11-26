"""Regressions for the second backend audit.

Each test reproduces a defect the audit confirmed against the running app:
data loss on a late cancel, client-triggerable 500s, a lock that never
reclaimed on Windows, and several state invariants the queue broke.
"""
from __future__ import annotations

import subprocess
import sys
import time

import pytest

from .conftest import needs_ffmpeg, wait_for
from .test_features import make_project, settle


def generate(client, project_id: str, **payload) -> str:
    response = client.post(f"/api/projects/{project_id}/generate", json=payload)
    assert response.status_code == 202, response.text
    return response.json()["id"]


# ---------------------------------------------------- late cancel keeps audio


@needs_ffmpeg
def test_cancel_during_finalise_keeps_the_rendered_version(
    client, fast_mock, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Audio exists once the runner returns; a Cancel then must not discard it."""
    from songforge import storage

    original = storage.build_waveform
    entered = {"at": 0.0}

    def slow_waveform(*args, **kwargs):
        entered["at"] = time.monotonic()
        time.sleep(1.5)
        return original(*args, **kwargs)

    monkeypatch.setattr(storage, "build_waveform", slow_waveform)

    project_id = make_project(client)
    job_id = generate(client, project_id)
    assert wait_for(lambda: entered["at"] > 0, timeout=30), "finalise never started"

    cancel = client.post(f"/api/jobs/{job_id}/cancel")
    assert cancel.status_code in (200, 202), cancel.text

    job = settle(client, job_id)
    assert job["status"] == "completed", job

    detail = client.get(f"/api/projects/{project_id}").json()
    version = detail["versions"][0]
    assert version["has_flac"] is True
    assert detail["primary_version"] == version["number"]


# ------------------------------------------------------------ bounded integers


def test_huge_version_number_is_rejected_not_500(client) -> None:
    project_id = make_project(client)
    response = client.delete(
        f"/api/projects/{project_id}/versions/99999999999999999999?confirm=true"
    )
    assert response.status_code == 422


def test_huge_primary_version_is_rejected_not_500(client) -> None:
    project_id = make_project(client)
    response = client.put(
        f"/api/projects/{project_id}", json={"primary_version": 99999999999999999999}
    )
    assert response.status_code == 422


def test_huge_stream_version_is_rejected_not_500(client) -> None:
    project_id = make_project(client)
    response = client.get(f"/api/projects/{project_id}/stream?version=99999999999999999999")
    assert response.status_code == 422


# ------------------------------------------------------------- lock liveness


def test_dead_pid_is_not_reported_alive() -> None:
    """os.kill(pid, 0) says 'alive' for dead pids on Windows; the probe must not."""
    from songforge.lock import _pid_alive

    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    assert _pid_alive(child.pid) is False


def test_live_pid_is_reported_alive() -> None:
    import os

    from songforge.lock import _pid_alive

    assert _pid_alive(os.getpid()) is True


def test_stale_lock_from_a_dead_process_is_reclaimed(tmp_path) -> None:
    from songforge.lock import InstanceLock

    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    lock_path = tmp_path / "songforge.lock"
    lock_path.write_text(str(child.pid), encoding="utf-8")

    lock = InstanceLock(lock_path)
    lock.acquire()  # must not raise
    lock.release()


# ------------------------------------------------- primary pointer and flag


def test_clearing_primary_clears_the_flag_so_the_version_can_be_deleted(
    client, fast_mock
) -> None:
    project_id = make_project(client)
    settle(client, generate(client, project_id))

    cleared = client.put(f"/api/projects/{project_id}", json={"primary_version": None})
    assert cleared.status_code == 200, cleared.text
    detail = cleared.json()
    assert detail["primary_version"] is None
    assert all(not v["is_primary"] for v in detail["versions"])

    number = detail["versions"][0]["number"]
    deleted = client.delete(f"/api/projects/{project_id}/versions/{number}?confirm=true")
    assert deleted.status_code == 204, deleted.text


# ------------------------------------------------------ quick-mode rollback


def test_refused_quick_generate_leaves_no_project(client) -> None:
    before = client.get("/api/projects").json()["total"]
    response = client.post(
        "/api/projects/quick", json={"prompt": "dreamy synthwave", "lyrics": ""}
    )
    assert response.status_code == 422
    assert client.get("/api/projects").json()["total"] == before


# -------------------------------------------------- archived stays archived


def test_generation_on_an_archived_project_keeps_it_archived(client, fast_mock) -> None:
    project_id = make_project(client)
    assert client.post(f"/api/projects/{project_id}/archive?archived=true").status_code == 200

    settle(client, generate(client, project_id))

    detail = client.get(f"/api/projects/{project_id}").json()
    assert detail["archived"] is True
    assert detail["status"] == "archived"
    listed = client.get("/api/projects?archived=true").json()["items"]
    assert any(item["id"] == project_id for item in listed)


def test_restoring_a_failed_project_keeps_it_failed(client, monkeypatch) -> None:
    from songforge.runners import mock as mock_module
    from songforge.runners.base import RunnerError

    async def failing(self, request, output_dir):
        raise RunnerError("simulated failure", exit_code=1)
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(mock_module.MockRunner, "generate", failing)

    project_id = make_project(client)
    job = settle(client, generate(client, project_id))
    assert job["status"] == "failed"

    client.post(f"/api/projects/{project_id}/archive?archived=true")
    restored = client.post(f"/api/projects/{project_id}/archive?archived=false").json()
    assert restored["status"] == "failed"


# -------------------------------------------------------------- play counter


def test_range_requests_do_not_inflate_play_count(client, fast_mock) -> None:
    project_id = make_project(client)
    settle(client, generate(client, project_id))
    url = f"/api/projects/{project_id}/stream"

    client.get(url, headers={"Range": "bytes=0-1"})  # Safari's probe
    client.get(url, headers={"Range": "bytes=0-"})  # the real playback
    client.get(url, headers={"Range": "bytes=4096-"})  # a seek

    assert client.get(f"/api/projects/{project_id}").json()["play_count"] == 1


# ------------------------------------------------ version delete leaves nothing


def test_deleting_a_version_removes_its_root_input_files(client, fast_mock) -> None:
    from songforge import storage

    project_id = make_project(client)
    settle(client, generate(client, project_id))
    settle(client, generate(client, project_id))

    root = storage.project_dir(project_id)
    assert (root / "request-v1.json").is_file()

    response = client.delete(f"/api/projects/{project_id}/versions/1?confirm=true")
    if response.status_code == 409:  # v1 is primary; promote v2 and retry
        client.put(f"/api/projects/{project_id}", json={"primary_version": 2})
        response = client.delete(f"/api/projects/{project_id}/versions/1?confirm=true")
    assert response.status_code == 204, response.text

    for name in ("lyrics-v1.txt", "style-v1.txt", "request-v1.json", "score-v1.abc"):
        assert not (root / name).exists(), name
    assert (root / "request-v2.json").is_file()


# ------------------------------------------------------ plan-only receipts


def test_plan_receipt_is_read_from_plan_json(tmp_path) -> None:
    import json

    from songforge.runners.yue2 import Yue2CliRunner

    (tmp_path / "plan.json").write_text(
        json.dumps({"truncated": True, "timing": {"seconds": 42.9}}), encoding="utf-8"
    )
    receipt = Yue2CliRunner._read_result(tmp_path)
    assert receipt["truncated"] == {"abc": True}
    assert receipt["timing"] == {"seconds": 42.9}
