"""Feature coverage: the YuE2-specific capabilities exposed through the API.

These guard the differentiators identified in the feature audit - the plan/edit
/render flow, honest instrumental handling, the run receipt, and the artifacts
that make a version reproducible.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from songforge.enums import CotMode
from songforge.runners.base import GenerationRequest
from songforge.runners.yue2 import Yue2CliRunner, Yue2Config, compose_style

from .conftest import needs_ffmpeg, wait_for


def make_project(client, **overrides) -> str:
    payload = {
        "title": "Feature Subject",
        "style_prompt": "neo-soul, rhodes, brushed drums",
        "lyrics": "[Verse]\nsomething to sing",
    }
    payload.update(overrides)
    response = client.post("/api/projects", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["id"]


def settle(client, job_id: str, timeout: float = 60.0) -> dict:
    assert wait_for(
        lambda: client.get(f"/api/jobs/{job_id}").json()["status"]
        in {"completed", "failed", "cancelled", "interrupted"},
        timeout=timeout,
    ), client.get(f"/api/jobs/{job_id}").json()
    return client.get(f"/api/jobs/{job_id}").json()


# ------------------------------------------------------- instrumental is honest


def test_instrumental_is_composed_into_the_style() -> None:
    """yue2 has no instrumental flag, so the intent must reach the style text."""
    request = GenerationRequest(
        project_id="p", version_number=1,
        style_prompt="ambient guitar", lyrics="", instrumental=True,
    )
    style = compose_style(request)
    assert "ambient guitar" in style
    assert "instrumental" in style.lower()
    assert "no vocals" in style.lower()


def test_instrumental_drops_contradictory_vocal_wording() -> None:
    request = GenerationRequest(
        project_id="p", version_number=1,
        style_prompt="warm male vocal, soft piano",
        lyrics="", instrumental=True, vocal_preference="breathy female vocal",
    )
    style = compose_style(request)
    assert "instrumental" in style.lower()
    assert "vocal," not in style.lower().replace("no vocals,", "")


def test_language_and_vocal_reach_the_model() -> None:
    """Both were previously collected and silently discarded."""
    request = GenerationRequest(
        project_id="p", version_number=1,
        style_prompt="bossa nova", lyrics="[Verse]\nx",
        language="Portuguese", vocal_preference="soft female vocal",
    )
    style = compose_style(request)
    assert "Portuguese" in style
    assert "soft female vocal" in style

    runner = Yue2CliRunner(Yue2Config(memory_efficient_attention=False, executable="yue2.exe", model_path="D:/m"))
    argv = runner.build_command(request, Path("out"))
    style_arg = next(a for a in argv if a.startswith("--style="))
    assert "Portuguese" in style_arg and "soft female vocal" in style_arg


def test_instrumental_generates_without_lyrics(client, fast_mock) -> None:
    project_id = make_project(client, lyrics="")
    response = client.post(f"/api/projects/{project_id}/generate",
                           json={"instrumental": True})
    assert response.status_code == 202, response.text
    assert settle(client, response.json()["id"])["status"] == "completed"


# -------------------------------------------------------------- score + planning


def test_score_with_planning_off_is_rejected(client) -> None:
    """yue2/protocol.py raises for this; catch it before the model loads."""
    project_id = make_project(client)
    client.put(f"/api/projects/{project_id}/score",
               json={"score_abc": "X:1\nT:t\nK:C\nCDEF|"})
    response = client.post(f"/api/projects/{project_id}/generate", json={"cot": "off"})
    assert response.status_code == 422
    assert "planning" in response.json()["detail"].lower()


def test_plan_stage_produces_a_score_and_no_audio(client, fast_mock) -> None:
    """The plan/edit/render flow: stop after the score, before GPU-costly audio."""
    project_id = make_project(client)
    response = client.post(f"/api/projects/{project_id}/generate",
                           json={"stage": "plan", "cot": "full"})
    assert response.status_code == 202, response.text
    assert settle(client, response.json()["id"])["status"] == "completed"

    version = client.get(f"/api/projects/{project_id}/versions").json()[0]
    assert version["is_plan_only"] is True
    assert version["score_abc"] and version["score_abc"].startswith("X:1")
    assert version["has_flac"] is False

    # The planned score lands in the draft, ready to edit.
    project = client.get(f"/api/projects/{project_id}").json()
    assert project["score_abc"] == version["score_abc"]
    # And it is downloadable.
    assert client.get(
        f"/api/projects/{project_id}/download/score?version=1"
    ).status_code == 200


def test_plan_then_render_uses_the_edited_score(client, fast_mock) -> None:
    project_id = make_project(client)
    planned = client.post(f"/api/projects/{project_id}/generate",
                          json={"stage": "plan"}).json()
    settle(client, planned["id"])

    edited = "X:1\nT:Edited\nM:4/4\nL:1/8\nK:F\nF G A c | c A G F |]\n"
    client.put(f"/api/projects/{project_id}/score", json={"score_abc": edited})

    rendered = client.post(f"/api/projects/{project_id}/generate",
                           json={"stage": "audio", "cot": "full"})
    assert rendered.status_code == 202, rendered.text
    assert settle(client, rendered.json()["id"])["status"] == "completed"

    versions = client.get(f"/api/projects/{project_id}/versions").json()
    assert len(versions) == 2
    assert versions[1]["is_plan_only"] is False
    # The rendered version was built from the edited score.
    assert versions[1]["request"]["score_abc"] == edited


def test_plan_stage_requires_planning_to_be_on(client) -> None:
    project_id = make_project(client)
    response = client.post(f"/api/projects/{project_id}/generate",
                           json={"stage": "plan", "cot": "off"})
    assert response.status_code == 422
    assert "planning" in response.json()["detail"].lower()


def test_capabilities_declare_the_plan_stage(client) -> None:
    body = client.get("/api/settings").json()
    assert body["capabilities"]["supports_plan_stage"] is True

    yue2 = client.put("/api/settings", json={
        "runner_kind": "yue2_cli", "model_path": "D:/models/YuE2-3B",
        "python_executable": "D:/venv-yue2/Scripts/python.exe",
    }).json()
    assert yue2["capabilities"]["supports_plan_stage"] is True
    assert yue2["capabilities"]["supports_instrumental"] is True
    assert "--stage=" in " ".join(yue2["command_preview"])


# ------------------------------------------------------------------ seed range


def test_seed_accepts_the_models_full_range(client, fast_mock) -> None:
    """yue2 allows [0, 2**63); the API must not be narrower."""
    project_id = make_project(client)
    big_seed = 2**62 + 7
    response = client.post(f"/api/projects/{project_id}/generate",
                           json={"seed_mode": "manual", "seed": big_seed})
    assert response.status_code == 202, response.text
    settle(client, response.json()["id"])
    assert client.get(f"/api/projects/{project_id}/versions").json()[0]["seed"] == big_seed


def test_seed_above_the_models_range_is_rejected(client) -> None:
    project_id = make_project(client)
    response = client.post(f"/api/projects/{project_id}/generate",
                           json={"seed_mode": "manual", "seed": 2**63})
    assert response.status_code == 422


def test_cfg_scale_accepts_the_models_full_range(client, fast_mock) -> None:
    """protocol.py allows 0-20; the API previously capped at 10."""
    project_id = make_project(client)
    response = client.post(f"/api/projects/{project_id}/generate",
                           json={"cfg_scale": 15.0})
    assert response.status_code == 202, response.text
    assert client.post(f"/api/projects/{project_id}/generate",
                       json={"cfg_scale": 21.0}).status_code == 422


# --------------------------------------------------------------- run receipt


def test_version_carries_a_result_receipt(client, fast_mock) -> None:
    """The receipt column exists and survives to the API even when empty."""
    project_id = make_project(client)
    job = client.post(f"/api/projects/{project_id}/generate", json={}).json()
    settle(client, job["id"])
    version = client.get(f"/api/projects/{project_id}/versions").json()[0]
    assert isinstance(version["result"], dict)


def test_yue2_receipt_is_parsed_from_result_json(tmp_path: Path) -> None:
    """Parsed against the real key names from an actual run."""
    import json

    run_dir = tmp_path / "v1"
    run_dir.mkdir()
    (run_dir / "result.json").write_text(json.dumps({
        "status": "complete",
        "sample_rate": 48000,
        "audio_seconds": 72.078,
        "identity": "abc123",
        "truncated": {"abc": False, "semantic": True},
        "weights": {"mot": {"sha256": "deadbeef"}},
        "timing": {"e2e_seconds": 220.4, "output_tps": 17.2},
    }), encoding="utf-8")

    receipt = Yue2CliRunner._read_result(run_dir)
    assert receipt["duration"] == pytest.approx(72.078)
    assert receipt["sample_rate"] == 48000
    assert receipt["identity"] == "abc123"
    assert receipt["truncated"]["semantic"] is True
    assert receipt["timing"]["output_tps"] == pytest.approx(17.2)


def test_missing_result_json_degrades_quietly(tmp_path: Path) -> None:
    receipt = Yue2CliRunner._read_result(tmp_path)
    assert receipt["duration"] is None and receipt["identity"] is None


# ------------------------------------------------------------ version delete


@needs_ffmpeg
def test_delete_one_version(client, fast_mock) -> None:
    project_id = make_project(client)
    for _ in range(2):
        job = client.post(f"/api/projects/{project_id}/generate", json={}).json()
        settle(client, job["id"])

    # v1 is primary, so it is protected; v2 can go.
    assert client.delete(
        f"/api/projects/{project_id}/versions/1?confirm=true"
    ).status_code == 409
    assert client.delete(f"/api/projects/{project_id}/versions/2").status_code == 400
    assert client.delete(
        f"/api/projects/{project_id}/versions/2?confirm=true"
    ).status_code == 204

    numbers = [v["number"] for v in client.get(
        f"/api/projects/{project_id}/versions").json()]
    assert numbers == [1]
    # The remaining version's audio is untouched.
    assert client.get(f"/api/projects/{project_id}/download/flac?version=1").status_code == 200


def test_delete_unknown_version(client) -> None:
    project_id = make_project(client)
    assert client.delete(
        f"/api/projects/{project_id}/versions/9?confirm=true"
    ).status_code == 404


def test_style_tags_lead_with_language_and_voice() -> None:
    """YuE2 weights earlier tags more heavily, so these must come first."""
    request = GenerationRequest(
        project_id="p", version_number=1,
        style_prompt="indie folk, fingerpicked guitar, 92 BPM",
        lyrics="[Verse]\nx", language="Dutch", vocal_preference="warm female vocal",
    )
    assert compose_style(request) == (
        "Dutch, warm female vocal, indie folk, fingerpicked guitar, 92 BPM"
    )


# ------------------------------------------------------- guidance defaults


def test_app_default_guidance_is_not_forced_onto_planning_off() -> None:
    """1.0 disables guidance; yue2 uses 1.01 without planning, so send nothing."""
    from types import SimpleNamespace

    from songforge.api.projects import _native_cfg_scale, _resolved_cfg_scale

    assert _native_cfg_scale(CotMode.OFF) == 1.01
    assert _native_cfg_scale(CotMode.FULL) == 1.0

    caps = SimpleNamespace(supports_cfg_scale=True)
    blank = SimpleNamespace(cfg_scale=None)

    # The shipped default only restates yue2's own, so nothing is sent and each
    # mode keeps its native value.
    assert _resolved_cfg_scale(blank, SimpleNamespace(default_cfg_scale=1.0), caps) is None
    # A changed default is a real preference.
    assert _resolved_cfg_scale(blank, SimpleNamespace(default_cfg_scale=1.5), caps) == 1.5
    # An explicit value is always honoured, including an explicit 1.0.
    assert _resolved_cfg_scale(SimpleNamespace(cfg_scale=1.0),
                               SimpleNamespace(default_cfg_scale=1.5), caps) == 1.0
    # A runner without guidance support never receives one.
    assert _resolved_cfg_scale(blank, SimpleNamespace(default_cfg_scale=1.5),
                               SimpleNamespace(supports_cfg_scale=False)) is None
