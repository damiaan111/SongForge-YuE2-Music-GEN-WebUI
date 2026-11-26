"""Runner selection.

The active runner is rebuilt from the stored settings for each job, so a change
in Settings takes effect on the next generation without a restart.
"""
from __future__ import annotations

from sqlmodel import Session

from ..db import get_engine
from ..enums import RunnerKind
from ..models import AppSettings
from .base import BaseRunner, RunnerCapabilities
from .mock import MockRunner
from .yue2 import DEFAULT_COMMAND_TEMPLATE, Yue2CliRunner, Yue2Config

__all__ = [
    "DEFAULT_COMMAND_TEMPLATE",
    "build_runner",
    "current_runner",
    "capabilities_for",
    "MockRunner",
    "Yue2CliRunner",
    "Yue2Config",
]


def build_runner(settings: AppSettings) -> BaseRunner:
    """Construct the runner described by ``settings``."""
    if settings.runner_kind is RunnerKind.YUE2_CLI:
        return Yue2CliRunner(
            Yue2Config(
                executable=settings.yue2_executable or "",
                python_executable=settings.python_executable or "",
                model_path=settings.model_path or "",
                vae_path=settings.vae_path or "",
                gpu_index=settings.gpu_index,
                memory_budget_gib=settings.memory_budget_gib,
                offload_ar=settings.offload_ar,
                backend_mode=settings.backend_mode or "torch-eager",
                quantization=settings.quantization or "none",
                offline_mode=settings.offline_mode,
                command_template=settings.command_template or DEFAULT_COMMAND_TEMPLATE,
                memory_efficient_attention=settings.memory_efficient_attention,
            )
        )
    return MockRunner()


def current_runner() -> BaseRunner:
    """Read settings fresh from the database and build the active runner."""
    with Session(get_engine()) as session:
        settings = session.get(AppSettings, 1) or AppSettings(id=1)
        return build_runner(settings)


def capabilities_for(settings: AppSettings) -> RunnerCapabilities:
    return build_runner(settings).capabilities
