"""What setup detected about this machine, read back at first start.

``songforge.setup`` writes ``runtime/hardware-profile.json`` once, after a
successful install. The backend reads it the first time it creates its settings
row, so a fresh checkout arrives already pointed at the right interpreter, the
right weights and a memory budget that suits the card that is actually present.

Before this existed those values were constants taken from one 12 GB RTX 3060,
and every new user had to discover and retype them.

The file is advisory. A missing, unreadable or half-written one is not an
error: the defaults still apply and Settings still works.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("songforge.hardware")

PROFILE_FILENAME = "hardware-profile.json"

# Only these may be seeded from the file. An allowlist rather than a blind
# update, so a stale profile from an older version cannot set fields that have
# since changed meaning, and so the file can never flip, say, offline_mode.
SEEDABLE_SETTINGS = frozenset({
    "memory_budget_gib", "offload_ar", "quantization", "backend_mode",
    "memory_efficient_attention", "gpu_index", "lyrics_model",
})
SEEDABLE_PATHS = frozenset({"python_executable", "model_path", "vae_path"})


@dataclass(frozen=True)
class HardwareProfile:
    gpu_vendor: str
    gpu_name: str
    memory_gib: float | None
    compute: tuple[int, int] | None
    torch_label: str
    settings: dict[str, Any]
    paths: dict[str, str]

    def describe(self) -> str:
        parts = [self.gpu_name]
        if self.memory_gib:
            parts.append(f"{self.memory_gib:.0f} GB")
        if self.compute:
            parts.append(f"compute {self.compute[0]}.{self.compute[1]}")
        if self.torch_label:
            parts.append(self.torch_label)
        return ", ".join(parts)


def profile_path(runtime_dir: Path) -> Path:
    return runtime_dir / PROFILE_FILENAME


def load(runtime_dir: Path) -> HardwareProfile | None:
    """The profile, or None if there is not a usable one."""
    path = profile_path(runtime_dir)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("ignoring unreadable %s: %s", PROFILE_FILENAME, exc)
        return None
    if not isinstance(raw, dict):
        return None

    gpu = raw.get("gpu") or {}
    compute = gpu.get("compute")
    settings = {k: v for k, v in (raw.get("settings") or {}).items() if k in SEEDABLE_SETTINGS}
    paths = {
        k: str(v) for k, v in (raw.get("paths") or {}).items()
        if k in SEEDABLE_PATHS and v
    }
    return HardwareProfile(
        gpu_vendor=str(gpu.get("vendor") or "unknown"),
        gpu_name=str(gpu.get("name") or "Unknown device"),
        memory_gib=float(gpu["memory_gib"]) if gpu.get("memory_gib") else None,
        compute=(int(compute[0]), int(compute[1])) if isinstance(compute, (list, tuple))
        and len(compute) == 2 else None,
        torch_label=str(raw.get("torch") or ""),
        settings=settings,
        paths=paths,
    )


def seed_values(profile: HardwareProfile) -> dict[str, Any]:
    """The field values to apply to a brand-new settings row.

    The runner is switched from the mock to the real one only when the profile
    names an interpreter and both sets of weights: a half-finished install
    should land in the mock runner, where nothing pretends to work.
    """
    values: dict[str, Any] = dict(profile.settings)
    paths = profile.paths
    values.update(paths)
    if {"python_executable", "model_path", "vae_path"} <= paths.keys():
        values["runner_kind"] = "yue2_cli"
    return values
