"""Language names in the prompt.

The language is the first, most heavily weighted tag YuE2 reads. It was once
sent as the ISO code a default happened to be stored as.
"""
from __future__ import annotations

import pytest

from songforge.languages import language_name
from songforge.models import AppSettings
from songforge.runners.base import GenerationRequest
from songforge.runners.yue2 import compose_style


@pytest.mark.parametrize(("typed", "sent"), [
    ("en", "English"),
    ("EN", "English"),
    ("en-US", "English"),
    ("pt_BR", "Portuguese"),
    ("nl", "Dutch"),
    ("English", "English"),
    ("Brazilian Portuguese", "Brazilian Portuguese"),
    ("  Dutch  ", "Dutch"),
    ("Klingon", "Klingon"),
    ("", ""),
    (None, ""),
])
def test_codes_become_names_and_names_are_left_alone(typed, sent) -> None:
    assert language_name(typed) == sent


def test_the_prompt_never_opens_with_a_two_letter_code() -> None:
    request = GenerationRequest(project_id="p", version_number=1, style_prompt="indie folk",
                                lyrics="la", language="en")
    assert compose_style(request) == "English, indie folk"


def test_a_new_install_defaults_to_the_name() -> None:
    assert AppSettings().default_language == "English"


def test_an_existing_database_is_repaired_once(runtime_dir) -> None:
    """A row saved as "en" by an older version reads as "English" afterwards."""
    from songforge import db

    db.init_db()
    with db.session_scope() as session:
        settings = db._ensure_settings_row(session)
        settings.default_language = "en"
        session.add(settings)
    with db.session_scope() as session:
        assert db._ensure_settings_row(session).default_language == "English"
