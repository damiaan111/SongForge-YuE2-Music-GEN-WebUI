"""A fresh install must be ready to render on every generation of card.

Version 1.0.0 was developed and tested on one RTX 3060. Setup switched fp8
quantization on for every newer card (RTX 40 and 50 series), and the backend
then reported fp8 as a configuration problem on every card whatsoever - so the
people with the newest hardware saw "The music engine is not fully set up" and
could not render a song. Nothing here needs a GPU: the cards are described by
the profile file setup writes, exactly as the backend reads it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from songforge.setup.hardware import Gpu, settings_profile

CARDS = {
    "GTX 1660 (7.5)": Gpu(vendor="nvidia", name="GTX 1660", memory_gib=6.0, compute=(7, 5), driver="580.1"),
    "RTX 3060 (8.6)": Gpu(vendor="nvidia", name="RTX 3060", memory_gib=12.0, compute=(8, 6), driver="580.1"),
    "RTX 3090 (8.6)": Gpu(vendor="nvidia", name="RTX 3090", memory_gib=24.0, compute=(8, 6), driver="580.1"),
    "RTX 4060 (8.9)": Gpu(vendor="nvidia", name="RTX 4060", memory_gib=8.0, compute=(8, 9), driver="580.1"),
    "RTX 4070 Ti (8.9)": Gpu(vendor="nvidia", name="RTX 4070 Ti", memory_gib=12.0, compute=(8, 9), driver="580.1"),
    "RTX 4090 (8.9)": Gpu(vendor="nvidia", name="RTX 4090", memory_gib=24.0, compute=(8, 9), driver="580.1"),
    "RTX 5070 (12.0)": Gpu(vendor="nvidia", name="RTX 5070", memory_gib=12.0, compute=(12, 0), driver="580.1"),
    "RTX 5090 (12.0)": Gpu(vendor="nvidia", name="RTX 5090", memory_gib=32.0, compute=(12, 0), driver="580.1"),
}
FP8_CAPABLE = [name for name, gpu in CARDS.items() if gpu.compute >= (8, 9)]
TOO_OLD_FOR_FP8 = [name for name, gpu in CARDS.items() if gpu.compute < (8, 9)]


def install(runtime: Path, gpu: Gpu | None, *, profile_settings: dict | None = None) -> None:
    """Leave ``runtime`` the way a finished setup run leaves it."""
    model = runtime / "models" / "YuE2-3B"
    vae = runtime / "models" / "YuE2-Vae"
    model.mkdir(parents=True, exist_ok=True)
    vae.mkdir(parents=True, exist_ok=True)
    if gpu is None:
        return
    payload = {
        "gpu": {"vendor": gpu.vendor, "name": gpu.name, "memory_gib": gpu.memory_gib,
                "compute": list(gpu.compute) if gpu.compute else None},
        "torch": "CUDA 12.8",
        "settings": profile_settings if profile_settings is not None else settings_profile(gpu),
        # The interpreter running the tests: a program that really exists.
        "paths": {"python_executable": sys.executable, "model_path": str(model),
                  "vae_path": str(vae)},
    }
    (runtime / "hardware-profile.json").write_text(json.dumps(payload), encoding="utf-8")


def start(runtime_dir: Path):
    """A backend started on that runtime folder."""
    from fastapi.testclient import TestClient

    from songforge import config, db
    from songforge.main import create_app

    config.get_config.cache_clear()
    db._engine = None
    return TestClient(create_app())


# ------------------------------------------------------------ fresh installs

@pytest.mark.parametrize("card", list(CARDS))
def test_a_fresh_install_is_ready_to_render_on_this_card(runtime_dir: Path, card: str) -> None:
    install(runtime_dir, CARDS[card])
    with start(runtime_dir) as client:
        settings = client.get("/api/settings").json()
        assert settings["runner_kind"] == "yue2_cli"
        assert settings["configuration_issues"] == [], card
        assert settings["quantization"] == "none"
        assert client.get("/api/health").json()["runner_ready"] is True


@pytest.mark.parametrize("card", list(CARDS))
def test_setup_never_turns_on_an_experimental_mode(card: str) -> None:
    assert settings_profile(CARDS[card])["quantization"] == "none"


# ------------------------------------------------- upgrading a 1.0.0 install

@pytest.mark.parametrize("card", FP8_CAPABLE)
def test_an_install_that_1_0_0_left_unusable_works_after_the_update(
    runtime_dir: Path, card: str
) -> None:
    """Exactly the reports: setup finished without an error, the app refused to render."""
    # 1.0.0: the profile says fp8, and so does the settings row seeded from it.
    profile_from_1_0_0 = {**settings_profile(CARDS[card]), "quantization": "fp8"}
    install(runtime_dir, CARDS[card], profile_settings=profile_from_1_0_0)
    with start(runtime_dir) as client:
        from sqlmodel import Session

        from songforge.db import get_engine
        from songforge.models import AppSettings

        with Session(get_engine()) as session:
            row = session.get(AppSettings, 1)
            row.quantization = "fp8"
            row.settings_revision = 0
            session.add(row)
            session.commit()

    # The user updates and starts SongForge again. Nothing else.
    with start(runtime_dir) as client:
        settings = client.get("/api/settings").json()
        assert settings["quantization"] == "none"
        assert settings["configuration_issues"] == []
        assert client.get("/api/health").json()["runner_ready"] is True


def test_the_repair_happens_once_and_a_later_choice_is_kept(runtime_dir: Path) -> None:
    install(runtime_dir, CARDS["RTX 4090 (8.9)"])
    with start(runtime_dir) as client:
        chosen = client.put("/api/settings", json={"quantization": "fp8"}).json()
        assert chosen["quantization"] == "fp8"
    with start(runtime_dir) as client:
        assert client.get("/api/settings").json()["quantization"] == "fp8"


# ------------------------------------------------------- fp8 chosen by hand

@pytest.mark.parametrize("card", FP8_CAPABLE)
def test_fp8_can_be_chosen_on_a_card_that_supports_it(runtime_dir: Path, card: str) -> None:
    install(runtime_dir, CARDS[card])
    with start(runtime_dir) as client:
        body = client.put("/api/settings", json={"quantization": "fp8"}).json()
        assert body["configuration_issues"] == [], card
        assert "--quantization=fp8" in body["command_preview"]
        assert client.get("/api/health").json()["runner_ready"] is True


@pytest.mark.parametrize("card", TOO_OLD_FOR_FP8)
def test_fp8_on_a_card_that_cannot_run_it_says_what_to_do(runtime_dir: Path, card: str) -> None:
    install(runtime_dir, CARDS[card])
    with start(runtime_dir) as client:
        body = client.put("/api/settings", json={"quantization": "fp8"}).json()
        (issue,) = body["configuration_issues"]
        compute = CARDS[card].compute
        assert f"{compute[0]}.{compute[1]}" in issue, "names the card's own capability"
        assert "Quantization to none" in issue, "and says how to fix it"
        assert client.get("/api/health").json()["runner_ready"] is False


def test_an_unknown_card_is_not_accused_of_anything(runtime_dir: Path, client) -> None:
    """No profile: setup was skipped or done by hand. Nothing is known, so nothing is claimed."""
    model = runtime_dir / "m"
    model.mkdir()
    body = client.put("/api/settings", json={
        "runner_kind": "yue2_cli", "model_path": str(model),
        "python_executable": sys.executable, "quantization": "fp8",
    }).json()
    assert not any("fp8" in issue.lower() for issue in body["configuration_issues"])
