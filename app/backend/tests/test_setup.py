"""First-run setup: hardware detection, the component list and the menu.

None of this touches the network, a GPU or an installer. The parts that do -
pip, npm, huggingface - are behind ``Context.run``, which these tests replace,
so the decisions can be checked without installing anything.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from songforge.setup import menu
from songforge.setup.components import (
    Component,
    Context,
    SetupError,
    catalogue,
    format_size,
    write_profile,
)
from songforge.setup.hardware import (
    Gpu,
    Machine,
    recommended_lyrics_model,
    settings_profile,
    system_memory_gib,
    torch_target,
    warnings_for,
)

WINDOWS = Machine(system="Windows", machine="AMD64", python=(3, 12, 3))
MACOS = Machine(system="Darwin", machine="arm64", python=(3, 12, 3))
LINUX = Machine(system="Linux", machine="x86_64", python=(3, 12, 3))

RTX_3060 = Gpu(vendor="nvidia", name="RTX 3060", memory_gib=12.0, compute=(8, 6), driver="617.14")
RTX_4090 = Gpu(vendor="nvidia", name="RTX 4090", memory_gib=24.0, compute=(8, 9), driver="560.1")
OLD_DRIVER = Gpu(vendor="nvidia", name="RTX 2060", memory_gib=6.0, compute=(7, 5), driver="470.82")
APPLE = Gpu(vendor="apple", name="Apple M3 Pro", memory_gib=18.0)
AMD = Gpu(vendor="amd", name="Radeon RX 7900", memory_gib=24.0)
CPU = Gpu(vendor="cpu", name="CPU")


def make_context(tmp_path: Path, gpu: Gpu = RTX_3060, machine: Machine = WINDOWS) -> Context:
    ctx = Context(root=tmp_path, machine=machine, gpu=gpu,
                  torch=torch_target(gpu, machine), dry_run=True, log=lambda _m: None)
    return ctx


# --------------------------------------------------------------- torch build

@pytest.mark.parametrize(("gpu", "machine", "label", "index_fragment"), [
    (RTX_3060, WINDOWS, "CUDA 12.8", "cu128"),
    (RTX_4090, LINUX, "CUDA 12.8", "cu128"),
    (APPLE, MACOS, "Apple Metal (MPS)", None),
    (AMD, LINUX, "ROCm 6.3", "rocm"),
    (CPU, WINDOWS, "CPU", "cpu"),
])
def test_each_machine_gets_its_own_torch_build(gpu, machine, label, index_fragment) -> None:
    target = torch_target(gpu, machine)
    assert target.supported
    assert target.label == label
    if index_fragment is None:
        # Metal ships in the ordinary PyPI wheel; an index would be wrong.
        assert target.index_url is None
    else:
        assert index_fragment in target.index_url
    assert "torch==2.10.0" in target.packages


def test_an_old_nvidia_driver_is_refused_with_the_number_to_beat() -> None:
    """Installing cu128 on an old driver fails at the first kernel, not at pip."""
    target = torch_target(OLD_DRIVER, WINDOWS)
    assert not target.supported
    assert "528.33" in target.problem
    assert "470.82" in target.problem


def test_amd_on_windows_is_refused_rather_than_guessed() -> None:
    target = torch_target(AMD, WINDOWS)
    assert not target.supported
    assert "Linux" in target.problem


def test_an_unreadable_driver_does_not_block_the_install() -> None:
    unknown = Gpu(vendor="nvidia", name="RTX 5080", memory_gib=16.0, driver=None)
    assert torch_target(unknown, WINDOWS).supported


# ------------------------------------------------------------------ profiles

def test_the_3060_profile_matches_the_settings_this_was_tuned_with() -> None:
    """The hand-tuned numbers this project shipped with, derived rather than typed."""
    profile = settings_profile(RTX_3060)
    assert profile["memory_budget_gib"] == 11.0
    assert profile["offload_ar"] is True
    assert profile["quantization"] == "none"  # compute 8.6 cannot do fp8


def test_a_big_modern_card_gets_more_headroom_and_fp8() -> None:
    profile = settings_profile(RTX_4090)
    assert profile["memory_budget_gib"] == 22.0
    assert profile["offload_ar"] is False
    assert profile["quantization"] == "fp8"


def test_apple_takes_a_share_of_shared_memory_not_all_of_it() -> None:
    profile = settings_profile(APPLE)
    assert 6.0 <= profile["memory_budget_gib"] < 18.0
    assert profile["offload_ar"] is True
    assert profile["quantization"] == "none"


def test_the_cpu_profile_still_asks_for_a_positive_budget() -> None:
    """yue2 raises ValueError on a budget of zero, so the CPU path cannot use one."""
    profile = settings_profile(CPU)
    assert profile["memory_budget_gib"] >= 8.0
    assert profile["offload_ar"] is False
    # The attention shim stands in for a CUDA kernel and has nothing to do here.
    assert profile["memory_efficient_attention"] is False


def test_system_memory_is_readable_on_this_machine() -> None:
    """The reader is ctypes on Windows and sysctl/sysconf elsewhere; all three
    are easy to get wrong in a way that only shows on the other platform."""
    assert (system_memory_gib() or 0) > 0.5


@pytest.mark.parametrize(("memory", "expected"), [
    (24.0, "gemma4:12b"), (12.0, "gemma4:12b"), (8.0, "gemma3:4b"), (4.0, "gemma3:1b"),
])
def test_the_lyrics_model_is_sized_to_the_card(memory, expected) -> None:
    assert recommended_lyrics_model(Gpu(vendor="nvidia", name="x", memory_gib=memory)) == expected


def test_a_small_card_is_warned_about_but_not_refused() -> None:
    """"It works on my 3060" is the point of this project, so 12 GB warns, never blocks."""
    warnings = warnings_for(RTX_3060, WINDOWS)
    assert any("24 GB" in w and "12 GB" in w for w in warnings)
    assert torch_target(RTX_3060, WINDOWS).supported


def test_metal_is_warned_about_the_cpu_vae_and_the_bfloat16_floor() -> None:
    """Both are properties of yue2, not of SongForge, and both look like a
    misconfiguration to someone who has not read its source."""
    warnings = warnings_for(APPLE, MACOS)
    assert any("VAE decoder runs on the CPU" in w for w in warnings)
    assert any("macOS 14" in w for w in warnings)
    # The 24 GB note is about video memory and does not apply to shared memory.
    assert not any("24 GB" in w for w in warnings)


def test_no_gpu_says_hours_rather_than_minutes() -> None:
    assert any("hours" in w for w in warnings_for(CPU, WINDOWS))


def test_an_old_python_is_called_out() -> None:
    old = Machine(system="Windows", machine="AMD64", python=(3, 10, 0))
    assert any("3.12" in w for w in warnings_for(RTX_3060, old))


# ---------------------------------------------------------------- the menu

def test_every_component_is_either_required_or_optional_and_has_a_size(tmp_path) -> None:
    ctx = make_context(tmp_path)
    for component in catalogue(ctx):
        assert component.size_bytes > 0, component.key
        assert component.detail
        assert component.install and component.present


def test_the_weights_carry_their_non_commercial_licence(tmp_path) -> None:
    """The model is CC BY-NC 4.0 and the app is MIT; the list must not blur that."""
    by_key = {c.key: c for c in catalogue(make_context(tmp_path))}
    assert by_key["model"].licence == "CC BY-NC 4.0"
    assert by_key["vae"].licence == "CC BY-NC 4.0"
    assert by_key["backend"].licence == ""


def _rows(ctx: Context, present: set[str] | None = None) -> list[menu.Row]:
    present = present or set()
    return [
        menu.Row(component=c, chosen=c.required and c.key not in present,
                 present=c.key in present, blocked="")
        for c in catalogue(ctx)
    ]


def test_choosing_the_weights_pulls_in_what_downloads_them(tmp_path) -> None:
    ctx = make_context(tmp_path)
    rows = _rows(ctx)
    for row in rows:
        row.chosen = row.component.key == "model"

    added = menu.resolve_dependencies(rows)

    chosen = {r.component.key for r in rows if r.chosen}
    assert chosen == {"model", "yue2", "torch"}
    assert added  # and it says so rather than doing it silently


def test_the_licence_notice_appears_only_when_weights_will_be_downloaded(tmp_path) -> None:
    ctx = make_context(tmp_path)

    rows = _rows(ctx)
    for row in rows:
        row.chosen = row.component.key == "backend"
    assert menu.licence_notice(rows) == ""

    for row in rows:
        row.chosen = row.component.key == "vae"
    notice = menu.licence_notice(rows)
    assert "NON-COMMERCIAL" in notice
    assert "CC BY-NC 4.0" in notice
    assert "MIT" in notice


def test_an_installed_component_is_never_re_ticked(tmp_path) -> None:
    """Pressing Enter on a finished install must do nothing, not reinstall."""
    ctx = make_context(tmp_path)
    rows = _rows(ctx, present={c.key for c in catalogue(ctx)})
    assert not any(row.chosen for row in rows)
    assert menu.install(ctx, rows) == []


def test_the_rendered_menu_names_the_card_and_the_torch_build(tmp_path) -> None:
    ctx = make_context(tmp_path)
    text = menu.render(ctx, _rows(ctx))
    assert "RTX 3060" in text
    assert "CUDA 12.8" in text
    assert "[Enter] install" in text


def test_a_blocked_component_is_never_installed_even_if_ticked(tmp_path) -> None:
    """Node.js missing means npm install cannot work; attempting it wastes a minute."""
    ctx = make_context(tmp_path)
    rows = _rows(ctx)
    frontend = next(row for row in rows if row.component.key == "frontend")
    frontend.blocked = "Node.js is not installed."
    frontend.chosen = True

    assert not frontend.actionable
    installed = {title for title, _ in menu.install(ctx, rows)}
    assert frontend.component.title not in installed


# ------------------------------------------------------------------ installs

def _component(key: str, required: bool, boom: str | None = None) -> Component:
    def install(_ctx: Context) -> None:
        if boom:
            raise SetupError(boom)

    return Component(key=key, title=key.title(), detail="d", size_bytes=1,
                     required=required, install=install, present=lambda _c: False)


def test_a_failed_required_step_stops_the_run(tmp_path) -> None:
    """Later components depend on earlier ones; carrying on multiplies the error."""
    ctx = make_context(tmp_path)
    rows = [
        menu.Row(_component("torch", True, "no wheel for this card"), True, False, ""),
        menu.Row(_component("model", True), True, False, ""),
    ]
    results = menu.install(ctx, rows)
    assert results == [("Torch", "failed: no wheel for this card")]


def test_a_failed_optional_step_is_skipped_and_the_rest_continues(tmp_path) -> None:
    ctx = make_context(tmp_path)
    rows = [
        menu.Row(_component("ffmpeg", False, "use your package manager"), True, False, ""),
        menu.Row(_component("backend", True), True, False, ""),
    ]
    results = menu.install(ctx, rows)
    assert results[0][1].startswith("failed")
    assert results[1] == ("Backend", "installed")


def test_dry_run_runs_nothing(tmp_path) -> None:
    lines: list[str] = []
    ctx = Context(root=tmp_path, machine=WINDOWS, gpu=RTX_3060,
                  torch=torch_target(RTX_3060, WINDOWS), dry_run=True, log=lines.append)
    ctx.run(["pip", "install", "something-enormous"])
    assert any("would run" in line for line in lines)


# ------------------------------------------------------------------ profile

def test_the_written_profile_is_what_the_backend_needs(tmp_path) -> None:
    ctx = Context(root=tmp_path, machine=WINDOWS, gpu=RTX_3060,
                  torch=torch_target(RTX_3060, WINDOWS), log=lambda _m: None)
    path = write_profile(ctx)

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["gpu"]["name"] == "RTX 3060"
    assert written["settings"]["memory_budget_gib"] == 11.0
    assert written["paths"]["model_path"].endswith("YuE2-3B")
    assert written["paths"]["python_executable"].endswith("python.exe")


def test_a_mac_profile_points_at_bin_python_not_scripts(tmp_path) -> None:
    ctx = Context(root=tmp_path, machine=MACOS, gpu=APPLE,
                  torch=torch_target(APPLE, MACOS), log=lambda _m: None)
    written = json.loads(write_profile(ctx).read_text(encoding="utf-8"))
    # Compared as path parts: this test suite runs on Windows too, where the
    # separator in the rendered string is a backslash.
    assert Path(written["paths"]["python_executable"]).parts[-2:] == ("bin", "python")


@pytest.mark.parametrize(("size", "text"), [
    (120 * 1024 * 1024, "120 MB"), (13 * 1024 ** 3, "13.0 GB"),
])
def test_sizes_read_the_way_a_download_is_quoted(size, text) -> None:
    assert format_size(size) == text


# ------------------------------------------------- reading the profile back

def _write_profile_file(runtime: Path, payload: dict) -> Path:
    runtime.mkdir(parents=True, exist_ok=True)
    path = runtime / "hardware-profile.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_a_profile_round_trips_from_setup_into_the_backend(tmp_path) -> None:
    """What setup writes is exactly what the backend reads; no second format."""
    from songforge import hardware_profile

    ctx = Context(root=tmp_path, machine=WINDOWS, gpu=RTX_4090,
                  torch=torch_target(RTX_4090, WINDOWS), log=lambda _m: None)
    write_profile(ctx)

    profile = hardware_profile.load(tmp_path / "runtime")
    assert profile is not None
    assert profile.gpu_name == "RTX 4090"
    assert profile.compute == (8, 9)
    assert profile.settings["quantization"] == "fp8"
    assert "RTX 4090" in profile.describe()

    seeded = hardware_profile.seed_values(profile)
    assert seeded["runner_kind"] == "yue2_cli"
    assert seeded["memory_budget_gib"] == 22.0


def test_a_half_finished_install_stays_on_the_mock_runner(tmp_path) -> None:
    """Switching to the real runner without weights would fail at render time."""
    from songforge import hardware_profile

    _write_profile_file(tmp_path, {
        "gpu": {"vendor": "nvidia", "name": "RTX 4090"},
        "settings": {"memory_budget_gib": 22.0},
        "paths": {"python_executable": "/x/python"},  # no model, no vae
    })
    profile = hardware_profile.load(tmp_path)
    assert profile is not None
    assert "runner_kind" not in hardware_profile.seed_values(profile)


def test_only_allowlisted_fields_are_seeded(tmp_path) -> None:
    """A stale profile must not be able to flip settings it has no business setting."""
    from songforge import hardware_profile

    _write_profile_file(tmp_path, {
        "gpu": {"vendor": "nvidia", "name": "RTX 4090"},
        "settings": {"memory_budget_gib": 22.0, "offline_mode": False, "theme": "light"},
        "paths": {"model_path": "/w", "secret": "/nope"},
    })
    profile = hardware_profile.load(tmp_path)
    assert profile is not None
    assert profile.settings == {"memory_budget_gib": 22.0}
    assert profile.paths == {"model_path": "/w"}


@pytest.mark.parametrize("content", ["", "not json at all", "[]", "null"])
def test_an_unusable_profile_is_ignored_rather_than_fatal(tmp_path, content) -> None:
    """Setup writes this file; a truncated one must not stop the app from starting."""
    from songforge import hardware_profile

    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "hardware-profile.json").write_text(content, encoding="utf-8")
    assert hardware_profile.load(tmp_path) is None


def test_no_profile_at_all_is_normal(tmp_path) -> None:
    from songforge import hardware_profile

    assert hardware_profile.load(tmp_path) is None


def test_a_fresh_database_starts_configured_for_the_detected_card(runtime_dir) -> None:
    """The point of the whole profile: no retyping paths on a new machine."""
    from sqlmodel import Session

    from songforge.db import get_engine, init_db
    from songforge.models import AppSettings

    _write_profile_file(runtime_dir, {
        "gpu": {"vendor": "nvidia", "name": "RTX 4090", "memory_gib": 24.0, "compute": [8, 9]},
        "torch": "CUDA 12.8",
        "settings": {"memory_budget_gib": 22.0, "offload_ar": False, "quantization": "fp8",
                     "lyrics_model": "gemma4:12b"},
        "paths": {"python_executable": "/env/python", "model_path": "/w/YuE2-3B",
                  "vae_path": "/w/YuE2-Vae"},
    })

    init_db()
    with Session(get_engine()) as session:
        settings = session.get(AppSettings, 1)
        assert settings is not None
        assert settings.memory_budget_gib == 22.0
        assert settings.quantization == "fp8"
        assert settings.offload_ar is False
        assert settings.model_path == "/w/YuE2-3B"
        assert settings.runner_kind == "yue2_cli"


def test_an_existing_settings_row_is_never_overwritten(runtime_dir) -> None:
    """Re-running setup must not undo choices someone made in Settings."""
    from sqlmodel import Session

    from songforge.db import get_engine, init_db
    from songforge.models import AppSettings

    init_db()
    with Session(get_engine()) as session:
        settings = session.get(AppSettings, 1)
        assert settings is not None
        settings.memory_budget_gib = 6.5
        session.add(settings)
        session.commit()

    _write_profile_file(runtime_dir, {
        "gpu": {"vendor": "nvidia", "name": "RTX 4090"},
        "settings": {"memory_budget_gib": 22.0},
        "paths": {},
    })
    init_db()

    with Session(get_engine()) as session:
        assert session.get(AppSettings, 1).memory_budget_gib == 6.5


# ------------------------------------------- the interpreter setup runs under


def test_an_old_interpreter_is_refused_before_a_venv_is_built(tmp_path, capsys) -> None:
    """_create_venv builds from sys.executable, so running setup on 3.11 makes
    a venv the backend cannot be installed into. Left alone it fails two
    minutes later inside pip with "requires a different Python", which reads
    like a packaging fault. --yes and --only never show the menu, so the
    menu's warning does not help."""
    import sys as _sys

    from songforge.setup import cli

    original = _sys.version_info
    try:
        _sys.version_info = (3, 11, 9, "final", 0)  # type: ignore[assignment]
        code = cli.main(["--root", str(tmp_path), "--only=backend"])
    finally:
        _sys.version_info = original  # type: ignore[assignment]

    assert code == 2
    message = capsys.readouterr().err
    assert "3.11.9" in message and "3.12" in message
    assert "setup.sh" in message
    # Nothing may have been created on the way to refusing.
    assert not (tmp_path / "runtime" / "venv").exists()


def test_detect_still_works_on_an_old_interpreter(tmp_path, capsys) -> None:
    """--detect is what a bug report asks for; someone on 3.11 still needs it."""
    import sys as _sys

    from songforge.setup import cli

    original = _sys.version_info
    try:
        _sys.version_info = (3, 11, 9, "final", 0)  # type: ignore[assignment]
        code = cli.main(["--root", str(tmp_path), "--detect"])
    finally:
        _sys.version_info = original  # type: ignore[assignment]

    assert code == 0
    assert '"gpu"' in capsys.readouterr().out


def test_every_module_level_import_is_a_declared_dependency() -> None:
    """httpx was declared only under [test] while lyrics.py imports it at
    module scope, so CI (which installs the test extra) passed while a real
    setup run produced an environment that could not import the app."""
    import re
    import tomllib
    from pathlib import Path

    backend = Path(__file__).resolve().parents[1]
    manifest = tomllib.loads((backend / "pyproject.toml").read_text(encoding="utf-8"))
    declared = {
        re.split(r"[<>=\[]", item)[0].strip().replace("-", "_").lower()
        for item in manifest["project"]["dependencies"]
    }
    # Distribution names do not always match the import name.
    declared |= {"pydantic_settings", "sqlalchemy"}

    stdlib = set(__import__("sys").stdlib_module_names)
    imported: set[str] = set()
    for path in (backend / "songforge").rglob("*.py"):
        for line in path.read_text(encoding="utf-8").splitlines():
            match = re.match(r"^(?:from|import)\s+([a-zA-Z_][\w]*)", line)
            if match:
                imported.add(match.group(1).lower())

    missing = imported - declared - stdlib - {"songforge"}
    assert not missing, f"imported at module scope but not declared: {sorted(missing)}"

