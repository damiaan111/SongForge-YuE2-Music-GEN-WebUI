"""The protections added by the pre-publication security review.

Each test here is a way in that existed and was closed: a network share spelled
so the check missed it, a command template that read any file on the computer,
engine settings editable by anyone on a shared network, and a model download
that trusted whatever the repository held that day.
"""
from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from songforge.runners.yue2 import (
    DEFAULT_COMMAND_TEMPLATE,
    _is_network_path,
    _validate_template,
)
from songforge.setup import components
from songforge.setup.components import Context, SetupError
from songforge.setup.hardware import Gpu, Machine, torch_target

WINDOWS = Machine(system="Windows", machine="AMD64", python=(3, 12, 3))
RTX_3060 = Gpu(vendor="nvidia", name="RTX 3060", memory_gib=12.0, compute=(8, 6), driver="617.14")


# ------------------------------------------------------------ network paths

@pytest.mark.parametrize("path", [
    "\\\\host\\share\\python.exe",
    "//host/share/python.exe",
    # The two spellings the first version of the check let through. Windows
    # normalises both to \\host\share.
    "/\\host\\share\\python.exe",
    "\\/host/share/python.exe",
    "\\\\?\\UNC\\host\\share\\python.exe",
    "\\\\.\\pipe\\python",
    '  "//host/share/python.exe"  ',
])
def test_every_spelling_of_a_network_share_is_recognised(path: str) -> None:
    assert _is_network_path(path)


@pytest.mark.parametrize("path", [
    "",
    "python",
    "yue2",
    "runtime/venv-yue2/Scripts/python.exe",
    "/usr/bin/python3",
    "./venv/bin/python",
])
def test_local_programs_are_not_mistaken_for_shares(path: str) -> None:
    assert not _is_network_path(path)


# -------------------------------------------------------- command template

def test_the_shipped_template_is_still_valid() -> None:
    assert _validate_template(DEFAULT_COMMAND_TEMPLATE) == []


@pytest.mark.parametrize("token", [
    "--lyrics-file=C:/Users/someone/secret.txt",
    "--abc-file=/etc/passwd",
    "--request=C:/other/request.json",
    "--config=/home/someone/.ssh/config",
    "--output=C:/Windows",
    "--model=//host/share/model",
    "--vae=some/other/repo",
    # A placeholder, but not the one that belongs to this flag.
    "--lyrics-file={request_file}",
    # The right placeholder with something glued on.
    "--lyrics-file={lyrics_file}/../../secret.txt",
])
def test_a_file_flag_only_takes_the_path_songforge_supplies(token: str) -> None:
    """Written as a literal, yue2 read that file into a request the Files tab serves."""
    problems = _validate_template(f"generate --style={{style}} {token}")
    assert problems, token
    assert "SongForge supplies" in " ".join(problems)


def test_the_batch_input_flag_is_refused() -> None:
    problems = _validate_template("batch --input=C:/anything.jsonl --output={output}")
    assert any("--input" in problem for problem in problems)


def test_value_flags_may_still_be_written_literally() -> None:
    # Not paths: pinning a device or a seed by hand remains a legitimate edit.
    assert _validate_template(
        "generate --model={model} --device=cuda:1 --seed=42 --style={style} --output={output}"
    ) == []


# ------------------------------------------------- engine settings on a LAN

ENGINE_CHANGES = [
    {"python_executable": "C:/elsewhere/python.exe"},
    {"yue2_executable": "C:/elsewhere/yue2.exe"},
    {"model_path": "someone/their-own-model"},
    {"vae_path": "C:/elsewhere/vae"},
    {"command_template": "generate --style={style}"},
]


@pytest.fixture
def shared_client(monkeypatch: pytest.MonkeyPatch, runtime_dir: Path):
    """The app as the launcher starts it with -Lan."""
    from fastapi.testclient import TestClient

    from songforge import config
    from songforge.main import create_app

    monkeypatch.setenv("SONGFORGE_LAN", "1")
    config.get_config.cache_clear()
    with TestClient(create_app()) as test_client:
        yield test_client
    config.get_config.cache_clear()


@pytest.mark.parametrize("change", ENGINE_CHANGES)
def test_engine_settings_are_frozen_while_shared(shared_client, change: dict) -> None:
    before = shared_client.get("/api/settings").json()
    assert before["lan_mode"] is True

    response = shared_client.put("/api/settings", json=change)
    assert response.status_code == 403
    assert "shared on the network" in response.json()["detail"]

    after = shared_client.get("/api/settings").json()
    (field,) = change
    assert after[field] == before[field], "nothing was written"


def test_everything_else_still_saves_while_shared(shared_client) -> None:
    current = shared_client.get("/api/settings").json()
    # The page saves whole forms: an engine field sent back unchanged is fine.
    response = shared_client.put("/api/settings", json={
        "default_language": "Portuguese",
        "theme": "light",
        "model_path": current["model_path"],
        "command_template": current["command_template"],
    })
    assert response.status_code == 200
    assert response.json()["default_language"] == "Portuguese"


@pytest.mark.parametrize("change", ENGINE_CHANGES)
def test_engine_settings_are_editable_on_this_computer_only(client, change: dict) -> None:
    assert client.get("/api/settings").json()["lan_mode"] is False
    assert client.put("/api/settings", json=change).status_code == 200


# ------------------------------------------------------- pinned downloads

def make_context(tmp_path: Path, *, dry_run: bool = False) -> tuple[Context, list[str]]:
    lines: list[str] = []
    ctx = Context(root=tmp_path, machine=WINDOWS, gpu=RTX_3060,
                  torch=torch_target(RTX_3060, WINDOWS), dry_run=dry_run, log=lines.append)
    return ctx, lines


def test_the_pins_are_full_commit_ids_and_a_full_hash() -> None:
    # A branch name or a short id would not pin anything.
    for revision in (components.MODEL_REVISION, components.VAE_REVISION):
        assert len(revision) == 40 and int(revision, 16) >= 0
    assert len(components.YUE2_WHEEL_SHA256) == 64 and int(components.YUE2_WHEEL_SHA256, 16) >= 0


def test_a_wheel_that_is_not_the_tested_one_is_deleted_not_installed(tmp_path: Path) -> None:
    ctx, _ = make_context(tmp_path)
    wheel = tmp_path / components.YUE2_WHEEL
    wheel.write_bytes(b"not the wheel that was tested")
    with pytest.raises(SetupError, match="does not match"):
        components._verify_wheel(ctx, wheel)
    assert not wheel.exists(), "left behind, the next run would find it already downloaded"


def test_the_tested_wheel_is_accepted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ctx, lines = make_context(tmp_path)
    wheel = tmp_path / components.YUE2_WHEEL
    wheel.write_bytes(b"stand-in for the real wheel")
    monkeypatch.setattr(components, "YUE2_WHEEL_SHA256",
                        hashlib.sha256(b"stand-in for the real wheel").hexdigest())
    components._verify_wheel(ctx, wheel)
    assert wheel.exists()
    assert any("checksum" in line for line in lines)


def test_downloads_ask_for_the_pinned_revision(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(components.UNPINNED_ENV, raising=False)
    ctx, _ = make_context(tmp_path)
    code: list[str] = []
    monkeypatch.setattr(Context, "run_python", lambda self, venv, source: code.append(source))
    components._download(ctx, components.MODEL_REPO, tmp_path / "m", components.MODEL_REVISION)
    components._download(ctx, components.VAE_REPO, tmp_path / "v", components.VAE_REVISION)
    assert f"revision={components.MODEL_REVISION!r}" in code[0]
    assert f"revision={components.VAE_REVISION!r}" in code[1]


def test_the_override_downloads_the_newest_files_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(components.UNPINNED_ENV, "1")
    ctx, lines = make_context(tmp_path)
    code: list[str] = []
    monkeypatch.setattr(Context, "run_python", lambda self, venv, source: code.append(source))
    components._download(ctx, components.MODEL_REPO, tmp_path / "m", components.MODEL_REVISION)
    assert "revision=None" in code[0]
    assert any(components.UNPINNED_ENV in line for line in lines)


def test_a_vanished_revision_explains_the_way_out(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(components.UNPINNED_ENV, raising=False)
    ctx, _ = make_context(tmp_path)

    def fail(self, venv, source):
        raise SetupError("python failed with exit code 1.")

    monkeypatch.setattr(Context, "run_python", fail)
    with pytest.raises(SetupError) as caught:
        components._download(ctx, components.MODEL_REPO, tmp_path / "m", components.MODEL_REVISION)
    assert "git pull" in str(caught.value) and components.UNPINNED_ENV in str(caught.value)
