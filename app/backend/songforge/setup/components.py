"""The installable pieces of SongForge, each able to check and install itself.

Every component answers two questions - "are you already here?" and "install
yourself" - and declares what it needs first. The menu does nothing but order
them, show them and call them, which keeps the interface and the work apart.

Nothing here downloads anything until ``install`` is called, and ``install`` is
only ever called for components the user ticked.

Standard library only; see this package's docstring.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from .download import DownloadError, fetch, find_wheel
from .hardware import (
    TORCH_VERSION,
    Gpu,
    Machine,
    TorchTarget,
    detect_gpu,
    detect_machine,
    torch_target,
)

# The model repository carries its own inference wheel; it is not on PyPI.
# Taken from the official model card at https://huggingface.co/m-a-p/YuE2-3B.
MODEL_REPO = "m-a-p/YuE2-3B"
VAE_REPO = "m-a-p/YuE2-Vae"
YUE2_WHEEL = "yue2_infer-0.1.5-py3-none-any.whl"
HUGGINGFACE_HUB = "huggingface-hub==0.36.2"

# The weights are not ours to relicense and not free for commercial use.
WEIGHT_LICENCE = "CC BY-NC 4.0"
WEIGHT_LICENCE_URL = "https://creativecommons.org/licenses/by-nc/4.0/"

# Only the files the runner actually loads. The repository also holds demo
# audio, figures and a PDF - about a gigabyte of material nothing reads.
MODEL_PATTERNS = ["*.json", "*.safetensors", "*.py", "*.tiktoken", "*.txt", "*.md"]

GIB = 1024 ** 3
MIN_NODE_MAJOR = 20


class SetupError(RuntimeError):
    """An install step failed for a reason worth showing the user."""


@dataclass
class Context:
    """Where things go, and what machine they are going onto."""

    root: Path
    machine: Machine
    gpu: Gpu
    torch: TorchTarget
    dry_run: bool = False
    log: Callable[[str], None] = print

    @classmethod
    def discover(cls, root: Path | None = None, **kwargs) -> Context:
        # .../app/backend/songforge/setup/components.py -> four levels to the root.
        root = root or Path(__file__).resolve().parents[4]
        machine = detect_machine()
        gpu = detect_gpu(machine)
        return cls(root=root, machine=machine, gpu=gpu,
                   torch=torch_target(gpu, machine), **kwargs)

    # --- locations -------------------------------------------------------
    @property
    def runtime(self) -> Path:
        return self.root / "runtime"

    @property
    def backend_dir(self) -> Path:
        return self.root / "app" / "backend"

    @property
    def frontend_dir(self) -> Path:
        return self.root / "app" / "frontend"

    @property
    def venv(self) -> Path:
        return self.runtime / "venv"

    @property
    def venv_yue2(self) -> Path:
        return self.runtime / "venv-yue2"

    @property
    def models_dir(self) -> Path:
        return self.runtime / "models"

    @property
    def downloads_dir(self) -> Path:
        """Large files fetched before pip sees them, kept across setup runs."""
        return self.runtime / "downloads"

    def python_in(self, venv: Path) -> Path:
        return venv / ("Scripts/python.exe" if self.machine.is_windows else "bin/python")

    # --- running things --------------------------------------------------
    def run(
        self, argv: Sequence[str], *, cwd: Path | None = None,
        env: dict[str, str] | None = None,
    ) -> None:
        """Run a command, streaming its output, and raise if it fails.

        Output is streamed rather than captured because these are multi-minute
        downloads: a silent terminal for six minutes looks like a hang.
        ``env`` adds to this process's environment rather than replacing it.
        """
        printable = " ".join(str(part) for part in argv)
        if self.dry_run:
            self.log(f"    would run: {printable}")
            return
        self.log(f"    $ {printable}")
        try:
            done = subprocess.run([str(part) for part in argv], cwd=str(cwd) if cwd else None,
                                  env={**os.environ, **env} if env else None)
        except OSError as exc:
            raise SetupError(f"Could not start {argv[0]}: {exc}") from exc
        if done.returncode != 0:
            raise SetupError(f"{argv[0]} failed with exit code {done.returncode}.")

    def run_python(self, venv: Path, code: str) -> None:
        """Run a snippet inside one of the virtual environments.

        ``-I`` isolates it from this process's environment and from whatever
        happens to sit in the working directory.
        """
        self.run([self.python_in(venv), "-I", "-c", code])


@dataclass
class Component:
    key: str
    title: str
    detail: str
    size_bytes: int
    install: Callable[[Context], None]
    present: Callable[[Context], bool]
    required: bool = False
    licence: str = ""
    needs: tuple[str, ...] = ()
    unavailable: Callable[[Context], str] | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)

    def blocked_because(self, ctx: Context) -> str:
        return self.unavailable(ctx) if self.unavailable else ""


# --------------------------------------------------------------------------
# Install steps
# --------------------------------------------------------------------------

def _create_venv(ctx: Context, path: Path) -> None:
    if ctx.python_in(path).is_file():
        return
    ctx.run([sys.executable, "-m", "venv", str(path)])


def _pip(ctx: Context, venv: Path, *arguments: str) -> None:
    ctx.run([ctx.python_in(venv), "-m", "pip", *arguments])


def _install_backend(ctx: Context) -> None:
    _create_venv(ctx, ctx.venv)
    _pip(ctx, ctx.venv, "install", "--upgrade", "pip")
    # Editable so a contributor's edits take effect without reinstalling.
    _pip(ctx, ctx.venv, "install", "-e", str(ctx.backend_dir))


def _backend_present(ctx: Context) -> bool:
    """Can that environment actually serve the app?

    The source directory is put on the path for the probe because the start
    script runs uvicorn from ``app/backend``: an environment that has the
    dependencies but not the package itself is a working install, and telling
    its owner to reinstall would be wrong.
    """
    python = ctx.python_in(ctx.venv)
    if not python.is_file():
        return False
    probe = subprocess.run(
        [str(python), "-I", "-c",
         f"import sys; sys.path.insert(0, {str(ctx.backend_dir)!r}); import songforge.main"],
        capture_output=True,
    )
    return probe.returncode == 0


def _node_problem(ctx: Context) -> str:
    node = shutil.which("node")
    if node is None:
        return f"Node.js {MIN_NODE_MAJOR}+ is not installed. See https://nodejs.org."
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return "Node.js is installed but did not respond."
    version = (out.stdout or "").strip().lstrip("v")
    major = version.split(".")[0]
    if major.isdigit() and int(major) < MIN_NODE_MAJOR:
        return f"Node.js {version} is older than the {MIN_NODE_MAJOR} this needs."
    return ""


def _install_frontend(ctx: Context) -> None:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if npm is None:
        raise SetupError("npm was not found on PATH, although node was.")
    ctx.run([npm, "install"], cwd=ctx.frontend_dir)
    # The start script serves the app with `next start`, which refuses to run
    # without a production build: "Could not find a production build in the
    # '.next' directory". Installing the packages and stopping there left a
    # setup that reported success and then could not start.
    #
    # Telemetry is turned off for this one command because Next.js writes its
    # telemetry config into the user profile, and on Windows that rename fails
    # with EXDEV when the profile is on another volume - taking the whole
    # build, and the install, down with it.
    ctx.run([npm, "run", "build"], cwd=ctx.frontend_dir,
            env={"NEXT_TELEMETRY_DISABLED": "1"})


def _frontend_present(ctx: Context) -> bool:
    """Packages installed *and* built - `next start` needs both."""
    return ((ctx.frontend_dir / "node_modules" / "next").is_dir()
            and (ctx.frontend_dir / ".next" / "BUILD_ID").is_file())


def _torch_wheel(ctx: Context) -> Path | None:
    """Fetch the PyTorch wheel ourselves, or return None to let pip do it.

    A CUDA wheel is 2.9 GB, and pip keeps it in a temporary directory while it
    downloads: when the connection drops often enough, every retry has nothing
    to resume from, and on Windows the clean-up that follows fails as
    "WinError 32" because the scanner still holds the half-written file.
    Fetching it to runtime/downloads first means an interrupted setup carries
    on from where it stopped. See download.py.
    """
    if ctx.dry_run or not ctx.torch.index_url:
        return None
    try:
        wheel = find_wheel(ctx.torch.index_url, "torch", TORCH_VERSION, ctx.machine)
    except DownloadError as exc:
        ctx.log(f"    {exc}; letting pip fetch PyTorch instead")
        return None
    if wheel is None:
        ctx.log("    no published wheel matches this machine; letting pip choose")
        return None

    destination = ctx.downloads_dir / wheel.filename
    ctx.log(f"    fetching {wheel.filename}")
    try:
        return fetch(wheel, destination, log=ctx.log)
    except DownloadError as exc:
        raise SetupError(
            f"{exc}\n"
            f"    What arrived is kept in {ctx.downloads_dir}, so running setup "
            "again continues from there.\n"
            "    If it stops at the same place every time, exclude that folder "
            "from your virus scanner, or\n"
            "    download the file yourself, put it in that folder, and run "
            f"setup again:\n      {wheel.url}"
        ) from exc


def _install_torch(ctx: Context) -> None:
    if not ctx.torch.supported:
        raise SetupError(ctx.torch.problem)
    _create_venv(ctx, ctx.venv_yue2)
    _pip(ctx, ctx.venv_yue2, "install", "--upgrade", "pip")
    wheel = _torch_wheel(ctx)
    if wheel is None:
        _pip(ctx, ctx.venv_yue2, "install", *ctx.torch.pip_arguments)
        return
    # Only the large wheel comes from disk; torch's own dependencies are still
    # resolved from the index that matches this build.
    arguments = [str(wheel)]
    if ctx.torch.index_url:
        arguments += ["--index-url", ctx.torch.index_url]
    _pip(ctx, ctx.venv_yue2, "install", *arguments)


def _torch_present(ctx: Context) -> bool:
    python = ctx.python_in(ctx.venv_yue2)
    if not python.is_file():
        return False
    return subprocess.run([str(python), "-I", "-c", "import torch"],
                          capture_output=True).returncode == 0


def _install_yue2(ctx: Context) -> None:
    """Fetch the inference wheel from the model repository and install it.

    yue2_infer is not published on PyPI. The official model card distributes it
    as a file inside m-a-p/YuE2-3B, so huggingface-hub is the only way to get
    it and is installed first.
    """
    _pip(ctx, ctx.venv_yue2, "install", HUGGINGFACE_HUB)
    wheel_dir = ctx.runtime
    ctx.run_python(ctx.venv_yue2, (
        "from huggingface_hub import hf_hub_download;"
        f"p=hf_hub_download({MODEL_REPO!r}, {YUE2_WHEEL!r}, local_dir={str(wheel_dir)!r});"
        "print(p)"
    ))
    # --no-deps would skip torch, which is already installed from the right
    # index; letting pip resolve here would pull the default CUDA build over it.
    _pip(ctx, ctx.venv_yue2, "install", "--no-deps", str(wheel_dir / YUE2_WHEEL))
    _pip(ctx, ctx.venv_yue2, "install",
         "transformers==4.57.6", "safetensors==0.7.0", "tiktoken==0.12.0",
         "numpy==2.2.6", "soundfile==0.13.1", "accelerate==1.13.0")


def _yue2_present(ctx: Context) -> bool:
    python = ctx.python_in(ctx.venv_yue2)
    if not python.is_file():
        return False
    return subprocess.run([str(python), "-I", "-c", "import yue2"],
                          capture_output=True).returncode == 0


def _download(ctx: Context, repo: str, destination: Path) -> None:
    patterns = ", ".join(repr(p) for p in MODEL_PATTERNS)
    ctx.run_python(ctx.venv_yue2, (
        "from huggingface_hub import snapshot_download;"
        f"snapshot_download({repo!r}, local_dir={str(destination)!r},"
        f" allow_patterns=[{patterns}])"
    ))


def _install_model(ctx: Context) -> None:
    _download(ctx, MODEL_REPO, ctx.models_dir / "YuE2-3B")


def _install_vae(ctx: Context) -> None:
    _download(ctx, VAE_REPO, ctx.models_dir / "YuE2-Vae")


def _weights_present(ctx: Context, folder: str) -> bool:
    return (ctx.models_dir / folder / "model.safetensors").is_file()


def _ollama_executable(ctx: Context) -> str | None:
    bundled = ctx.runtime / "ollama" / ("ollama.exe" if ctx.machine.is_windows else "ollama")
    if bundled.is_file():
        return str(bundled)
    return shutil.which("ollama")


def _install_lyrics_model(ctx: Context) -> None:
    """Pull a lyrics model through an Ollama the user already has.

    Installing Ollama itself is deliberately not automated: it is a system
    service with its own installer on every platform, and silently placing one
    on someone's machine is not setup's business. When it is absent we say so
    and move on - the app works without it.
    """
    from .hardware import recommended_lyrics_model

    ollama = _ollama_executable(ctx)
    if ollama is None:
        raise SetupError(
            "Ollama is not installed. Get it from https://ollama.com, then run "
            "setup again and tick this item - or skip it entirely and write "
            "your own lyrics."
        )
    ctx.run([ollama, "pull", recommended_lyrics_model(ctx.gpu)])


def _lyrics_model_present(ctx: Context) -> bool:
    """Is the recommended lyrics model already pulled?

    Read from the manifest directory rather than by running ``ollama list``,
    which needs the server up and the model path in the environment - neither
    of which is true while setup is running.
    """
    from .hardware import recommended_lyrics_model

    name, _, tag = recommended_lyrics_model(ctx.gpu).partition(":")
    roots = [ctx.models_dir / "ollama", Path.home() / ".ollama" / "models"]
    env_root = os.environ.get("OLLAMA_MODELS")
    if env_root:
        roots.insert(0, Path(env_root))
    for root in roots:
        manifest = root / "manifests" / "registry.ollama.ai" / "library" / name
        if (manifest / tag).is_file() if tag else manifest.is_dir():
            return True
    return False


def _install_ffmpeg(ctx: Context) -> None:
    raise SetupError(
        "FFmpeg has to come from your platform's package manager: "
        "winget install Gyan.FFmpeg, brew install ffmpeg, or apt install ffmpeg. "
        "Without it SongForge still renders FLAC; only MP3 and WAV export need it."
    )


# --------------------------------------------------------------------------
# The catalogue
# --------------------------------------------------------------------------

def catalogue(ctx: Context) -> list[Component]:
    """Every component, in install order."""
    torch_size = {"CPU": 1 * GIB}.get(ctx.torch.label, 3 * GIB)
    return [
        Component(
            key="backend",
            title="Python backend environment",
            detail="FastAPI, SQLModel and SongForge itself, in runtime/venv.",
            size_bytes=120 * 1024 * 1024,
            required=True,
            install=_install_backend,
            present=_backend_present,
        ),
        Component(
            key="frontend",
            title="Node.js frontend packages",
            detail="Next.js and its dependencies, then a production build of the web app.",
            size_bytes=520 * 1024 * 1024,
            required=True,
            install=_install_frontend,
            present=_frontend_present,
            unavailable=_node_problem,
        ),
        Component(
            key="torch",
            title=f"PyTorch 2.10.0 for {ctx.torch.label}",
            detail="The tensor library YuE2 runs on, in its own environment.",
            size_bytes=torch_size,
            required=True,
            install=_install_torch,
            present=_torch_present,
            unavailable=lambda c: "" if c.torch.supported else c.torch.problem,
            notes=(f"Chosen for: {ctx.gpu.describe()}",),
        ),
        Component(
            key="yue2",
            title="YuE2 inference package",
            detail=f"The yue2_infer wheel, published inside {MODEL_REPO}.",
            size_bytes=2 * 1024 * 1024,
            required=True,
            needs=("torch",),
            install=_install_yue2,
            present=_yue2_present,
        ),
        Component(
            key="model",
            title=f"YuE2-3B weights ({MODEL_REPO})",
            detail="The model that writes and performs the music.",
            size_bytes=13 * GIB,
            required=True,
            licence=WEIGHT_LICENCE,
            needs=("yue2",),
            install=_install_model,
            present=lambda c: _weights_present(c, "YuE2-3B"),
        ),
        Component(
            key="vae",
            title=f"YuE2 VAE weights ({VAE_REPO})",
            detail="Turns the model's latents into audio.",
            size_bytes=1400 * 1024 * 1024,
            required=True,
            licence=WEIGHT_LICENCE,
            needs=("yue2",),
            install=_install_vae,
            present=lambda c: _weights_present(c, "YuE2-Vae"),
        ),
        Component(
            key="lyrics",
            title="Local lyrics writer (Ollama)",
            detail="Optional. Writes lyrics for you; you can always write your own.",
            size_bytes=9 * GIB,
            required=False,
            needs=(),
            install=_install_lyrics_model,
            present=_lyrics_model_present,
            notes=("Needs Ollama from https://ollama.com. SongForge works without it.",),
        ),
        Component(
            key="ffmpeg",
            title="FFmpeg",
            detail="Optional. Only MP3 and WAV export need it; FLAC never does.",
            size_bytes=90 * 1024 * 1024,
            required=False,
            install=_install_ffmpeg,
            present=lambda c: shutil.which("ffmpeg") is not None,
        ),
    ]


def free_space_bytes(path: Path) -> int:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        return shutil.disk_usage(probe).free
    except OSError:
        return 0


def format_size(size: int) -> str:
    if size >= GIB:
        return f"{size / GIB:.1f} GB"
    return f"{size / (1024 ** 2):.0f} MB"


def write_profile(ctx: Context) -> Path:
    """Record the detected hardware where the backend can read it on first run.

    A file rather than a database write: setup must work before the database
    exists, and the backend seeds AppSettings from this on its first start.
    """
    import json

    from .hardware import settings_profile

    profile = {
        "gpu": {
            "vendor": ctx.gpu.vendor,
            "name": ctx.gpu.name,
            "memory_gib": ctx.gpu.memory_gib,
            "compute": list(ctx.gpu.compute) if ctx.gpu.compute else None,
            "driver": ctx.gpu.driver,
        },
        "torch": ctx.torch.label,
        "settings": settings_profile(ctx.gpu),
        "paths": {
            "python_executable": str(ctx.python_in(ctx.venv_yue2)),
            "model_path": str(ctx.models_dir / "YuE2-3B"),
            "vae_path": str(ctx.models_dir / "YuE2-Vae"),
        },
    }
    ctx.runtime.mkdir(parents=True, exist_ok=True)
    destination = ctx.runtime / "hardware-profile.json"
    if not ctx.dry_run:
        destination.write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")
    return destination


__all__ = [
    "Component", "Context", "SetupError", "catalogue", "format_size",
    "free_space_bytes", "write_profile", "WEIGHT_LICENCE", "WEIGHT_LICENCE_URL",
    "MODEL_REPO", "VAE_REPO",
]
