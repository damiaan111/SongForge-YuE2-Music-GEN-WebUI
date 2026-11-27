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

def test_the_budget_is_the_whole_card_because_yue2_keeps_its_own_reserve() -> None:
    """yue2 caps PyTorch at min(budget, card) - 2 GiB.

    Asking for less than the card only lowers that cap. A budget of 11 on this
    12 GB card left 9 GiB, which could not synthesise more than about two
    minutes of audio; the card itself leaves 10.
    """
    profile = settings_profile(RTX_3060)
    assert profile["memory_budget_gib"] == 12.0
    assert profile["offload_ar"] is True
    assert profile["quantization"] == "none"


def test_a_big_modern_card_gets_its_whole_budget_and_no_experiments() -> None:
    profile = settings_profile(RTX_4090)
    assert profile["memory_budget_gib"] == 24.0
    assert profile["offload_ar"] is False
    # fp8 would run on this card, but yue2 calls it experimental and 1.0.0
    # shipped it as the default without ever having rendered with it.
    assert profile["quantization"] == "none"


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
    # Skipped, not failed: an optional extra that could not be added must not
    # turn a working install into a failed one.
    assert results[0][1] == "skipped"
    assert results[1] == ("Backend", "installed")


def test_the_frontend_is_built_not_just_installed(tmp_path, monkeypatch) -> None:
    """`next start` refuses to run without a production build.

    Setup used to stop after `npm install`, which reported success and then
    could not start: "Could not find a production build in the '.next'
    directory".
    """
    from songforge.setup import components

    monkeypatch.setattr(components.shutil, "which", lambda _name: "npm")
    ran: list[tuple[list[str], dict]] = []
    ctx = make_context(tmp_path)
    ctx.run = lambda argv, **kwargs: ran.append(([str(a) for a in argv], kwargs))  # type: ignore[method-assign]

    components._install_frontend(ctx)

    commands = [argv for argv, _ in ran]
    # No lockfile in this empty checkout, so there is nothing for `npm ci` to
    # install from; the audit and funding notices are off either way.
    assert commands == [["npm", "install", "--no-audit", "--no-fund"], ["npm", "run", "build"]]
    # Next.js writes its telemetry config into the user profile; on Windows
    # that rename fails with EXDEV across volumes and takes the build with it.
    assert ran[1][1]["env"] == {"NEXT_TELEMETRY_DISABLED": "1"}
    assert all(kwargs.get("cwd") == ctx.frontend_dir for _argv, kwargs in ran)


def test_an_unbuilt_frontend_counts_as_not_installed(tmp_path) -> None:
    from songforge.setup.components import _frontend_present

    ctx = make_context(tmp_path)
    (ctx.frontend_dir / "node_modules" / "next").mkdir(parents=True)
    assert _frontend_present(ctx) is False, "packages alone cannot serve the app"

    build = ctx.frontend_dir / ".next"
    build.mkdir()
    (build / "BUILD_ID").write_text("abc", encoding="utf-8")
    assert _frontend_present(ctx) is False, "a build of unknown source is not trusted"

    from songforge.setup.components import _frontend_fingerprint

    (build / "songforge-source").write_text(_frontend_fingerprint(ctx), encoding="utf-8")
    assert _frontend_present(ctx) is True


def test_run_passes_extra_environment_without_dropping_the_rest(tmp_path) -> None:
    import os

    ctx = make_context(tmp_path)
    ctx.dry_run = False
    seen: dict = {}

    def fake_run(argv, cwd=None, env=None):
        seen["env"] = env
        class Done:
            returncode = 0
        return Done()

    from songforge.setup import components

    original = components.subprocess.run
    components.subprocess.run = fake_run
    try:
        ctx.run(["x"], env={"ADDED": "1"})
    finally:
        components.subprocess.run = original

    assert seen["env"]["ADDED"] == "1"
    assert "PATH" in seen["env"], "the child would lose PATH and fail to find npm"
    assert len(seen["env"]) > len(os.environ) - 2


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
    assert written["settings"]["memory_budget_gib"] == 12.0
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
    assert "quantization" not in profile.settings, "never seeded from the file"
    assert "RTX 4090" in profile.describe()

    seeded = hardware_profile.seed_values(profile)
    assert seeded["runner_kind"] == "yue2_cli"
    assert seeded["memory_budget_gib"] == 24.0


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
        # A profile written by 1.0.0 still says fp8. It is not taken from there.
        assert settings.quantization == "none"
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



# ------------------------------------------- reproducible, verifiable installs

def test_a_lockfile_is_installed_exactly_and_npm_install_is_the_fallback(tmp_path, monkeypatch) -> None:
    """`npm ci` gives every machine the versions the app was built with.

    `npm install` may pick newer ones. It stays as the fallback, because a
    working install on slightly different packages beats no install.
    """
    from songforge.setup import components

    monkeypatch.setattr(components.shutil, "which", lambda _name: "npm")
    ctx = make_context(tmp_path)
    ctx.frontend_dir.mkdir(parents=True)
    (ctx.frontend_dir / "package-lock.json").write_text("{}", encoding="utf-8")

    ran: list[list[str]] = []
    ctx.run = lambda argv, **_kwargs: ran.append([str(a) for a in argv])  # type: ignore[method-assign]
    components._install_frontend(ctx)
    assert ran[0] == ["npm", "ci", "--no-audit", "--no-fund"]

    ran.clear()

    def flaky(argv, **_kwargs):
        ran.append([str(a) for a in argv])
        if argv[1] == "ci":
            raise SetupError("npm failed with exit code 1.")

    ctx.run = flaky  # type: ignore[method-assign]
    components._install_frontend(ctx)
    assert [command[1] for command in ran] == ["ci", "install", "run"]


def test_the_backend_installs_the_tested_versions_and_falls_back_to_ranges(tmp_path) -> None:
    from songforge.setup import components

    ctx = make_context(tmp_path)
    ctx.backend_dir.mkdir(parents=True)
    constraints = ctx.backend_dir / "constraints.txt"
    constraints.write_text("fastapi==0.165.0\n", encoding="utf-8")

    ran: list[list[str]] = []
    ctx.run = lambda argv, **_kwargs: ran.append([str(a) for a in argv])  # type: ignore[method-assign]
    components._install_backend(ctx)
    install = ran[-1]
    assert install[install.index("-c") + 1] == str(constraints)

    ran.clear()

    def refuses_constraints(argv, **_kwargs):
        ran.append([str(a) for a in argv])
        if "-c" in argv:
            raise SetupError("pip failed with exit code 1.")

    ctx.run = refuses_constraints  # type: ignore[method-assign]
    components._install_backend(ctx)
    assert "-c" in ran[-2] and "-c" not in ran[-1], "the ranges are tried when the pins cannot be met"
    assert ran[-1][-2:] == ["-e", str(ctx.backend_dir)]


def test_the_shipped_constraints_satisfy_the_declared_ranges() -> None:
    """A pin outside its own range would make every constrained install fail."""
    import re
    import tomllib

    backend = Path(__file__).resolve().parents[1]
    declared = tomllib.loads((backend / "pyproject.toml").read_text(encoding="utf-8"))
    pins: dict[str, tuple[int, ...]] = {}
    for line in (backend / "constraints.txt").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, _, version = line.partition("==")
        assert version, f"constraints must be exact pins, not {line!r}"
        pins[name.lower().replace("_", "-")] = tuple(int(p) for p in re.findall(r"\d+", version)[:3])

    for requirement in declared["project"]["dependencies"]:
        name = re.match(r"[A-Za-z0-9_.-]+", requirement).group(0).lower()
        assert name in pins, f"{name} is a dependency but is not pinned in constraints.txt"
        floor = re.search(r">=([0-9.]+)", requirement)
        ceiling = re.search(r"<([0-9.]+)", requirement)
        if floor:
            assert pins[name] >= tuple(int(p) for p in floor.group(1).split(".")), requirement
        if ceiling:
            assert pins[name] < tuple(int(p) for p in ceiling.group(1).split(".")), requirement


def test_truncated_weights_count_as_missing(tmp_path) -> None:
    """A model.safetensors that merely exists is not an installed model.

    A copy interrupted half way leaves a file that used to be reported as
    "done" and then failed at the first render.
    """
    from songforge.setup.components import _verify_weights, _weights_present

    ctx = make_context(tmp_path)
    folder = ctx.models_dir / "YuE2-3B"
    folder.mkdir(parents=True)
    (folder / "weights_manifest.json").write_text(
        json.dumps({"schema": 1, "files": {"model.safetensors": {"bytes": 10, "sha256": "x"}}}),
        encoding="utf-8",
    )
    (folder / "model.safetensors").write_bytes(b"12345")
    assert _weights_present(ctx, "YuE2-3B") is False

    ctx.dry_run = False
    with pytest.raises(SetupError, match="cut short"):
        _verify_weights(ctx, "YuE2-3B")

    (folder / "model.safetensors").write_bytes(b"1234567890")
    assert _weights_present(ctx, "YuE2-3B") is True
    _verify_weights(ctx, "YuE2-3B")


def test_weights_without_a_manifest_are_trusted_as_before(tmp_path) -> None:
    from songforge.setup.components import _weights_present

    ctx = make_context(tmp_path)
    folder = ctx.models_dir / "YuE2-Vae"
    folder.mkdir(parents=True)
    (folder / "model.safetensors").write_bytes(b"x")
    assert _weights_present(ctx, "YuE2-Vae") is True


def test_the_quoted_download_is_the_real_one(tmp_path) -> None:
    """The menu once said 18 GB for an 11 GB install and scared people off."""
    rows = {row.component.key: row.component for row in menu.build_rows(make_context(tmp_path))}
    assert 6.5 * 1024 ** 3 < rows["model"].size_bytes < 7.0 * 1024 ** 3
    assert rows["vae"].size_bytes < 600 * 1024 ** 2
    required = sum(c.size_bytes for c in rows.values() if c.required)
    assert required < 12 * 1024 ** 3


# ----------------------------------------------------------- hardware choices

def test_the_card_with_the_most_memory_is_chosen_not_the_first(monkeypatch) -> None:
    """A display card in slot 0 must not decide the settings for a 24 GB card."""
    from songforge.setup import hardware

    def fake(argv, timeout=15.0):
        if "--query-gpu=index,name,memory.total,driver_version" in argv:
            return "0, GeForce GT 1030, 2048, 560.94\n1, GeForce RTX 3090, 24576, 560.94\n"
        if "--query-gpu=index,compute_cap" in argv:
            return "0, 6.1\n1, 8.6\n"
        return ""

    monkeypatch.setattr(hardware, "_run", fake)
    gpu = hardware._detect_nvidia()
    assert gpu is not None
    assert (gpu.index, gpu.name, gpu.compute) == (1, "GeForce RTX 3090", (8, 6))
    assert round(gpu.memory_gib or 0) == 24
    assert settings_profile(gpu)["gpu_index"] == 1
    assert any("2 NVIDIA cards" in note for note in gpu.notes)


def test_a_single_card_is_device_zero_and_says_nothing_extra(monkeypatch) -> None:
    from songforge.setup import hardware

    monkeypatch.setattr(
        hardware, "_run",
        lambda argv, timeout=15.0: "0, GeForce RTX 3060, 12288, 621.01\n"
        if "--query-gpu=index,name,memory.total,driver_version" in argv else "0, 8.6\n",
    )
    gpu = hardware._detect_nvidia()
    assert gpu is not None and gpu.index == 0 and gpu.notes == ()


def test_a_too_new_python_is_refused_with_the_reason(tmp_path, capsys, monkeypatch) -> None:
    """Pinned wheels do not exist for it, so pip would try to compile numpy."""
    from songforge.setup import cli

    monkeypatch.setattr(cli.sys, "version_info", (3, 14, 0, "final", 0))
    assert cli.main(["--yes", "--root", str(tmp_path)]) == 2
    message = capsys.readouterr().err
    assert "3.14" in message and "newer than SongForge supports" in message


# ------------------------------------------------------------ the lyrics writer


@pytest.fixture
def no_lyrics_model(monkeypatch):
    """Pretend the lyrics model has not been pulled.

    Whether it has is read from the home directory of whoever runs the tests,
    so without this the lyrics tests pass or fail by the machine they are on.
    """
    from songforge.setup import components

    monkeypatch.setattr(components, "_lyrics_model_present", lambda _ctx: False)


def test_yes_alone_never_installs_the_optional_lyrics_writer(tmp_path, monkeypatch, no_lyrics_model) -> None:
    from songforge.setup import cli

    chosen: list[str] = []
    monkeypatch.setattr(cli.menu, "install",
                        lambda ctx, rows: chosen.extend(r.component.key for r in rows if r.chosen) or [])
    assert cli.main(["--yes", "--dry-run", "--root", str(tmp_path)]) == 0
    assert "lyrics" not in chosen and "model" in chosen


def test_with_lyrics_adds_it_to_an_unattended_install(tmp_path, monkeypatch, no_lyrics_model) -> None:
    from songforge.setup import cli

    chosen: list[str] = []
    monkeypatch.setattr(cli.menu, "install",
                        lambda ctx, rows: chosen.extend(r.component.key for r in rows if r.chosen) or [])
    assert cli.main(["--yes", "--with-lyrics", "--dry-run", "--root", str(tmp_path)]) == 0
    assert "lyrics" in chosen


def test_saying_no_to_the_lyrics_question_leaves_it_out(tmp_path, monkeypatch, capsys, no_lyrics_model) -> None:
    from songforge.setup import cli

    ctx = make_context(tmp_path)
    rows = menu.build_rows(ctx)
    monkeypatch.setattr("builtins.input", lambda _prompt="": "n")
    cli._offer_lyrics(ctx, rows)
    lyrics = next(r for r in rows if r.component.key == "lyrics")
    assert lyrics.chosen is False
    assert "optional" in capsys.readouterr().out.lower()


def test_saying_yes_without_ollama_asks_before_installing_anything(tmp_path, monkeypatch, no_lyrics_model) -> None:
    """Setup may offer to install Ollama; it never does so unasked."""
    from songforge.setup import cli, components

    ctx = make_context(tmp_path)
    rows = menu.build_rows(ctx)
    monkeypatch.setattr(cli, "_ollama_executable", lambda _ctx: None)
    monkeypatch.setattr(cli, "ollama_installer", lambda _ctx: ["winget", "install", "Ollama.Ollama"])
    answers = iter(["y", "n"])
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))
    ran: list[list[str]] = []
    ctx.run = lambda argv, **_kwargs: ran.append(list(argv))  # type: ignore[method-assign]

    cli._offer_lyrics(ctx, rows)

    assert ran == [], "declining the second question must install nothing"
    assert next(r for r in rows if r.component.key == "lyrics").chosen is False
    assert components.ollama_manual_instructions(ctx)


def test_an_unknown_component_name_is_an_error_not_a_silent_no_op(tmp_path, capsys) -> None:
    from songforge.setup import cli

    assert cli.main(["--only", "backend,frontnd", "--dry-run", "--root", str(tmp_path)]) == 2
    assert "frontnd" in capsys.readouterr().err


def test_a_skipped_optional_extra_does_not_fail_the_install(tmp_path) -> None:
    """Missing Ollama used to make setup exit 1 and skip the hardware profile."""
    ctx = make_context(tmp_path)
    rows = [
        menu.Row(_component("backend", True), True, False, ""),
        menu.Row(_component("lyrics", False, "Ollama is not installed"), True, False, ""),
    ]
    results = menu.install(ctx, rows)
    assert results == [("Backend", "installed"), ("Lyrics", "skipped")]
    summary = menu.summarise(ctx, results)
    assert "did not complete" not in summary
    assert "Hardware profile written" in summary


def test_a_small_page_file_is_called_out_before_the_first_render() -> None:
    """16 GB of RAM with an automatic page file cannot load the model on Windows."""
    from songforge.setup.hardware import memory_warning

    warning = memory_warning(WINDOWS, ram_gib=16.0, commit_gib=18.4)
    assert "16 GB of RAM" in warning and "page file" in warning
    assert memory_warning(WINDOWS, ram_gib=32.0, commit_gib=64.0) == ""
    assert memory_warning(WINDOWS, ram_gib=16.0, commit_gib=48.0) == ""
    # Elsewhere the kernel overcommits and the question does not arise.
    assert memory_warning(LINUX, ram_gib=16.0, commit_gib=16.0) == ""
    assert memory_warning(MACOS, ram_gib=8.0, commit_gib=8.0) == ""


def test_metal_is_warned_about_the_cpu_vae_and_the_bfloat16_floor() -> None:
    """Both are properties of yue2, not of SongForge, and both look like a
    misconfiguration to someone who has not read its source."""
    warnings = warnings_for(APPLE, MACOS)
    assert any("VAE decoder runs on the CPU" in w for w in warnings)
    assert any("macOS 14" in w for w in warnings)
    assert any("experimental" in w for w in warnings), "untested support must say so"
    # The 24 GB note is about video memory and does not apply to shared memory.
    assert not any("24 GB" in w for w in warnings)


@pytest.mark.parametrize(("machine", "manager", "expected"), [
    (MACOS, "brew", ["brew", "install", "ffmpeg"]),
    (WINDOWS, "winget", ["winget", "install", "--id", "Gyan.FFmpeg"]),
])
def test_ffmpeg_comes_from_the_package_manager_that_is_there(tmp_path, monkeypatch, machine, manager, expected) -> None:
    from songforge.setup import components

    monkeypatch.setattr(components.shutil, "which", lambda name: name if name == manager else None)
    ctx = make_context(tmp_path, machine=machine)
    ran: list[list[str]] = []
    ctx.run = lambda argv, **_kwargs: ran.append([str(a) for a in argv])  # type: ignore[method-assign]
    components._install_ffmpeg(ctx)
    assert ran[0][: len(expected)] == expected


def test_ffmpeg_on_linux_names_the_command_instead_of_asking_for_root(tmp_path, monkeypatch) -> None:
    from songforge.setup import components

    monkeypatch.setattr(components.shutil, "which", lambda _name: None)
    ctx = make_context(tmp_path, machine=LINUX)
    with pytest.raises(SetupError, match="apt install ffmpeg"):
        components._install_ffmpeg(ctx)


# ------------------------------------------------------------------- updating

def test_an_update_makes_the_web_app_count_as_not_installed(tmp_path) -> None:
    """After `git pull` the old build is still in .next.

    Setup used to call that "done", so "run setup again" rebuilt nothing and
    the previous interface kept being served.
    """
    from songforge.setup.components import _frontend_fingerprint, _frontend_present

    ctx = make_context(tmp_path)
    source = ctx.frontend_dir / "src" / "app"
    source.mkdir(parents=True)
    (source / "page.tsx").write_text("export default 1;\n", encoding="utf-8")
    (ctx.frontend_dir / "package.json").write_text("{}", encoding="utf-8")
    (ctx.frontend_dir / "node_modules" / "next").mkdir(parents=True)
    build = ctx.frontend_dir / ".next"
    build.mkdir()
    (build / "BUILD_ID").write_text("abc", encoding="utf-8")
    (build / "songforge-source").write_text(_frontend_fingerprint(ctx), encoding="utf-8")
    assert _frontend_present(ctx) is True

    (source / "page.tsx").write_text("export default 2;\n", encoding="utf-8")
    assert _frontend_present(ctx) is False

    # The same file with Windows line endings is the same file.
    (source / "page.tsx").write_bytes(b"export default 1;\r\n")
    assert _frontend_present(ctx) is True


def test_building_records_what_was_built(tmp_path, monkeypatch) -> None:
    from songforge.setup import components

    monkeypatch.setattr(components.shutil, "which", lambda _name: "npm")
    ctx = make_context(tmp_path)
    ctx.dry_run = False
    (ctx.frontend_dir / "src").mkdir(parents=True)
    (ctx.frontend_dir / "src" / "a.ts").write_text("1", encoding="utf-8")
    (ctx.frontend_dir / "node_modules" / "next").mkdir(parents=True)

    def fake_run(argv, **_kwargs):
        if argv[1:] == ["run", "build"]:
            (ctx.frontend_dir / ".next").mkdir(exist_ok=True)
            (ctx.frontend_dir / ".next" / "BUILD_ID").write_text("x", encoding="utf-8")

    ctx.run = fake_run  # type: ignore[method-assign]
    components._install_frontend(ctx)
    assert components._frontend_present(ctx) is True


def test_changed_backend_requirements_count_as_not_installed(tmp_path) -> None:
    """A new version of the code may import something the old environment lacks."""
    from songforge.setup import components

    ctx = make_context(tmp_path)
    ctx.backend_dir.mkdir(parents=True)
    (ctx.backend_dir / "pyproject.toml").write_text("[project]\n", encoding="utf-8")
    (ctx.backend_dir / "constraints.txt").write_text("fastapi==0.165.0\n", encoding="utf-8")
    python = ctx.python_in(ctx.venv)
    python.parent.mkdir(parents=True)
    python.write_bytes(b"")

    stamp = ctx.venv / ".songforge-installed"
    stamp.write_text(components._backend_fingerprint(ctx), encoding="utf-8")
    assert components._stamp_matches(stamp, components._backend_fingerprint(ctx))

    (ctx.backend_dir / "constraints.txt").write_text("fastapi==0.166.0\n", encoding="utf-8")
    assert components._backend_present(ctx) is False
