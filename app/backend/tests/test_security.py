"""Security regression tests.

These encode findings from the Phase 1 security audit. The runner configuration
is reachable by anyone who can reach the API, so it must not be usable to run
arbitrary programs or to smuggle extra arguments into the yue2 command line.
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from songforge.runners.base import GenerationRequest
from songforge.runners.yue2 import (
    DEFAULT_COMMAND_TEMPLATE,
    ExecutableNotAllowed,
    TemplateNotAllowed,
    Yue2CliRunner,
    Yue2Config,
)


def make_request(**overrides) -> GenerationRequest:
    base = {
        "project_id": "p", "version_number": 1,
        "style_prompt": "indie pop", "lyrics": "[Verse]\nwords",
    }
    base.update(overrides)
    return GenerationRequest(**base)


# ----------------------------------------------------- executable is constrained


@pytest.mark.parametrize(
    "executable",
    [
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Windows\System32\cmd.exe",
        "/bin/sh",
        "curl.exe",
        "notepad",
    ],
)
def test_arbitrary_executable_is_refused(executable: str) -> None:
    runner = Yue2CliRunner(Yue2Config(memory_efficient_attention=False, executable=executable, model_path="D:/model"))
    with pytest.raises(ExecutableNotAllowed):
        runner.build_command(make_request(), Path("out"))
    assert any("yue2 CLI" in issue for issue in runner.template_issues())


def test_non_python_interpreter_is_refused() -> None:
    runner = Yue2CliRunner(
        Yue2Config(memory_efficient_attention=False, python_executable=r"C:\Windows\System32\cmd.exe", model_path="D:/model")
    )
    with pytest.raises(ExecutableNotAllowed):
        runner.build_command(make_request(), Path("out"))


def test_yue2_executable_is_accepted() -> None:
    runner = Yue2CliRunner(Yue2Config(memory_efficient_attention=False, executable="D:/venv/Scripts/yue2.exe",
                                      model_path="D:/model"))
    argv = runner.build_command(make_request(), Path("out"))
    assert argv[0] == "D:/venv/Scripts/yue2.exe"
    assert argv[1] == "generate"


def test_python_module_invocation_is_accepted() -> None:
    runner = Yue2CliRunner(Yue2Config(memory_efficient_attention=False, python_executable="D:/venv/Scripts/python.exe",
                                      model_path="D:/model"))
    argv = runner.build_command(make_request(), Path("out"))
    assert argv[:3] == ["D:/venv/Scripts/python.exe", "-m", "yue2.cli"]


# -------------------------------------------------------- template is constrained


@pytest.mark.parametrize(
    "template",
    [
        # Extra command appended, which a shell would run and an argv list must not carry.
        "generate --model={model} --output={output} ; Set-Content -Path C:/pwned.txt",
        "generate --model={model} --output={output} && calc.exe",
        "generate --model={model} --output={output} | cmd",
        # Bare words become their own argv elements.
        "generate --model={model} --output={output} --style extra-word",
        # An unknown flag is not part of the yue2 interface.
        "generate --model={model} --output={output} --exec=evil",
        # Wrong subcommand entirely.
        "shell --model={model} --output={output}",
    ],
)
def test_hostile_template_is_refused(template: str) -> None:
    runner = Yue2CliRunner(
        Yue2Config(memory_efficient_attention=False, executable="yue2.exe", model_path="D:/model",
                   command_template=template)
    )
    with pytest.raises(TemplateNotAllowed):
        runner.build_command(make_request(), Path("out"))
    assert runner.template_issues()


def test_bare_value_placeholder_is_refused() -> None:
    """A bare {style} would become its own argv element and could pose as a flag."""
    runner = Yue2CliRunner(
        Yue2Config(memory_efficient_attention=False, executable="yue2.exe", model_path="D:/model",
                   command_template="generate --model={model} --output={output} {style}")
    )
    with pytest.raises(TemplateNotAllowed):
        runner.build_command(make_request(), Path("out"))


def test_unknown_placeholder_is_refused() -> None:
    runner = Yue2CliRunner(
        Yue2Config(memory_efficient_attention=False, executable="yue2.exe", model_path="D:/model",
                   command_template="generate --model={model} --output={output} --id={secret}")
    )
    with pytest.raises(TemplateNotAllowed):
        runner.build_command(make_request(), Path("out"))


def test_flag_placeholders_are_allowed_bare() -> None:
    """{offline} and {offload_ar} expand to whole flags, so they may stand alone."""
    runner = Yue2CliRunner(
        Yue2Config(memory_efficient_attention=False, executable="yue2.exe", model_path="D:/model", offline_mode=True,
                   offload_ar=True,
                   command_template="generate --model={model} --output={output} "
                                    "{offline} {offload_ar}")
    )
    argv = runner.build_command(make_request(), Path("out"))
    assert "--offline" in argv and "--offload-ar" in argv


# ----------------------------------------------- request text cannot add arguments


@pytest.mark.parametrize(
    "hostile",
    [
        "--model=C:/attacker/evil",
        "--output=C:/Windows",
        "; calc.exe",
        "$(whoami)",
        "`whoami`",
        "--config=C:/evil.json",
    ],
)
def test_request_text_stays_inside_its_argument(hostile: str) -> None:
    """Hostile prompt text must remain one argv element attached to its flag."""
    runner = Yue2CliRunner(Yue2Config(memory_efficient_attention=False, executable="yue2.exe", model_path="D:/model"))
    argv = runner.build_command(make_request(style_prompt=hostile), Path("out"))

    style_args = [a for a in argv if a.startswith("--style=")]
    assert style_args == [f"--style={hostile}"]
    # The hostile text never becomes a standalone element.
    assert hostile not in argv
    # And it did not displace the real model argument.
    assert "--model=D:/model" in argv


def test_default_template_is_valid() -> None:
    runner = Yue2CliRunner(Yue2Config(memory_efficient_attention=False, executable="yue2.exe", model_path="D:/model",
                                      command_template=DEFAULT_COMMAND_TEMPLATE))
    argv = runner.build_command(make_request(), Path("out"))
    assert "generate" in argv
    # Paths to this machine's model and CLI are environmental, not template faults.
    assert all(
        "does not exist" in issue or "cannot be found" in issue
        for issue in runner.template_issues()
    )


# --------------------------------------------------------------- through the API


def test_api_refuses_to_generate_with_a_hostile_runner(client, tmp_path: Path) -> None:
    """The end-to-end version of the audit's RCE probe."""
    marker = tmp_path / "pwned.txt"
    model = tmp_path / "model"
    model.mkdir()
    powershell = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    if not powershell.exists():
        pytest.skip("PowerShell not present on this host")

    saved = client.put("/api/settings", json={
        "runner_kind": "yue2_cli",
        "yue2_executable": str(powershell),
        "model_path": str(model),
        "command_template": (
            f"generate --model={{model}} --output={{output}} ; "
            f"Set-Content -Path '{marker}' -Value PWNED"
        ),
    })
    assert saved.status_code == 200
    # Settings must say plainly that this configuration is not usable.
    assert saved.json()["configuration_issues"]

    project = client.post("/api/projects", json={
        "title": "probe", "style_prompt": "rock", "lyrics": "[Verse]\nla",
    }).json()
    response = client.post(f"/api/projects/{project['id']}/generate", json={})
    assert response.status_code == 409, response.text

    time.sleep(1.0)
    assert not marker.exists(), "the configured program was executed"


def test_settings_response_does_not_leak_unrelated_paths(client) -> None:
    """Storage locations are shown deliberately; nothing else should be."""
    body = client.get("/api/settings").json()
    # These two are intentionally exposed so Settings can show where data lives.
    assert "projects_dir" in body and "models_dir" in body
    serialised = str(body)
    assert "SECRET" not in serialised.upper()
