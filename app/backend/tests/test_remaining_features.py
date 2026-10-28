"""The features closed after the second audit.

Additive migrations, honest version status and counts, best-of-N candidates,
sampling and synthesis-step overrides, and resume of a finished-but-unrecorded
yue2 run.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from songforge.enums import CotMode
from songforge.runners.base import GenerationRequest
from songforge.runners.yue2 import DEFAULT_COMMAND_TEMPLATE, Yue2CliRunner, Yue2Config

from .test_backend_audit import generate
from .test_features import make_project, settle


def yue2_runner(template: str = DEFAULT_COMMAND_TEMPLATE) -> Yue2CliRunner:
    return Yue2CliRunner(Yue2Config(
        executable="yue2", python_executable="", model_path="m-a-p/YuE2-3B",
        vae_path="standard", gpu_index=0, memory_budget_gib=11, offload_ar=False,
        backend_mode="torch-eager", quantization="none", offline_mode=True,
        command_template=template, memory_efficient_attention=False,
    ))


# ------------------------------------------------------------------ migration


def test_missing_columns_are_added_to_an_existing_database(runtime_dir: Path) -> None:
    """create_all never alters a table; an older database must still load."""
    from songforge import db
    from songforge.config import get_config

    get_config().ensure_dirs()
    path = get_config().database_dir / "songforge.db"
    with sqlite3.connect(path) as con:
        # A versions table from before result/is_plan_only/candidate_group.
        con.execute(
            "CREATE TABLE versions (id VARCHAR PRIMARY KEY, project_id VARCHAR, number INTEGER, "
            "title VARCHAR, created_at DATETIME)"
        )
        con.execute(
            "INSERT INTO versions (id, project_id, number, title, created_at) "
            "VALUES ('v1', 'p1', 1, 'old', '2026-01-01')"
        )

    db.init_db()

    with sqlite3.connect(path) as con:
        columns = {row[1] for row in con.execute("PRAGMA table_info(versions)")}
        row = con.execute(
            "SELECT title, is_plan_only, candidate_group, result FROM versions"
        ).fetchone()
    assert {"result", "is_plan_only", "candidate_group", "is_primary"} <= columns
    assert row == ("old", 0, None, "{}")


# --------------------------------------------------- version status and counts


def test_failed_take_is_labelled_and_not_counted(client, monkeypatch) -> None:
    from songforge.runners import mock as mock_module
    from songforge.runners.base import RunnerError

    project_id = make_project(client)
    real_generate = mock_module.MockRunner.generate

    async def failing(self, request, output_dir):
        raise RunnerError("simulated failure", exit_code=1)
        yield  # pragma: no cover

    monkeypatch.setattr(mock_module.MockRunner, "generate", failing)
    settle(client, generate(client, project_id))
    monkeypatch.setattr(mock_module.MockRunner, "generate", real_generate)

    detail = client.get(f"/api/projects/{project_id}").json()
    assert [v["status"] for v in detail["versions"]] == ["failed"]
    assert detail["version_count"] == 0
    assert detail["latest_version"] is None


def test_project_reports_primary_duration(client, fast_mock) -> None:
    project_id = make_project(client)
    settle(client, generate(client, project_id))
    detail = client.get(f"/api/projects/{project_id}").json()
    primary = next(v for v in detail["versions"] if v["is_primary"])
    assert detail["duration_seconds"] == primary["duration_seconds"]
    assert detail["duration_seconds"] and detail["duration_seconds"] > 0

    listed = client.get("/api/projects").json()["items"]
    assert next(p for p in listed if p["id"] == project_id)["duration_seconds"] > 0


# ------------------------------------------------------------------ candidates


def test_candidates_queue_distinct_seeds_in_one_group(client, fast_mock) -> None:
    project_id = make_project(client)
    response = client.post(
        f"/api/projects/{project_id}/generate",
        json={"candidates": 3, "seed_mode": "manual", "seed": 1234},
    )
    assert response.status_code == 202, response.text
    body = response.json()
    assert len(body["sibling_job_ids"]) == 2

    for job_id in [body["id"], *body["sibling_job_ids"]]:
        assert settle(client, job_id)["status"] == "completed"

    versions = client.get(f"/api/projects/{project_id}").json()["versions"]
    assert len(versions) == 3
    groups = {v["candidate_group"] for v in versions}
    assert len(groups) == 1 and None not in groups
    seeds = [v["seed"] for v in versions]
    assert seeds[0] == 1234, "the first take honours the chosen seed"
    assert len(set(seeds)) == 3, "every take must differ"


def test_candidate_count_is_bounded(client) -> None:
    project_id = make_project(client)
    response = client.post(f"/api/projects/{project_id}/generate", json={"candidates": 9})
    assert response.status_code == 422


def test_single_take_has_no_group(client, fast_mock) -> None:
    project_id = make_project(client)
    settle(client, generate(client, project_id))
    version = client.get(f"/api/projects/{project_id}").json()["versions"][0]
    assert version["candidate_group"] is None


# ------------------------------------------------------- sampling overrides


def test_overrides_reach_the_yue2_files_and_flags(tmp_path: Path) -> None:
    runner = yue2_runner()
    assert runner.capabilities.supports_sampling_overrides is True
    request = GenerationRequest(
        project_id="p", version_number=2, style_prompt="lofi", lyrics="la",
        cot=CotMode.FULL, seed=5,
        extra={
            "abc_sampling": {"temperature": 0.6},
            "semantic_sampling": {"max_tokens": 4000},
            "ode_steps": 24,
        },
    )
    argv = runner.build_command(request, tmp_path)
    assert f"--request={tmp_path / 'sampling.json'}" in argv
    assert f"--config={tmp_path / 'generation-config.json'}" in argv


def test_no_overrides_means_no_override_flags(tmp_path: Path) -> None:
    argv = yue2_runner().build_command(
        GenerationRequest(project_id="p", version_number=1, style_prompt="s", lyrics="l"),
        tmp_path,
    )
    assert not any(arg.startswith(("--request", "--config", "--resume")) for arg in argv)


def test_template_without_override_placeholders_reports_no_support() -> None:
    legacy = DEFAULT_COMMAND_TEMPLATE.replace(
        " --request={request_file} --config={config_file}", ""
    )
    assert yue2_runner(legacy).capabilities.supports_sampling_overrides is False


def test_overrides_are_refused_when_the_runner_cannot_apply_them(client) -> None:
    """The mock runner has no override support: refuse, never silently ignore."""
    project_id = make_project(client)
    response = client.post(
        f"/api/projects/{project_id}/generate",
        json={"semantic_sampling": {"temperature": 0.8}},
    )
    assert response.status_code == 422
    assert "override" in response.json()["detail"]


@pytest.mark.parametrize("sampling", [
    {"temperature": 6},
    {"top_p": 0},
    {"top_k": 0},
    {"penalty_window": 101},
    {"min_tokens": 500, "max_tokens": 100},
])
def test_sampling_bounds_match_yue2(client, sampling) -> None:
    project_id = make_project(client)
    response = client.post(
        f"/api/projects/{project_id}/generate", json={"abc_sampling": sampling}
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------- resume


def test_resume_is_only_offered_for_a_finished_run(tmp_path: Path) -> None:
    runner = yue2_runner()
    request = GenerationRequest(project_id="p", version_number=4, style_prompt="s", lyrics="l")
    run_dir = tmp_path / "runs" / runner.run_id(request)
    run_dir.mkdir(parents=True)
    (run_dir / "request.json").write_text("{}")

    assert "cannot continue a partial one" in runner.can_resume(request, tmp_path)

    (run_dir / "result.json").write_text(json.dumps({"audio_seconds": 1.0}))
    assert "audio" in runner.can_resume(request, tmp_path)

    (run_dir / "audio.flac").write_bytes(b"fLaC")
    assert runner.can_resume(request, tmp_path) is None

    plan = GenerationRequest(
        project_id="p", version_number=4, style_prompt="s", lyrics="l", stage="plan"
    )
    assert "score-only" in runner.can_resume(plan, tmp_path)


def test_resume_flag_is_passed_when_requested(tmp_path: Path) -> None:
    request = GenerationRequest(
        project_id="p", version_number=1, style_prompt="s", lyrics="l",
        extra={"resume": True},
    )
    assert "--resume" in yue2_runner().build_command(request, tmp_path)


def test_resume_endpoint_refuses_what_it_cannot_honour(client, fast_mock) -> None:
    project_id = make_project(client)
    job_id = generate(client, project_id)
    settle(client, job_id)

    completed = client.post(f"/api/jobs/{job_id}/resume")
    assert completed.status_code == 409  # not interrupted

    from sqlmodel import Session

    from songforge.db import get_engine
    from songforge.enums import JobStatus
    from songforge.models import Job

    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        job.status = JobStatus.INTERRUPTED
        session.add(job)
        session.commit()

    refused = client.post(f"/api/jobs/{job_id}/resume")
    assert refused.status_code == 409
    assert "cannot resume" in refused.json()["detail"]


# ------------------------------------------------------------ library tools


def test_vocal_filter_matches_a_substring(client) -> None:
    alto = make_project(client, vocal_preference="warm female alto")
    make_project(client, vocal_preference="gritty male baritone")
    items = client.get("/api/projects?vocal=ALTO").json()["items"]
    assert [item["id"] for item in items] == [alto]


def test_bulk_export_puts_each_project_in_its_own_folder(client) -> None:
    import io
    import zipfile

    from songforge import storage

    first = make_project(client, title="Same Title")
    second = make_project(client, title="Same Title")
    for project_id in (first, second):
        (storage.project_dir(project_id, create=True) / "lyrics-v1.txt").write_text("la")

    response = client.get(f"/api/projects/bulk/export.zip?ids={first}&ids={second}")
    assert response.status_code == 200, response.text
    names = zipfile.ZipFile(io.BytesIO(response.content)).namelist()
    folders = {name.split("/")[0] for name in names}
    assert len(folders) == 2, names
    assert all(name.endswith("lyrics-v1.txt") or "/" in name for name in names)


def test_bulk_export_rejects_an_unknown_project(client) -> None:
    project_id = make_project(client)
    response = client.get(f"/api/projects/bulk/export.zip?ids={project_id}&ids=nope")
    assert response.status_code == 404


def test_single_export_still_works_beside_the_bulk_route(client) -> None:
    project_id = make_project(client)
    assert client.get(f"/api/projects/{project_id}/export.zip").status_code == 200


# ------------------------------------------------------------- runner readiness


def _config(tmp_path: Path, **overrides) -> Yue2Config:
    model = tmp_path / "model"
    model.mkdir(exist_ok=True)
    values = dict(
        executable="", python_executable="", model_path=str(model), vae_path="standard",
        gpu_index=0, memory_budget_gib=11, offload_ar=False, backend_mode="torch-eager",
        quantization="none", offline_mode=True, command_template=DEFAULT_COMMAND_TEMPLATE,
        memory_efficient_attention=False,
    )
    values.update(overrides)
    return Yue2Config(**values)


def test_unresolvable_yue2_command_is_not_ready(tmp_path: Path, monkeypatch) -> None:
    """A bare 'yue2' off PATH used to report ready and fail only at Generate."""
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    runner = Yue2CliRunner(_config(tmp_path, executable="yue2"))
    issues = runner.template_issues()
    assert any("cannot be found" in issue and "yue2 command" in issue for issue in issues)


def test_missing_absolute_yue2_path_is_not_ready(tmp_path: Path) -> None:
    runner = Yue2CliRunner(_config(tmp_path, executable=str(tmp_path / "missing" / "yue2.exe")))
    assert any("cannot be found" in issue for issue in runner.template_issues())


def test_existing_yue2_path_is_ready(tmp_path: Path) -> None:
    exe = tmp_path / "yue2.exe"
    exe.write_bytes(b"")
    runner = Yue2CliRunner(_config(tmp_path, executable=str(exe)))
    assert runner.template_issues() == []


def test_blank_yue2_command_uses_the_interpreter(tmp_path: Path) -> None:
    import sys

    runner = Yue2CliRunner(_config(tmp_path, python_executable=sys.executable))
    assert runner.template_issues() == []
    argv = runner.build_command(
        GenerationRequest(project_id="p", version_number=1, style_prompt="s", lyrics="l"),
        tmp_path,
    )
    assert argv[:3] == [sys.executable, "-m", "yue2.cli"]


# ------------------------------------------------------------- stage parsing


def test_real_run_reports_stages_in_order_and_never_regresses() -> None:
    """Replays the log of a real 44-second render on the RTX 3060.

    Its last yue2 line is the JSON summary containing "abc", which used to
    move a finished run back to Planning.
    """
    from songforge.enums import JobStage

    log = Path(__file__).parent / "fixtures" / "yue2-real-generation.log"
    stage = JobStage.LOADING_MODEL
    seen = [stage]
    for line in log.read_text(encoding="utf-8").splitlines():
        stage = Yue2CliRunner.advance_stage(stage, line)
        if stage is not seen[-1]:
            seen.append(stage)

    assert seen == [
        JobStage.LOADING_MODEL, JobStage.PLANNING, JobStage.GENERATING, JobStage.DECODING,
    ]
    summary = next(line for line in log.read_text(encoding="utf-8").splitlines()
                   if line.startswith('{"status"'))
    assert Yue2CliRunner.advance_stage(JobStage.DECODING, summary) is JobStage.DECODING


# ------------------------------------------------------- yue2 text encodings


def test_yue2_runs_in_utf8_mode() -> None:
    """Without it yue2 writes cp1252 JSON and crashes on Chinese lyrics."""
    assert yue2_runner()._environment()["PYTHONUTF8"] == "1"


def test_cp1252_failure_report_still_explains_the_failure(tmp_path: Path) -> None:
    """The real crash: a curly apostrophe written as byte 0x92 hid yue2's error."""
    report = {"status": "failed", "type": "ValueError",
              "reason": "Prefix plus requested generation budget exceeds context",
              "request": {"lyrics": "don\u2019t let go"}}
    (tmp_path / "failure.json").write_bytes(json.dumps(report, ensure_ascii=False).encode("cp1252"))

    reason = Yue2CliRunner._failure_reason(tmp_path, ["tail"], 1)
    assert reason.startswith("ValueError: this song is too long")
    assert "Prefix plus requested generation budget exceeds context" in reason


def test_unreadable_failure_report_falls_back_to_the_log(tmp_path: Path) -> None:
    (tmp_path / "failure.json").write_text('["not", "an", "object"]', encoding="utf-8")
    reason = Yue2CliRunner._failure_reason(tmp_path, ["last line of output"], 3)
    assert "exited with code 3" in reason and "last line of output" in reason


def test_cp1252_result_and_score_are_read(tmp_path: Path) -> None:
    result = {"audio_seconds": 12.5, "sample_rate": 48000,
              "request": {"lyrics": "caf\u00e9 \u2019"}, "truncated": {"abc": False}}
    (tmp_path / "result.json").write_bytes(json.dumps(result, ensure_ascii=False).encode("cp1252"))
    receipt = Yue2CliRunner._read_result(tmp_path)
    assert receipt["duration"] == 12.5 and receipt["truncated"] == {"abc": False}

    from songforge.runners.yue2 import _read_yue2_text
    (tmp_path / "score.abc").write_bytes("T:Caf\u00e9\n".encode("cp1252"))
    assert _read_yue2_text(tmp_path / "score.abc") == "T:Caf\u00e9\n"


def test_out_of_memory_advice_points_the_right_way(tmp_path: Path) -> None:
    """yue2 caps memory at budget - 2 GiB: lowering the budget makes OOM worse."""
    report = {"type": "OutOfMemoryError",
              "reason": "CUDA out of memory. Tried to allocate 394.00 MiB. 9.00 GiB allowed"}
    (tmp_path / "failure.json").write_text(json.dumps(report), encoding="utf-8")
    reason = Yue2CliRunner._failure_reason(tmp_path, [], 1)
    assert "raise the budget" in reason
    assert "Lower the memory budget" not in reason


# ------------------------------------------------ memory-efficient attention


def test_launcher_is_used_by_default_with_the_environment_python(tmp_path: Path) -> None:
    from songforge.runners.yue2 import LAUNCHER

    scripts = tmp_path / "venv" / "Scripts"
    scripts.mkdir(parents=True)
    (scripts / "yue2.exe").write_bytes(b"")
    (scripts / "python.exe").write_bytes(b"")
    runner = Yue2CliRunner(Yue2Config(executable=str(scripts / "yue2.exe"), model_path="D:/m"))
    argv = runner.build_command(
        GenerationRequest(project_id="p", version_number=1, style_prompt="s", lyrics="l"), tmp_path
    )
    assert argv[:3] == [str(scripts / "python.exe"), str(LAUNCHER), "generate"]
    assert LAUNCHER.is_file()


def test_launcher_prefers_the_configured_interpreter(tmp_path: Path) -> None:
    from songforge.runners.yue2 import LAUNCHER

    runner = Yue2CliRunner(Yue2Config(python_executable="D:/env/python.exe", model_path="D:/m"))
    argv = runner.build_command(
        GenerationRequest(project_id="p", version_number=1, style_prompt="s", lyrics="l"), tmp_path
    )
    assert argv[:2] == ["D:/env/python.exe", str(LAUNCHER)]


def test_launcher_without_an_interpreter_is_explained() -> None:
    from songforge.runners.yue2 import ExecutableNotAllowed

    runner = Yue2CliRunner(Yue2Config(executable="yue2", model_path="D:/m"))
    with pytest.raises(ExecutableNotAllowed, match="Python interpreter"):
        runner.build_command(
            GenerationRequest(project_id="p", version_number=1, style_prompt="s", lyrics="l"),
            Path("out"),
        )


@pytest.mark.parametrize("field", ["executable", "python_executable"])
@pytest.mark.parametrize("attention", [True, False])
@pytest.mark.parametrize("path", ["\\\\attacker\\share\\{name}", "//attacker/share/{name}"])
def test_network_paths_are_refused(field: str, attention: bool, path: str) -> None:
    from songforge.runners.yue2 import ExecutableNotAllowed

    name = "yue2.exe" if field == "executable" else "python.exe"
    config = Yue2Config(model_path="D:/m", memory_efficient_attention=attention,
                        **{field: path.format(name=name)})
    with pytest.raises(ExecutableNotAllowed, match="network path"):
        Yue2CliRunner(config).build_command(
            GenerationRequest(project_id="p", version_number=1, style_prompt="s", lyrics="l"),
            Path("out"),
        )


def test_disallowed_program_is_refused_even_with_the_launcher() -> None:
    from songforge.runners.yue2 import ExecutableNotAllowed

    runner = Yue2CliRunner(Yue2Config(executable=r"C:\Windows\System32\cmd.exe",
                                      python_executable="D:/env/python.exe", model_path="D:/m"))
    with pytest.raises(ExecutableNotAllowed, match="yue2 CLI"):
        runner.build_command(
            GenerationRequest(project_id="p", version_number=1, style_prompt="s", lyrics="l"),
            Path("out"),
        )


def test_launcher_rewrites_only_long_grouped_attention() -> None:
    """Exercised on CPU: the rewrite condition requires CUDA, so nothing changes here,
    and the launcher module must import without torch installed in this venv."""
    import importlib

    module = importlib.import_module("songforge.runners.yue2_launch")
    assert module.MIN_QUERY_LENGTH >= 2


def test_memory_budget_check_reports_the_real_cap() -> None:
    from songforge.runners.yue2 import memory_budget_check

    full = memory_budget_check(12, 11.99)  # a 12 GB card reports slightly under 12
    assert full["ok"] and "9.99 GiB" in full["detail"] and "raising" not in full["detail"]
    low = memory_budget_check(11, 11.99)
    assert low["ok"] and "9.00 GiB" in low["detail"] and "raising the budget to 12" in low["detail"]
    assert memory_budget_check(2, 11.99)["ok"] is False


def test_launcher_imports_the_real_yue2_not_the_runner_module(tmp_path: Path) -> None:
    """Run as a script, the launcher's own folder (holding runners/yue2.py) came
    first on sys.path and shadowed the installed yue2 package."""
    import subprocess
    import sys

    from songforge.runners.yue2 import LAUNCHER

    fake = tmp_path / "site"
    (fake / "yue2").mkdir(parents=True)
    (fake / "yue2" / "__init__.py").write_text("", encoding="utf-8")
    (fake / "yue2" / "cli.py").write_text(
        "def main(argv=None):\n    print('REAL-YUE2', argv)\n    return 7\n",
        encoding="utf-8",
    )
    (fake / "torch" / "nn").mkdir(parents=True)
    (fake / "torch" / "__init__.py").write_text("from . import nn\n", encoding="utf-8")
    (fake / "torch" / "nn" / "__init__.py").write_text("from . import functional\n", encoding="utf-8")
    (fake / "torch" / "nn" / "functional.py").write_text(
        "def scaled_dot_product_attention(*a, **k):\n    return None\n", encoding="utf-8"
    )
    env = {**__import__("os").environ, "PYTHONPATH": str(fake)}
    done = subprocess.run([sys.executable, str(LAUNCHER), "doctor", "--offline"],
                          capture_output=True, text=True, env=env, timeout=60)
    assert done.returncode == 7, done.stderr
    assert "REAL-YUE2 ['doctor', '--offline']" in done.stdout
    assert "[SongForge] attention: memory-efficient" in done.stderr
