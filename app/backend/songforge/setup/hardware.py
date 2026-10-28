"""What this machine is, and what that implies.

Two questions are answered here and nowhere else:

1. Which PyTorch build should be installed? Getting this wrong is the single
   most expensive mistake an installer can make - a CPU wheel on a CUDA card
   renders at a fiftieth of the speed and nothing reports an error.
2. What generation settings suit this card? SongForge was written against one
   12 GB RTX 3060 and its defaults were that card's numbers. They are derived
   here instead.

Standard library only: this runs before PyTorch exists, so the GPU is
identified from vendor tools rather than from torch itself.
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Literal

Vendor = Literal["nvidia", "apple", "amd", "cpu"]

# The interpreter floor. setup itself runs on anything from 3.9 up - it is
# standard library only on purpose - but the venv it builds comes from
# whatever interpreter is running it, and the backend needs 3.12.
REQUIRED_PYTHON = (3, 12)

# yue2_infer pins this exactly, so every variant we install must match it.
TORCH_VERSION = "2.10.0"

# Minimum driver for the CUDA 12.8 wheels, per NVIDIA's compatibility table.
# Below this the wheels load and then fail at the first kernel launch, which
# is a far worse experience than being told to update the driver.
MIN_DRIVER_WINDOWS = 528.33
MIN_DRIVER_LINUX = 525.60

# Upstream YuE2 states 24 GB. SongForge runs it on 12 GB with AR offload and
# the attention shim; below this we warn rather than refuse, because "it works
# on my 3060" is the entire reason this project exists.
COMFORTABLE_VRAM_GIB = 24.0
MINIMUM_VRAM_GIB = 8.0


@dataclass(frozen=True)
class Machine:
    """The host, as far as setup needs to know it."""

    system: str  # "Windows", "Darwin", "Linux"
    machine: str  # "AMD64", "arm64", "x86_64"
    python: tuple[int, int, int]

    @property
    def is_windows(self) -> bool:
        return self.system == "Windows"

    @property
    def is_macos(self) -> bool:
        return self.system == "Darwin"

    @property
    def is_linux(self) -> bool:
        return self.system == "Linux"


@dataclass(frozen=True)
class Gpu:
    """The accelerator we will generate on, or the CPU if there is none."""

    vendor: Vendor
    name: str
    memory_gib: float | None = None
    compute: tuple[int, int] | None = None  # NVIDIA compute capability
    driver: str | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def is_accelerated(self) -> bool:
        return self.vendor != "cpu"

    def describe(self) -> str:
        parts = [self.name]
        if self.memory_gib:
            parts.append(f"{self.memory_gib:.0f} GB")
        if self.compute:
            parts.append(f"compute {self.compute[0]}.{self.compute[1]}")
        if self.driver:
            parts.append(f"driver {self.driver}")
        return ", ".join(parts)


@dataclass(frozen=True)
class TorchTarget:
    """Which PyTorch to install, and whether we can install it at all."""

    label: str
    index_url: str | None  # None means plain PyPI
    packages: tuple[str, ...]
    supported: bool = True
    problem: str = ""

    @property
    def pip_arguments(self) -> list[str]:
        args = list(self.packages)
        if self.index_url:
            args += ["--index-url", self.index_url]
        return args


def detect_machine() -> Machine:
    return Machine(
        system=platform.system(),
        machine=platform.machine(),
        python=tuple(int(part) for part in platform.python_version_tuple()[:3]),  # type: ignore[arg-type]
    )


def _run(argv: list[str], timeout: float = 15.0) -> str:
    """A vendor tool's stdout, or "" if it is missing, slow or unhappy.

    Detection must never be the reason setup fails, so every failure mode here
    collapses to "this vendor is not present".
    """
    if shutil.which(argv[0]) is None:
        return ""
    try:
        done = subprocess.run(
            argv, capture_output=True, text=True, timeout=timeout,
            # Vendor tools occasionally pop a console window on Windows.
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout if done.returncode == 0 else ""


def _detect_nvidia() -> Gpu | None:
    # compute_cap is only in newer drivers; ask for it separately so an old
    # driver still yields a name and a memory size.
    out = _run([
        "nvidia-smi",
        "--query-gpu=name,memory.total,driver_version",
        "--format=csv,noheader,nounits",
    ])
    if not out.strip():
        return None
    first = out.strip().splitlines()[0]
    fields = [part.strip() for part in first.split(",")]
    if len(fields) < 3:
        return None
    name, memory_mib, driver = fields[0], fields[1], fields[2]
    try:
        memory_gib = float(memory_mib) / 1024.0
    except ValueError:
        memory_gib = None

    compute: tuple[int, int] | None = None
    cap = _run([
        "nvidia-smi", "--query-gpu=compute_cap", "--format=csv,noheader",
    ]).strip().splitlines()
    if cap:
        match = re.match(r"\s*(\d+)\.(\d+)", cap[0])
        if match:
            compute = (int(match.group(1)), int(match.group(2)))

    return Gpu(vendor="nvidia", name=name, memory_gib=memory_gib,
               compute=compute, driver=driver)


def system_memory_gib() -> float | None:
    """How much RAM this machine has, without leaving the standard library.

    Needed in two places: Apple Silicon has no separate VRAM, and a CPU-only
    run still has to be given a positive memory budget. ctypes is used on
    Windows because there is no portable stdlib call for this.
    """
    try:
        if platform.system() == "Windows":
            import ctypes

            class _Status(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong),
                            ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong),
                            ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong),
                            ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            status = _Status()
            status.dwLength = ctypes.sizeof(_Status)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return None
            return status.ullTotalPhys / (1024 ** 3)
        out = _run(["sysctl", "-n", "hw.memsize"]).strip()
        if out.isdigit():
            return int(out) / (1024 ** 3)
        pages = os.sysconf("SC_PHYS_PAGES")
        return pages * os.sysconf("SC_PAGE_SIZE") / (1024 ** 3)
    except Exception:
        # Every failure here means the same thing: fall back to a guess.
        return None


def _detect_apple(machine: Machine) -> Gpu | None:
    if not (machine.is_macos and machine.machine in ("arm64", "aarch64")):
        return None
    # Apple Silicon shares one pool between CPU and GPU, so "VRAM" is RAM.
    memory_gib = system_memory_gib()
    name = _run(["sysctl", "-n", "machdep.cpu.brand_string"]).strip() or "Apple Silicon"
    return Gpu(vendor="apple", name=name, memory_gib=memory_gib,
               notes=("Memory is shared with the system, so the budget is a share of RAM.",))


def _detect_amd(machine: Machine) -> Gpu | None:
    if not machine.is_linux:
        # ROCm has no usable Windows PyTorch, and no macOS build at all.
        return None
    out = _run(["rocm-smi", "--showproductname"])
    if not out.strip():
        out = _run(["rocminfo"])
    if not out.strip():
        return None
    name = "AMD GPU"
    match = re.search(r"(?:Card series|Marketing Name|Card model):\s*(.+)", out)
    if match:
        name = match.group(1).strip()
    memory_gib = None
    vram = re.search(r"(\d+)\s*(?:MiB|MB)", _run(["rocm-smi", "--showmeminfo", "vram"]))
    if vram:
        memory_gib = int(vram.group(1)) / 1024.0
    return Gpu(vendor="amd", name=name, memory_gib=memory_gib)


def detect_gpu(machine: Machine | None = None) -> Gpu:
    """The best accelerator found, or a CPU placeholder.

    NVIDIA is probed first because a machine with both an NVIDIA card and an
    integrated AMD one should use the NVIDIA card.
    """
    machine = machine or detect_machine()
    if os.environ.get("SONGFORGE_FORCE_CPU"):
        return Gpu(vendor="cpu", name="CPU (forced by SONGFORGE_FORCE_CPU)")
    for probe in (_detect_nvidia, lambda: _detect_apple(machine), lambda: _detect_amd(machine)):
        found = probe()
        if found is not None:
            return found
    return Gpu(vendor="cpu", name=platform.processor() or "CPU")


def _driver_is_new_enough(gpu: Gpu, machine: Machine) -> bool:
    if not gpu.driver:
        return True  # Unknown: let the install proceed rather than block it.
    try:
        version = float(".".join(gpu.driver.split(".")[:2]))
    except ValueError:
        return True
    minimum = MIN_DRIVER_WINDOWS if machine.is_windows else MIN_DRIVER_LINUX
    return version >= minimum


def torch_target(gpu: Gpu, machine: Machine | None = None) -> TorchTarget:
    """The PyTorch build for this machine."""
    machine = machine or detect_machine()
    package = f"torch=={TORCH_VERSION}"

    if gpu.vendor == "nvidia":
        if not _driver_is_new_enough(gpu, machine):
            minimum = MIN_DRIVER_WINDOWS if machine.is_windows else MIN_DRIVER_LINUX
            return TorchTarget(
                label="CUDA 12.8", index_url=None, packages=(package,), supported=False,
                problem=(f"Driver {gpu.driver} is older than {minimum}, which the CUDA 12.8 "
                         "build needs. Update the NVIDIA driver and run setup again."),
            )
        return TorchTarget(
            label="CUDA 12.8",
            index_url="https://download.pytorch.org/whl/cu128",
            packages=(package,),
        )

    if gpu.vendor == "apple":
        # Metal support is in the ordinary PyPI wheel; there is no index for it.
        return TorchTarget(label="Apple Metal (MPS)", index_url=None, packages=(package,))

    if gpu.vendor == "amd":
        if not machine.is_linux:
            return TorchTarget(
                label="ROCm", index_url=None, packages=(package,), supported=False,
                problem="ROCm PyTorch exists for Linux only. On Windows, use the CPU option.",
            )
        return TorchTarget(
            label="ROCm 6.3",
            index_url="https://download.pytorch.org/whl/rocm6.3",
            packages=(package,),
        )

    return TorchTarget(
        label="CPU",
        index_url="https://download.pytorch.org/whl/cpu",
        packages=(package,),
    )


def settings_profile(gpu: Gpu) -> dict:
    """Generation settings suited to this card.

    These replace the constants that were a 12 GB RTX 3060's numbers:
    ``memory_budget_gib = 11.0``, AR offload always on, fp8 never available.

    - The budget leaves headroom for the desktop compositor and for PyTorch's
      own allocator; one GiB on a small card, two on a large one.
    - AR offload trades speed for memory and is only worth it when memory is
      the binding constraint.
    - fp8 needs compute capability 8.9 (Ada / Hopper). On anything older it is
      not slower, it simply does not run.
    """
    memory = gpu.memory_gib
    profile: dict = {
        "gpu_index": 0,
        "backend_mode": "torch-eager",
        "quantization": "none",
        "memory_efficient_attention": True,
    }

    if gpu.vendor == "apple":
        # Unified memory: taking much more than half starves the rest of macOS,
        # so the budget is a share rather than the whole pool.
        #
        # The floor wins below about 10 GB of RAM, where the share would be
        # under 6 GiB and yue2's own 2 GiB reserve would leave too little to
        # load a 3B model at all. On an 8 GB machine it therefore asks for 75%
        # rather than 60% - deliberately optimistic, because the alternative
        # number cannot work either, and warnings_for() already says the card
        # is below what this needs.
        usable = (memory or 16.0) * 0.6
        profile["memory_budget_gib"] = round(max(6.0, usable), 1)
        profile["offload_ar"] = True
    elif gpu.vendor == "cpu":
        # yue2 refuses a non-positive budget outright (pipeline.py:
        # "memory_budget_gib must be positive") and then subtracts a 2 GiB
        # reserve from it, so "no video memory" cannot be expressed as 0.0 -
        # it has to be a real share of system RAM.
        ram = system_memory_gib() or 16.0
        profile["memory_budget_gib"] = round(max(8.0, ram * 0.5), 1)
        profile["offload_ar"] = False
        # The attention shim replaces a CUDA kernel; on the CPU path there is
        # nothing for it to replace.
        profile["memory_efficient_attention"] = False
    else:
        card = memory or 12.0
        headroom = 2.0 if card >= 20.0 else 1.0
        profile["memory_budget_gib"] = round(max(4.0, card - headroom), 1)
        profile["offload_ar"] = card < 16.0
        if gpu.compute and (gpu.compute[0], gpu.compute[1]) >= (8, 9):
            profile["quantization"] = "fp8"

    profile["lyrics_model"] = recommended_lyrics_model(gpu)
    return profile


def recommended_lyrics_model(gpu: Gpu) -> str:
    """An Ollama tag that fits beside - not alongside - YuE2.

    The lyrics model and YuE2 never run at the same time; SongForge unloads one
    before starting the other. What matters is whether the card can hold the
    lyrics model at all while it is the one in residence.
    """
    memory = gpu.memory_gib or 0.0
    if gpu.vendor == "cpu":
        return "gemma3:4b"
    if memory >= 11.0:
        return "gemma4:12b"
    if memory >= 6.0:
        return "gemma3:4b"
    return "gemma3:1b"


def warnings_for(gpu: Gpu, machine: Machine | None = None) -> list[str]:
    """Things worth saying out loud before anyone spends 15 GB of download."""
    machine = machine or detect_machine()
    out: list[str] = []

    if machine.python < REQUIRED_PYTHON:
        wanted = ".".join(str(part) for part in REQUIRED_PYTHON)
        out.append(
            f"Python {'.'.join(str(p) for p in machine.python)} is older than the "
            f"{wanted} this project needs."
        )

    if gpu.vendor == "cpu":
        out.append(
            "No supported GPU was found. YuE2 will run on the CPU, but a single song "
            "takes hours rather than minutes."
        )
        return out

    memory = gpu.memory_gib
    if memory is None:
        out.append("The amount of video memory could not be read; settings were guessed.")
    elif memory < MINIMUM_VRAM_GIB:
        out.append(
            f"{memory:.0f} GB of video memory is below the {MINIMUM_VRAM_GIB:.0f} GB "
            "this has been made to work on. Renders are likely to run out of memory."
        )
    elif memory < COMFORTABLE_VRAM_GIB:
        out.append(
            f"YuE2 officially asks for {COMFORTABLE_VRAM_GIB:.0f} GB. This card has "
            f"{memory:.0f} GB, which works here with AR offload and memory-efficient "
            "attention, both switched on for you."
        )

    if gpu.vendor == "nvidia" and gpu.compute and gpu.compute < (8, 0):
        out.append(
            f"Compute capability {gpu.compute[0]}.{gpu.compute[1]} has no fast bfloat16, "
            "so renders will be considerably slower than on a recent card."
        )
    return out
