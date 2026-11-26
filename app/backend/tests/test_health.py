"""Health, settings, diagnostics and single-instance tests."""
from __future__ import annotations

from pathlib import Path

import pytest

from songforge.enums import RunnerKind
from songforge.lock import InstanceLock, InstanceLockError


def test_health_reports_a_usable_state(client) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["database"] is True
    assert body["version"]
    # The default runner is the mock, which is always ready.
    assert body["runner_kind"] == RunnerKind.MOCK
    assert body["runner_ready"] is True
    assert body["projects"] == 0


def test_health_counts_projects(client) -> None:
    client.post("/api/projects", json={"title": "One"})
    client.post("/api/projects", json={"title": "Two"})
    assert client.get("/api/health").json()["projects"] == 2


def test_openapi_documents_every_endpoint(client) -> None:
    spec = client.get("/api/openapi.json").json()
    required = [
        "/api/health", "/api/settings", "/api/diagnostics/runner",
        "/api/projects", "/api/projects/{project_id}",
        "/api/projects/{project_id}/duplicate",
        "/api/projects/{project_id}/archive",
        "/api/projects/{project_id}/versions",
        "/api/projects/{project_id}/draft",
        "/api/projects/{project_id}/score",
        "/api/projects/{project_id}/generate",
        "/api/projects/{project_id}/download/{file_key}",
        "/api/projects/{project_id}/export.zip",
        "/api/jobs", "/api/jobs/{job_id}",
        "/api/jobs/{job_id}/cancel", "/api/jobs/{job_id}/retry",
        "/api/jobs/{job_id}/events",
    ]
    missing = [path for path in required if path not in spec["paths"]]
    assert not missing, f"missing documented endpoints: {missing}"


# ---------------------------------------------------------------- settings


def test_settings_round_trip(client) -> None:
    defaults = client.get("/api/settings").json()
    assert defaults["runner_kind"] == RunnerKind.MOCK
    assert defaults["backend_mode"] == "torch-eager"

    updated = client.put("/api/settings", json={"memory_budget_gib": 9.5}).json()
    assert updated["memory_budget_gib"] == 9.5
    # A partial update leaves everything else alone.
    assert updated["mp3_bitrate"] == defaults["mp3_bitrate"]


def test_settings_validation_rejects_bad_values(client) -> None:
    for payload in (
        {"gpu_index": -1},
        {"memory_budget_gib": 0},
        {"mp3_bitrate": 999},
        {"backend_mode": "cuda-magic"},
        {"quantization": "int4"},
        {"theme": "neon"},
        {"unknown_field": 1},
    ):
        assert client.put("/api/settings", json=payload).status_code == 422, payload


def test_settings_expose_capabilities_and_preview(client) -> None:
    body = client.get("/api/settings").json()
    caps = body["capabilities"]
    assert caps["kind"] == RunnerKind.MOCK
    assert isinstance(body["command_preview"], list)
    assert isinstance(body["configuration_issues"], list)


def test_yue2_runner_reports_issues_when_unconfigured(client) -> None:
    """Switching to the real runner with no model must be flagged, not hidden."""
    body = client.put("/api/settings", json={
        "runner_kind": "yue2_cli", "model_path": ""
    }).json()
    assert body["capabilities"]["kind"] == RunnerKind.YUE2_CLI
    assert body["configuration_issues"], "an unconfigured runner must report issues"
    assert any("model" in issue.lower() for issue in body["configuration_issues"])
    # It must not claim progress percentages it cannot produce.
    assert body["capabilities"]["supports_progress_percent"] is False


def test_yue2_command_preview_is_an_argument_list(client) -> None:
    body = client.put("/api/settings", json={
        "runner_kind": "yue2_cli",
        "model_path": "D:/models/YuE2-3B",
        "vae_path": "D:/models/YuE2-Vae",
        "python_executable": "D:/venv-yue2/Scripts/python.exe",
    }).json()
    preview = body["command_preview"]
    assert isinstance(preview, list) and preview
    assert "generate" in preview
    assert "--model=D:/models/YuE2-3B" in preview
    assert "--vae=D:/models/YuE2-Vae" in preview
    # Each element is one argument. Metacharacters inside an element are safe
    # precisely because the list is never handed to a shell - that is asserted
    # separately by test_no_shell_execution_anywhere.
    assert all(isinstance(part, str) for part in preview)
    assert not any(part.strip() == "" for part in preview)


def test_no_shell_execution_anywhere() -> None:
    """No code path may execute a command through a shell.

    Parsed with ast rather than matched as text, so prose in a docstring that
    mentions shell=True is not mistaken for a call that uses it.
    """
    import ast

    root = Path(__file__).resolve().parents[1] / "songforge"
    offenders: list[str] = []
    for path in sorted(root.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            for keyword in node.keywords:
                if keyword.arg == "shell" and not (
                    isinstance(keyword.value, ast.Constant)
                    and keyword.value.value is False
                ):
                    offenders.append(f"{path.relative_to(root)}:{node.lineno} shell=")
            name = ast.unparse(node.func)
            if name in {"os.system", "os.popen", "subprocess.getoutput"}:
                offenders.append(f"{path.relative_to(root)}:{node.lineno} {name}")
    assert not offenders, f"shell execution found: {offenders}"


def test_fp8_on_unsupported_gpu_is_flagged(client) -> None:
    body = client.put("/api/settings", json={
        "runner_kind": "yue2_cli",
        "model_path": "D:/models/YuE2-3B",
        "quantization": "fp8",
    }).json()
    assert any("fp8" in issue.lower() for issue in body["configuration_issues"])


# ------------------------------------------------------------- diagnostics


def test_diagnostics_for_mock_runner_succeed(client) -> None:
    body = client.post("/api/diagnostics/runner").json()
    assert body["ok"] is True
    assert body["checks"]


def test_diagnostics_do_not_crash_when_unconfigured(client) -> None:
    client.put("/api/settings", json={"runner_kind": "yue2_cli", "model_path": ""})
    response = client.post("/api/diagnostics/runner")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is False
    assert body["summary"]


# ---------------------------------------------------------- instance lock


def test_lock_blocks_a_second_instance(tmp_path: Path) -> None:
    lock_path = tmp_path / "songforge.lock"
    first = InstanceLock(lock_path)
    first.acquire()
    try:
        with pytest.raises(InstanceLockError):
            InstanceLock(lock_path).acquire()
    finally:
        first.release()
    assert not lock_path.exists()


def test_stale_lock_is_reclaimed(tmp_path: Path) -> None:
    """A lock left by a dead process must not block startup forever."""
    lock_path = tmp_path / "songforge.lock"
    # PID 0 is never a live process this code can signal.
    lock_path.write_text("999999999", encoding="ascii")

    lock = InstanceLock(lock_path)
    lock.acquire()
    try:
        assert lock_path.read_text(encoding="ascii").strip()
    finally:
        lock.release()


def test_lock_survives_a_corrupt_file(tmp_path: Path) -> None:
    lock_path = tmp_path / "songforge.lock"
    lock_path.write_text("not-a-pid", encoding="ascii")
    lock = InstanceLock(lock_path)
    lock.acquire()
    lock.release()
    assert not lock_path.exists()
