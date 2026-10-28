"""The length and context budget, and the endpoint the Create form polls.

These pin the numbers the UI shows, because getting them wrong is how a user
spends four minutes of GPU time on a song that was always going to be cut.
"""
from __future__ import annotations

import pytest

from songforge import budget


def lyrics_of_seconds(seconds: float) -> str:
    """Lyrics whose estimate lands on ``seconds`` (27 s + characters / 8.5)."""
    return "[Verse]\n" + "a" * max(0, int(round((seconds - 27.0) * 8.5)))


# ------------------------------------------------------------------ constants


def test_constants_match_the_installed_yue2_release() -> None:
    assert budget.CONTEXT_TOKENS == 24_576
    assert budget.MUSIC_MAX_TOKENS == 9_000
    assert budget.ABC_MAX_TOKENS == 4_096
    # 9,000 tokens at 25 per second is the model card's six-minute ceiling.
    assert budget.MAX_SECONDS == 360.0


# ------------------------------------------------------------------- verdicts


def test_a_normal_song_is_ok() -> None:
    result = budget.estimate("indie folk, warm female vocal", lyrics_of_seconds(180))
    assert result.verdict == "ok"
    assert result.music_tokens == pytest.approx(180 * 25, abs=25)
    assert "3:00" in result.headline


def test_a_song_near_the_ceiling_is_tight() -> None:
    result = budget.estimate("pop", lyrics_of_seconds(330))
    assert result.verdict == "tight"
    assert "6:00" in result.detail and "5:30" in result.headline


def test_an_overlong_song_says_what_will_be_lost() -> None:
    result = budget.estimate("pop", lyrics_of_seconds(430))
    assert result.verdict == "over_length"
    assert "7:10" in result.headline
    assert "will not be sung" in result.detail
    assert result.advice


def test_a_huge_prompt_is_refused_by_context_not_cut_short() -> None:
    """YuE2 raises rather than truncating, so this must read as a hard failure.

    The field limits alone allow this: MAX_LYRICS + MAX_STYLE is past the window
    once the plan and music reserves are counted.
    """
    result = budget.estimate("p" * 4_000, "x" * 40_000)
    # Both ceilings are blown here; the one that fails the job outright wins.
    assert result.verdict == "over_context"
    assert result.context_tokens > budget.CONTEXT_TOKENS
    assert "refuses" in result.advice


def test_instrumental_length_is_not_lyric_driven() -> None:
    result = budget.estimate("ambient", "", instrumental=True)
    assert result.verdict == "ok" and result.seconds == 0.0
    assert "Instrumental" in result.headline


# -------------------------------------------------------------- plan reserve


def test_planning_off_reserves_no_score_tokens() -> None:
    assert budget.estimate("pop", "la la", cot="off").plan_tokens == 0


def test_a_generated_score_is_reserved_at_its_ceiling() -> None:
    """Its real length is unknown until written, so reserve the worst case."""
    assert budget.estimate("pop", "la la").plan_tokens == budget.ABC_MAX_TOKENS


def test_a_supplied_score_is_counted_as_given() -> None:
    result = budget.estimate("pop", "la la", score_abc="X:1\nK:C\n" + "CDEF|" * 100)
    assert 0 < result.plan_tokens < budget.ABC_MAX_TOKENS


def test_clock_formatting() -> None:
    assert budget.format_clock(0) == "0:00"
    assert budget.format_clock(65.4) == "1:05"
    assert budget.format_clock(360) == "6:00"


# -------------------------------------------------------------------- endpoint


def test_estimate_endpoint_returns_the_budget(client) -> None:
    response = client.post("/api/estimate", json={
        "style_prompt": "indie folk, warm female vocal",
        "lyrics": lyrics_of_seconds(200),
    })
    assert response.status_code == 200
    body = response.json()
    assert body["verdict"] == "ok"
    assert body["context_total"] == 24_576 and body["music_cap"] == 9_000
    assert body["headline"] and body["detail"]


def test_estimate_endpoint_needs_no_fields(client) -> None:
    body = client.post("/api/estimate", json={}).json()
    assert body["verdict"] == "ok" and body["seconds"] == 27.0


def test_estimate_endpoint_rejects_unknown_fields(client) -> None:
    assert client.post("/api/estimate", json={"nope": 1}).status_code == 422
