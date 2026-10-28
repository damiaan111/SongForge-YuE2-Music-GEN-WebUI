"""How much song fits: the two ceilings a YuE2 request has to live inside.

YuE2 has no duration control - length follows the lyrics - and two separate
limits decide whether a song survives intact. Both used to be invisible in
SongForge, which is why songs came back with sentences missing:

* the semantic stage stops after ``MUSIC_MAX_TOKENS`` codec tokens, at roughly
  ``TOKENS_PER_SECOND`` tokens per second of audio. That is a hard six-minute
  song. Hit it and the render ends wherever it happens to be, which is reported
  afterwards as ``truncated.semantic``;
* the instruction, the style tags, the lyrics and the ABC plan share one
  ``CONTEXT_TOKENS`` window with the music. YuE2 refuses rather than quietly
  truncating ("no implicit truncation", ``yue2/sampling.py``), so this one shows
  up as a failed job instead of a short song.

The constants mirror the installed ``yue2_infer`` 0.1.5 release
(``yue2/protocol.py``: ``CONTEXT = 24576``, semantic ``max_tokens = 9000``, ABC
``max_tokens = 4096``). They cannot be imported, because YuE2 lives in its own
virtualenv.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from .lyrics import estimate_seconds

# yue2/protocol.py
CONTEXT_TOKENS = 24_576
MUSIC_MAX_TOKENS = 9_000
ABC_MAX_TOKENS = 4_096
# ComfyUI's YuE2 nodes budget 25 semantic tokens per second of audio, which
# matches 9,000 tokens against the model card's six-minute ceiling.
TOKENS_PER_SECOND = 25.0
# The instruction sentence plus the [Tags] and [Lyrics] headers YuE2 adds itself.
INSTRUCTION_TOKENS = 32
# Qwen BPE over song text: ~3.5 characters per token for Latin scripts. Only
# used for the context check, where the music cap dominates anyway.
CHARS_PER_TOKEN = 3.5

MAX_SECONDS = MUSIC_MAX_TOKENS / TOKENS_PER_SECOND
# Past this much of the ceiling a render is worth warning about: the estimate
# itself is +-10% on measured renders.
TIGHT_FRACTION = 0.85


def estimate_tokens(text: str) -> int:
    """Prompt tokens for a piece of text, rounded up."""
    return math.ceil(len(text.strip()) / CHARS_PER_TOKEN) if text and text.strip() else 0


def format_clock(seconds: float) -> str:
    """Seconds as m:ss, the way the UI shows song length."""
    total = max(0, int(round(seconds)))
    return f"{total // 60}:{total % 60:02d}"


@dataclass(frozen=True)
class Budget:
    """An estimate of what a request will cost, and whether it fits."""

    seconds: float
    max_seconds: float
    music_tokens: int
    music_cap: int
    prompt_tokens: int
    plan_tokens: int
    context_tokens: int
    context_total: int
    verdict: str
    headline: str
    detail: str
    advice: str

    def to_dict(self) -> dict:
        return asdict(self)


def estimate(
    style: str = "",
    lyrics: str = "",
    *,
    cot: str = "full",
    score_abc: str = "",
    instrumental: bool = False,
) -> Budget:
    """Estimate length and context use for one generation request.

    ``verdict`` is one of ``ok``, ``tight``, ``over_length`` or ``over_context``.
    Nothing here blocks a render; it exists so the UI can say what will happen
    before the GPU spends four minutes finding out.
    """
    seconds = estimate_seconds(lyrics) if not instrumental else 0.0
    music_tokens = math.ceil(seconds * TOKENS_PER_SECOND)

    prompt_tokens = INSTRUCTION_TOKENS + estimate_tokens(style) + estimate_tokens(lyrics)
    # A supplied score is counted exactly; a generated one is reserved at its
    # own ceiling, because its real length is not known until it is written.
    if cot == "off":
        plan_tokens = 0
    elif score_abc.strip():
        plan_tokens = estimate_tokens(score_abc)
    else:
        plan_tokens = ABC_MAX_TOKENS
    context_tokens = prompt_tokens + plan_tokens + MUSIC_MAX_TOKENS

    clock, ceiling = format_clock(seconds), format_clock(MAX_SECONDS)
    if context_tokens > CONTEXT_TOKENS:
        over = context_tokens - CONTEXT_TOKENS
        return Budget(
            seconds, MAX_SECONDS, music_tokens, MUSIC_MAX_TOKENS, prompt_tokens,
            plan_tokens, context_tokens, CONTEXT_TOKENS, "over_context",
            "This prompt does not fit YuE2's context",
            f"The style, lyrics and score need about {over} tokens more than the "
            f"{CONTEXT_TOKENS:,}-token window leaves for the music.",
            "Shorten the style tags or the lyrics. YuE2 refuses this request rather "
            "than cutting it short, so the job would fail.",
        )
    if instrumental:
        return Budget(
            seconds, MAX_SECONDS, music_tokens, MUSIC_MAX_TOKENS, prompt_tokens,
            plan_tokens, context_tokens, CONTEXT_TOKENS, "ok",
            "Instrumental - length is up to the model",
            f"With no lyrics to follow, YuE2 decides the length itself and stops at "
            f"{ceiling} at the latest.",
            "",
        )
    if seconds > MAX_SECONDS:
        return Budget(
            seconds, MAX_SECONDS, music_tokens, MUSIC_MAX_TOKENS, prompt_tokens,
            plan_tokens, context_tokens, CONTEXT_TOKENS, "over_length",
            f"About {clock} of lyrics - too long to sing in full",
            f"YuE2 stops after {ceiling}, so the last part of the lyrics will not be "
            "sung, and the ending will be cut off mid-phrase.",
            "Remove a verse or shorten the sections. Writing a repeated chorus out in "
            "full costs its full length - there is no shorthand.",
        )
    if seconds > MAX_SECONDS * TIGHT_FRACTION:
        return Budget(
            seconds, MAX_SECONDS, music_tokens, MUSIC_MAX_TOKENS, prompt_tokens,
            plan_tokens, context_tokens, CONTEXT_TOKENS, "tight",
            f"About {clock} of lyrics - close to the limit",
            f"The ceiling is {ceiling}, and this estimate is accurate to within about "
            "10%, so the ending may still be cut.",
            "Trimming one section would make the ending safe.",
        )
    return Budget(
        seconds, MAX_SECONDS, music_tokens, MUSIC_MAX_TOKENS, prompt_tokens,
        plan_tokens, context_tokens, CONTEXT_TOKENS, "ok",
        f"About {clock} of song",
        f"Comfortably inside YuE2's {ceiling} ceiling.",
        "",
    )
