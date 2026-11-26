"""The installable pieces of SongForge, each able to check and install itself.

Every component answers two questions - "are you already here?" and "install
yourself" - and declares what it needs first. The menu does nothing but order
them, show them and call them, which keeps the interface and the work apart.

Nothing here downloads anything until ``install`` is called, and ``install`` is
only ever called for components the user ticked.

Standard library only; see this package's docstring.
"""
from __future__ import annotations

import hashlib
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

# Exactly what was tested, not "whatever the repositories hold today". The
# wheel is code that setup installs and runs, and the model repository also
# carries a Python file; a branch name would let a later push - by the authors
# or by whoever took over their account - change what every new install gets.
# A commit id cannot be moved, and the wheel is checked against its own hash
# on top of that. To move to a newer upstream release, change these three
# together after testing it.
MODEL_REVISION = "8f24312f187763b9854adeec87e437e2b03bbff1"
VAE_REVISION = "152733a19ad43aa67e367f9b5503ef8075bb5126"
YUE2_WHEEL_SHA256 = "8801e2c0d969db02df78d2994150b4ccd86077d87c24fdb8509b1f6f31462641"

# The way out if upstream ever rewrites its history and the pinned commits
# stop existing: SONGFORGE_UNPINNED_MODEL=1 downloads the newest files instead.
# The wheel's hash is still checked - that part has no override.
UNPINNED_ENV = "SONGFORGE_UNPINNED_MODEL"
HUGGINGFACE_HUB = "huggingface-hub==0.36.2"

# The weights are not ours to relicense and not free for commercial use.
WEIGHT_LICENCE = "CC BY-NC 4.0"
WEIGHT_LICENCE_URL = "https://creativecommons.org/licenses/by-nc/4.0/"

# Only the files the runner actually loads. The repository also holds demo
# audio, figures and a PDF - about a gigabyte of material nothing reads.
MODEL_PATTERNS = ["*.json", "*.safetensors", "*.py", "*.tiktoken", "*.txt", "*.md"]

GIB = 1024 ** 3
MIN_NODE_MAJOR = 20

# Download sizes, from the repositories' own weights_manifest.json. They were
# once written here as 13 GB and 1.4 GB - nearly double the truth - which told
# anyone with 12 GB free that they had no room for a 7 GB download.
MODEL_BYTES = 7_261_441_640
VAE_BYTES = 530_512_720

# Approximate pull sizes of the lyrics models setup may recommend.
LYRICS_MODEL_BYTES = {
    "gemma4:12b": 9 * GIB,
    "gemma3:4b": int(3.3 * GIB),
    "gemma3:1b": int(0.8 * GIB),
}


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
        # Hugging Face's client reports usage statistics unless told not to.
        # SongForge promises that nothing but the downloads themselves leaves
        # the machine, so setup says no on the user's behalf.
        self.run([self.python_in(venv), "-I", "-c", code],
                 env={"HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1"})


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

# --------------------------------------------------------------------------
# Knowing when an installed component is out of date
# --------------------------------------------------------------------------
#
# "Is it there?" is not the whole question. After `git pull` the web app's
# build is there and is the old interface; the backend's environment is there
# and may be missing a dependency the new code imports. Each of those records
# a fingerprint of what it was built from, and counts as installed only while
# the fingerprint still matches - so "run setup again" really is the whole of
# updating.

def _fingerprint(paths: Sequence[Path], root: Path) -> str:
    """A hash of the given files' names and contents, in a stable order."""
    import hashlib

    digest = hashlib.sha256()
    for path in sorted(paths):
        try:
            data = path.read_bytes()
        except OSError:
            continue
        # Line endings differ between a Windows and a Unix checkout of the
        # same commit; they must not make an unchanged file look changed.
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(data.replace(b"\r\n", b"\n"))
        digest.update(b"\0")
    return digest.hexdigest()


def _frontend_fingerprint(ctx: Context) -> str:
    root = ctx.frontend_dir
    files = [root / name for name in
             ("package.json", "package-lock.json", "next.config.ts", "postcss.config.mjs",
              "tsconfig.json")]
    for folder in ("src", "public"):
        base = root / folder
        if base.is_dir():
            files += [path for path in base.rglob("*") if path.is_file()]
    return _fingerprint([path for path in files if path.is_file()], root)


def _backend_fingerprint(ctx: Context) -> str:
    root = ctx.backend_dir
    return _fingerprint(
        [path for path in (root / "pyproject.toml", root / "constraints.txt") if path.is_file()],
        root,
    )


def _stamp_matches(stamp: Path, expected: str) -> bool:
    try:
        return stamp.read_text(encoding="utf-8").strip() == expected
    except OSError:
        return False


def _write_stamp(ctx: Context, stamp: Path, value: str) -> None:
    if ctx.dry_run:
        return
    try:
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.write_text(value + "\n", encoding="utf-8")
    except OSError:
        # Without the stamp the component is simply rebuilt next time.
        pass


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
    #
    # constraints.txt holds the exact versions the test suite passed on. The
    # requirements themselves are ranges, so without it every fresh install
    # resolves to whatever was published that morning, and an upstream release
    # can break setup for everyone without a single change here. If the
    # constrained set cannot be installed on this machine - a platform one of
    # the pinned wheels was never built for - the ranges are used instead:
    # a working install on newer versions beats no install.
    constraints = ctx.backend_dir / "constraints.txt"
    if not constraints.is_file():
        _pip(ctx, ctx.venv, "install", "-e", str(ctx.backend_dir))
    else:
        try:
            _pip(ctx, ctx.venv, "install", "-c", str(constraints), "-e", str(ctx.backend_dir))
        except SetupError:
            ctx.log("    the tested versions could not be installed on this machine;")
            ctx.log("    trying the newest compatible ones instead")
            _pip(ctx, ctx.venv, "install", "-e", str(ctx.backend_dir))
    _write_stamp(ctx, ctx.venv / ".songforge-installed", _backend_fingerprint(ctx))


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
    # The dependencies it was installed with must be the ones this version of
    # the code declares; after an update they may not be.
    if not _stamp_matches(ctx.venv / ".songforge-installed", _backend_fingerprint(ctx)):
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
    # `npm ci` installs exactly what package-lock.json records, so every
    # machine gets the versions the app was built and tested with; `npm
    # install` may quietly pick newer ones. The audit and funding notices are
    # switched off because, to someone installing an app, a red "3
    # vulnerabilities" line in the middle of setup reads as a failed install.
    quiet = ["--no-audit", "--no-fund"]
    if (ctx.frontend_dir / "package-lock.json").is_file():
        try:
            ctx.run([npm, "ci", *quiet], cwd=ctx.frontend_dir)
        except SetupError:
            ctx.log("    npm ci did not complete; falling back to npm install")
            ctx.run([npm, "install", *quiet], cwd=ctx.frontend_dir)
    else:
        ctx.run([npm, "install", *quiet], cwd=ctx.frontend_dir)
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
    _write_stamp(ctx, ctx.frontend_dir / ".next" / "songforge-source",
                 _frontend_fingerprint(ctx))


def _frontend_present(ctx: Context) -> bool:
    """Packages installed, built, and built from the source that is here now.

    `next start` needs the first two. The third is what makes an update take
    effect: after `git pull` the old build is still sitting in .next, and
    without this check setup called it "done" and the old interface kept
    being served.
    """
    if not ((ctx.frontend_dir / "node_modules" / "next").is_dir()
            and (ctx.frontend_dir / ".next" / "BUILD_ID").is_file()):
        return False
    return _stamp_matches(ctx.frontend_dir / ".next" / "songforge-source",
                          _frontend_fingerprint(ctx))


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
        f"p=hf_hub_download({MODEL_REPO!r}, {YUE2_WHEEL!r}, local_dir={str(wheel_dir)!r},"
        f" revision={_revision(MODEL_REVISION)!r});"
        "print(p)"
    ))
    _verify_wheel(ctx, wheel_dir / YUE2_WHEEL)
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


def _revision(pinned: str) -> str | None:
    """The commit to download: the pinned one, unless the override is set."""
    if os.environ.get(UNPINNED_ENV, "").strip().lower() in ("1", "true", "yes"):
        return None
    return pinned


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _verify_wheel(ctx: Context, wheel: Path) -> None:
    """Refuse to install an inference wheel that is not the one that was tested.

    This is the one download that is executed rather than read, so it is the
    one that gets a hash. A mismatch deletes the file: leaving it would let the
    next run find it "already downloaded".
    """
    if ctx.dry_run:
        return
    if not wheel.is_file():
        raise SetupError(f"The download finished but {wheel} is not there. Run setup again.")
    actual = file_sha256(wheel)
    if actual != YUE2_WHEEL_SHA256:
        wheel.unlink(missing_ok=True)
        raise SetupError(
            f"{wheel.name} does not match the version SongForge was tested with "
            f"(sha256 {actual[:16]}..., expected {YUE2_WHEEL_SHA256[:16]}...). It was "
            "not installed and has been deleted. Run setup again; if this keeps "
            "happening, update SongForge (git pull) or report it - do not install "
            "the file by hand."
        )
    ctx.log("    verified: the inference wheel matches its recorded checksum")


def _download(ctx: Context, repo: str, destination: Path, pinned: str) -> None:
    patterns = ", ".join(repr(p) for p in MODEL_PATTERNS)
    revision = _revision(pinned)
    if revision is None:
        ctx.log(f"    {UNPINNED_ENV} is set: downloading the newest files of {repo}, "
                "not the tested revision.")
    try:
        ctx.run_python(ctx.venv_yue2, (
            "from huggingface_hub import snapshot_download;"
            f"snapshot_download({repo!r}, local_dir={str(destination)!r},"
            f" revision={revision!r}, allow_patterns=[{patterns}])"
        ))
    except SetupError as exc:
        if revision is None:
            raise
        raise SetupError(
            f"{exc} If the message above says the revision was not found, {repo} "
            "no longer publishes the files SongForge was tested with: update "
            f"SongForge (git pull) and run setup again, or set {UNPINNED_ENV}=1 "
            "to download the newest files instead."
        ) from exc


def _install_model(ctx: Context) -> None:
    _download(ctx, MODEL_REPO, ctx.models_dir / "YuE2-3B", MODEL_REVISION)
    _verify_weights(ctx, "YuE2-3B")


def _install_vae(ctx: Context) -> None:
    _download(ctx, VAE_REPO, ctx.models_dir / "YuE2-Vae", VAE_REVISION)
    _verify_weights(ctx, "YuE2-Vae")


def _expected_weight_bytes(folder: Path) -> int | None:
    """The size the repository's own manifest says the weights should be."""
    import json

    try:
        manifest = json.loads((folder / "weights_manifest.json").read_text(encoding="utf-8"))
        return int(manifest["files"]["model.safetensors"]["bytes"])
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _weights_present(ctx: Context, folder: str) -> bool:
    """Present, and the size the manifest says.

    A file that merely exists is not enough: a copy interrupted half way, or a
    disk that filled up, leaves a model.safetensors that looks installed and
    then fails at the first render. A wrong-sized file counts as missing, so
    running setup again repairs it.
    """
    target = ctx.models_dir / folder / "model.safetensors"
    if not target.is_file():
        return False
    expected = _expected_weight_bytes(ctx.models_dir / folder)
    return expected is None or target.stat().st_size == expected


def _verify_weights(ctx: Context, folder: str) -> None:
    if ctx.dry_run:
        return
    target = ctx.models_dir / folder / "model.safetensors"
    expected = _expected_weight_bytes(ctx.models_dir / folder)
    if not target.is_file():
        raise SetupError(
            f"The download finished but {target} is not there. Check the free "
            "space on this drive and run setup again."
        )
    actual = target.stat().st_size
    if expected is not None and actual != expected:
        raise SetupError(
            f"{target.name} in {folder} is {actual:,} bytes; it should be "
            f"{expected:,}. The download was cut short. Run setup again - it "
            "continues from what is already there."
        )
    ctx.log(f"    verified: {format_size(actual)}, matching the published size")


def _ollama_executable(ctx: Context) -> str | None:
    """Ollama, wherever its installer put it.

    PATH alone is not enough: an Ollama installed a minute ago - by this very
    setup run - is on the PATH of new terminals, not of this process.
    """
    bundled = ctx.runtime / "ollama" / ("ollama.exe" if ctx.machine.is_windows else "ollama")
    if bundled.is_file():
        return str(bundled)
    found = shutil.which("ollama")
    if found:
        return found
    candidates: list[Path] = []
    if ctx.machine.is_windows:
        local = os.environ.get("LOCALAPPDATA")
        if local:
            candidates.append(Path(local) / "Programs" / "Ollama" / "ollama.exe")
        candidates.append(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Ollama" / "ollama.exe")
    elif ctx.machine.is_macos:
        candidates += [
            Path("/opt/homebrew/bin/ollama"),
            Path("/usr/local/bin/ollama"),
            Path("/Applications/Ollama.app/Contents/Resources/ollama"),
        ]
    else:
        candidates += [Path("/usr/local/bin/ollama"), Path("/usr/bin/ollama")]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def ollama_installer(ctx: Context) -> list[str] | None:
    """A command that installs Ollama here, or None if there is no safe one.

    Only package managers the user already has. On Linux the official route is
    piping a script into a root shell, which setup will describe but will not
    do on anyone's behalf.
    """
    if ctx.machine.is_windows and shutil.which("winget"):
        return ["winget", "install", "--id", "Ollama.Ollama", "-e",
                "--accept-package-agreements", "--accept-source-agreements"]
    if ctx.machine.is_macos and shutil.which("brew"):
        return ["brew", "install", "ollama"]
    return None


def ollama_manual_instructions(ctx: Context) -> str:
    if ctx.machine.is_linux:
        return ("Install Ollama with its official script, then run setup again:\n"
                "      curl -fsSL https://ollama.com/install.sh | sh")
    return "Download Ollama from https://ollama.com, install it, then run setup again."


def lyrics_model_name(ctx: Context) -> str:
    from .hardware import recommended_lyrics_model

    return recommended_lyrics_model(ctx.gpu)


def _ollama_answers(ollama: str) -> bool:
    try:
        done = subprocess.run([ollama, "list"], capture_output=True, timeout=20,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


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
            "Ollama is not installed, so the lyrics writer was skipped. "
            "SongForge works without it. " + ollama_manual_instructions(ctx)
        )
    model = recommended_lyrics_model(ctx.gpu)
    if ctx.dry_run:
        ctx.run([ollama, "pull", model])
        return

    # `ollama pull` talks to the Ollama server, which is only running if its
    # tray app is. Start one for the length of the download when it is not,
    # rather than failing with "could not connect to ollama app".
    import time

    server = None
    if not _ollama_answers(ollama):
        ctx.log("    starting Ollama for the download")
        try:
            server = subprocess.Popen(
                [ollama, "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            raise SetupError(f"Could not start Ollama: {exc}") from exc
        deadline = time.monotonic() + 40
        while time.monotonic() < deadline and not _ollama_answers(ollama):
            if server.poll() is not None:
                break
            time.sleep(1)
    try:
        ctx.run([ollama, "pull", model])
    finally:
        if server is not None and server.poll() is None:
            server.terminate()


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
    """Through a package manager the user already has, where that is safe.

    Homebrew and winget both install for the current user without elevation.
    On Linux the package manager wants root, which setup never asks for, so
    the command is named instead of run.
    """
    if ctx.machine.is_macos and shutil.which("brew"):
        ctx.run(["brew", "install", "ffmpeg"])
        return
    if ctx.machine.is_windows and shutil.which("winget"):
        ctx.run(["winget", "install", "--id", "Gyan.FFmpeg", "-e",
                 "--accept-package-agreements", "--accept-source-agreements"])
        ctx.log("    FFmpeg is found by SongForge the next time it is started.")
        return
    how = ("install Homebrew from https://brew.sh and run setup again" if ctx.machine.is_macos
           else "run: winget install Gyan.FFmpeg" if ctx.machine.is_windows
           else "use your package manager, e.g. sudo apt install ffmpeg")
    raise SetupError(
        f"FFmpeg could not be installed automatically here; {how}. "
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
            size_bytes=MODEL_BYTES,
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
            size_bytes=VAE_BYTES,
            required=True,
            licence=WEIGHT_LICENCE,
            needs=("yue2",),
            install=_install_vae,
            present=lambda c: _weights_present(c, "YuE2-Vae"),
        ),
        Component(
            key="lyrics",
            title=f"Lyrics writer ({lyrics_model_name(ctx)} via Ollama)",
            detail="Optional. Writes lyrics for you; you can always write your own.",
            size_bytes=LYRICS_MODEL_BYTES.get(lyrics_model_name(ctx), 4 * GIB),
            required=False,
            needs=(),
            install=_install_lyrics_model,
            present=_lyrics_model_present,
            notes=(
                ("Ollama is installed." if _ollama_executable(ctx) else
                 "Needs Ollama (https://ollama.com), which is not installed yet.")
                + " SongForge works without this.",
            ),
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
    "MODEL_REPO", "VAE_REPO", "MODEL_BYTES", "VAE_BYTES",
    "ollama_installer", "ollama_manual_instructions", "lyrics_model_name",
]
