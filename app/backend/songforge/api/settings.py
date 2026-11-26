"""Settings endpoints.

Runner configuration is editable only here - there is no endpoint that accepts
a raw command to execute.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session

from ..config import get_config
from ..db import get_session
from ..enums import CotMode
from ..models import utcnow
from ..runners.base import GenerationRequest
from ..runners.registry import DEFAULT_COMMAND_TEMPLATE, build_runner
from ..hardware_profile import load as load_hardware_profile
from ..schemas import HardwareOut, SettingsOut, SettingsUpdate
from .deps import capabilities_out, ffmpeg_available, get_settings_row

router = APIRouter(prefix="/settings", tags=["settings"])

# The settings that decide which program runs and which files it loads.
#
# There is no login, so when the app is shared on a network everyone on that
# network can use this endpoint. Each of these fields is validated - only the
# yue2 CLI, only local paths, only known flags - but validation is a list of
# the tricks someone already thought of. While the app is shared they are
# simply not changeable: the person at the keyboard restarts without -Lan,
# changes them, and shares again.
ENGINE_FIELDS = (
    "python_executable", "yue2_executable", "model_path", "vae_path", "command_template",
)
ENGINE_LOCKED_MESSAGE = (
    "The engine settings cannot be changed while SongForge is shared on the "
    "network. Close it, start it without -Lan (--lan), make the change on this "
    "computer, and share it again."
)


def _hardware_out(runtime_dir: Path) -> HardwareOut | None:
    """What setup detected, or None when it never ran.

    Read on each request rather than cached: re-running setup on new hardware
    should be visible without restarting the backend.
    """
    profile = load_hardware_profile(runtime_dir)
    if profile is None:
        return None
    return HardwareOut(
        vendor=profile.gpu_vendor,
        name=profile.gpu_name,
        memory_gib=profile.memory_gib,
        compute=f"{profile.compute[0]}.{profile.compute[1]}" if profile.compute else None,
        torch=profile.torch_label,
        description=profile.describe(),
    )


def _build_response(session: Session) -> SettingsOut:
    settings = get_settings_row(session)
    runner = build_runner(settings)
    cfg = get_config()

    issues_fn = getattr(runner, "template_issues", None)
    issues = issues_fn() if callable(issues_fn) else []

    # A preview of the exact argv for a representative request, so the user can
    # see what would run before anything runs.
    preview_request = GenerationRequest(
        project_id="preview",
        version_number=1,
        title="Preview",
        style_prompt="your style prompt",
        lyrics="your lyrics",
        cot=CotMode(settings.default_cot) if settings.default_cot in set(CotMode) else CotMode.FULL,
        seed=0,
        cfg_scale=settings.default_cfg_scale,
    )
    try:
        preview = runner.build_command(preview_request, Path(cfg.projects_dir) / "preview")
    except Exception as exc:  # noqa: BLE001 - a broken template must not 500
        preview = []
        issues = [*issues, f"Command preview failed: {exc}"]

    data = settings.model_dump()
    data.pop("id", None)
    data.pop("updated_at", None)
    return SettingsOut(
        **data,
        capabilities=capabilities_out(runner.capabilities),
        command_preview=preview,
        configuration_issues=issues,
        default_command_template=DEFAULT_COMMAND_TEMPLATE,
        projects_dir=str(cfg.projects_dir),
        models_dir=str(cfg.models_dir),
        ffmpeg_available=ffmpeg_available(),
        hardware=_hardware_out(cfg.runtime_dir),
        lan_mode=cfg.lan,
    )


@router.get("", response_model=SettingsOut, summary="Read current settings")
def read_settings(session: Session = Depends(get_session)) -> SettingsOut:
    return _build_response(session)


@router.put("", response_model=SettingsOut, summary="Update settings")
def update_settings(
    payload: SettingsUpdate, session: Session = Depends(get_session)
) -> SettingsOut:
    settings = get_settings_row(session)
    changes = payload.model_dump(exclude_unset=True)
    if get_config().lan:
        # Sending a field back unchanged is fine - the page saves whole forms.
        touched = [
            field for field in ENGINE_FIELDS
            if field in changes and changes[field] != getattr(settings, field)
        ]
        if touched:
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail=ENGINE_LOCKED_MESSAGE)
    for field, value in changes.items():
        setattr(settings, field, value)
    settings.updated_at = utcnow()
    session.add(settings)
    session.commit()
    session.refresh(settings)
    return _build_response(session)
