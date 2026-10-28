"""Local lyrics writer, backed by an Ollama model on this machine.

The model and YuE2 cannot share one card on typical hardware: YuE2 needs most
of the video memory while it renders. So the writer refuses while a song is
queued or rendering, and the queue unloads the model before every render
(see ``ensure_unloaded``).

Lyrics are written for YuE2 specifically:
- section tags YuE2 was trained on ([Verse], [Chorus], ...), in English even
  when the lyrics are not;
- a length target derived from real renders (see ``plan_length``), because
  YuE2 has no duration control - length follows the lyrics;
- no stage directions, speaker labels or markdown, which YuE2 would try to sing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx

from .config import get_config

log = logging.getLogger("songforge.lyrics")

SECTION_TAGS = ("Intro", "Verse", "Pre-Chorus", "Chorus", "Bridge", "Outro", "Instrumental")

# Fitted to real YuE2 renders on the RTX 3060 (lyric characters excluding tags
# -> seconds): 144 -> 44/37 s, 1708 -> 235 s, 2150 -> 295 s, 2740 -> 331 s.
_INTRO_OUTRO_SECONDS = 27.0
_CHARS_PER_SECOND = 8.5
# The same renders averaged ~42 characters per sung line.
_CHARS_PER_LINE = 42
# Reported consistently across YuE2 prompting guides, and consistent with the
# renders above: one tagged section becomes about half a minute of music.
_SECONDS_PER_SECTION = 30.0

# Ceiling for the writer's own output. The per-request budget is derived from the
# requested length (``output_token_budget``); this only bounds it. A writer that is
# cut off mid-section hands the singer half a song, which used to pass silently.
_MAX_OUTPUT_TOKENS = 6000
_MIN_OUTPUT_TOKENS = 1200
_CONTEXT_TOKENS = 8192
_REQUEST_TIMEOUT = httpx.Timeout(connect=3.0, read=300.0, write=30.0, pool=5.0)


@dataclass(frozen=True)
class LyricsPhase:
    """A progress marker between text chunks, e.g. while weights load."""
    phase: str
    message: str


class LyricsUnavailable(RuntimeError):
    """The writer cannot run right now; the message says why and what to do."""


class LyricsBusy(LyricsUnavailable):
    """The GPU or the writer is in use."""


def estimate_seconds(lyrics: str) -> float:
    characters = len(re.sub(r"\[[^\]]*\]", "", lyrics).strip())
    return _INTRO_OUTRO_SECONDS + characters / _CHARS_PER_SECOND


@dataclass(frozen=True)
class LengthPlan:
    seconds: float
    characters: int
    lines: int
    sections: list[str]


def plan_length(minutes: float) -> LengthPlan:
    """Characters, lines and a section outline that land near ``minutes``."""
    seconds = max(30.0, minutes * 60)
    characters = max(120, int((seconds - _INTRO_OUTRO_SECONDS) * _CHARS_PER_SECOND))
    lines = max(4, round(characters / _CHARS_PER_LINE))

    # Build a conventional song shape until the line budget is spent. Verses and
    # choruses are four lines, pre-choruses and bridges two to four.
    shape = ["Intro", "Verse", "Chorus"]
    used = 8
    cycle = [("Verse", 4), ("Pre-Chorus", 2), ("Chorus", 4), ("Bridge", 4)]
    index = 0
    # A section renders to roughly 30 seconds, so more sections than that would
    # ask for a song longer than the target no matter how short the lines are.
    max_sections = max(3, round(seconds / _SECONDS_PER_SECTION))
    while used + 4 <= lines and len(shape) < max_sections:
        name, size = cycle[index % len(cycle)]
        # A bridge only once, after the second chorus.
        if name == "Bridge" and "Bridge" in shape:
            index += 1
            continue
        if name == "Pre-Chorus" and "Pre-Chorus" not in shape and shape.count("Verse") < 2:
            index += 1
            continue
        shape.append(name)
        used += size
        index += 1
    if shape[-1] != "Chorus":
        shape.append("Chorus")
    shape.append("Outro")
    return LengthPlan(seconds=seconds, characters=characters, lines=lines, sections=shape)


def output_token_budget(minutes: float) -> int:
    """How many tokens to let the writer produce for a song of ``minutes``.

    Roughly a token per two characters, plus room for the TITLE and STYLE lines.
    Non-Latin scripts tokenize worse than English, hence the generous factor.
    """
    characters = plan_length(minutes).characters
    return max(_MIN_OUTPUT_TOKENS, min(_MAX_OUTPUT_TOKENS, int(characters * 1.2) + 400))


@dataclass
class LyricsRequest:
    idea: str
    language: str = "English"
    minutes: float = 3.0
    style_hint: str = ""
    mood: str = ""
    # Revise mode: the current lyrics plus what to change.
    existing_lyrics: str = ""
    instruction: str = ""


@dataclass
class LyricsResult:
    title: str
    style: str
    lyrics: str
    estimated_seconds: float
    model: str
    output_tokens: int = 0
    seconds: float = 0.0
    warnings: list[str] = field(default_factory=list)


_SYSTEM_PROMPT = """You are a professional songwriter writing lyrics that will be sung by an AI singing model.

Write singable lyrics: natural phrasing, a steady meter within each section, and rhymes where they sound natural in the language. Make the chorus memorable and repeat it word for word each time it returns.

Formatting rules - the singing model sings every word you write, so follow them exactly:
- Mark every section with one tag on its own line, chosen only from: [Intro] [Verse] [Pre-Chorus] [Chorus] [Bridge] [Outro] [Instrumental]. Tags are always in English.
- [Intro], [Instrumental] and [Outro] may be left empty (no lines) for instrumental passages.
- Below each tag, only the words to be sung. No speaker labels, no stage directions, no notes in brackets or parentheses, no "x2" or "repeat", no emojis, no markdown, no numbering.
- Leave one blank line between sections.
- Keep each section to 4-6 short lines: one tagged section becomes roughly half a minute of music.
- When a line or the chorus returns, give it the same number of syllables as the first time, or the melody stops fitting and the words get rushed.

Reply in exactly this format and nothing else:
TITLE: <a short song title>
STYLE: <comma-separated tags for the music: genre, key instruments, mood, tempo in bpm, vocal type - at most 20 words, in English>
LYRICS:
<the lyrics>"""


def build_messages(request: LyricsRequest) -> list[dict[str, str]]:
    plan = plan_length(request.minutes)
    minutes_text = f"{plan.seconds / 60:.1f}".rstrip("0").rstrip(".")
    context = []
    if request.style_hint.strip():
        context.append(f"Musical style so far: {request.style_hint.strip()}")
    if request.mood.strip():
        context.append(f"Mood: {request.mood.strip()}")

    if request.existing_lyrics.strip():
        task = (
            f"Revise these lyrics. Change: {request.instruction.strip() or 'improve them'}\n"
            "Keep everything the instruction does not ask you to change, including the "
            "section structure, unless the instruction says otherwise.\n\n"
            f"Current lyrics:\n{request.existing_lyrics.strip()}"
        )
    else:
        task = (
            f"Write a complete song about: {request.idea.strip()}\n"
            f"Target length: about {minutes_text} minutes when sung, which is roughly "
            f"{plan.lines} sung lines (about {plan.characters} characters) in total.\n"
            f"Suggested structure: {' '.join('[' + s + ']' for s in plan.sections)}\n"
            "Keep each section to 4-6 lines."
        )
    user = "\n".join([
        f"Language of the lyrics: {request.language.strip() or 'English'}. Write every sung line in that language.",
        *context,
        "",
        task,
    ])
    return [{"role": "system", "content": _SYSTEM_PROMPT}, {"role": "user", "content": user}]


_HEADER_LINE = re.compile(r"^#*\s*(?:song\s+)?(?:TITLE|STYLE|LYRICS?)\s*[:\-]", re.IGNORECASE)

_TAG_ALIASES = {
    "prechorus": "Pre-Chorus", "pre chorus": "Pre-Chorus", "pre-chorus": "Pre-Chorus",
    "refrain": "Chorus", "hook": "Chorus", "chorus": "Chorus",
    "verse": "Verse", "couplet": "Verse", "strophe": "Verse", "bridge": "Bridge",
    "intro": "Intro", "outro": "Outro", "instrumental": "Instrumental", "solo": "Instrumental",
    "interlude": "Instrumental", "break": "Instrumental",
}
_TAG_NAMES = (
    r"pre[- ]?chorus|chorus|refrain|hook|verse|couplet|strophe|bridge|intro|outro|"
    r"instrumental|solo|interlude|break"
)
_TAG_LINE = re.compile(
    r"^\s*(?:"
    # Bracketed. Trailing decoration is allowed, because the brackets make the
    # intent unambiguous: "[Verse 1 - soft]", "[Intro: Piano]", "[Chorus x2]".
    rf"[\[(]\s*(?P<bname>{_TAG_NAMES})\s*(?:\d+|[ivx]+)?"
    r"(?:\s*[xX]\s*(?P<bcount>\d+))?(?:\s*[-:,][^\])]*)?\s*[\])]"
    r"|"
    # Bare, and deliberately strict: allowing decoration here would turn an
    # ordinary line like "Verse, I remember you" into a tag and lose the words.
    rf"(?P<name>{_TAG_NAMES})\s*(?:\d+|[ivx]+)?(?:\s*[xX]\s*(?P<count>\d+))?\s*:?"
    r")\s*$",
    re.IGNORECASE,
)

# A fully parenthesised line is either a production note or a backing vocal.
# "(guitar solo)" must never be sung; "(ooh-ooh)" and "(hold me now)" are lyrics
# and used to be deleted here, which is how whole sentences went missing.
#
# Membership alone is not enough to tell them apart. Requiring only that every
# word be known deleted "(no no no)", because "no" is in the list for the sake
# of "no vocals" - and a single-word backing vocal is exactly what this is
# supposed to protect. So the vocabulary is tiered, and a line has to contain
# something that is never sung before it can be discarded.

# Words that are a production instruction wherever they appear.
_NEVER_SUNG = frozenset("""
    solo solos instrumental interlude riff fill adlib adlibs
    spoken whisper whispered shout shouted
    repeat repeats repeating reprise
    fade fades vocals vocal acapella ad lib libs lib's
    verse chorus bridge refrain
    herhaal herhaling herhalen gesproken gefluisterd fluistert
    refrein couplet brug tussenspel
    x times keer maal
""".split())

# Instrument and arrangement names. "(bass)" and "(drum break)" are notes, but
# these never stand in for a lyric on their own either, so they also license a
# discard.
_INSTRUMENTS = frozenset("""
    guitar piano keys keyboard drums drum bass synth synths strings horns
    brass sax saxophone trumpet violin cello flute organ percussion
    gitaar bas drums piano strijkers blazers slagwerk orgel
""".split())

# Words that only supply context. On their own they are ordinary lyrics:
# "(no no no)", "(stop)", "(break my heart)", "(out)".
_CONTEXT_ONLY = frozenset("""
    a an the and or of in on to my your his her its our
    intro outro break build drop beat music melody tune
    silence pause rest stop end ending no none off out up down
    stilte einde slot zonder geen zang
""".split())

_STAGE_DIRECTION_WORDS = _NEVER_SUNG | _INSTRUMENTS | _CONTEXT_ONLY

# Dutch and German glue words together: "gitaarsolo" is one token that means
# "guitar solo". Listing every compound is hopeless, so a word that is not in
# the vocabulary is tried as a join of two words that are.
_MIN_PART = 3


def _decompose(word: str) -> list[str]:
    """The word itself if known, else the two known words it is built from."""
    if word in _STAGE_DIRECTION_WORDS:
        return [word]
    for cut in range(_MIN_PART, len(word) - _MIN_PART + 1):
        head, tail = word[:cut], word[cut:]
        if head in _STAGE_DIRECTION_WORDS and tail in _STAGE_DIRECTION_WORDS:
            return [head, tail]
    return []


def _is_stage_direction(content: str) -> bool:
    """True when a parenthesised line is a production note rather than lyrics.

    Every word must be recognised, and at least one must be a word that is
    never sung. The asymmetry is deliberate: keeping a stray note costs one
    sung word, while dropping a backing vocal loses a line of the song.
    """
    words = re.findall(r"[^\W\d_]+", content.casefold())
    if not words:
        return False
    parts: list[str] = []
    for word in words:
        decomposed = _decompose(word)
        if not decomposed:
            return False
        parts.extend(decomposed)
    return any(part in _NEVER_SUNG or part in _INSTRUMENTS for part in parts)


def parse_output(text: str) -> tuple[str, str, str, list[str]]:
    """Split the model's reply into title, style and clean lyrics."""
    warnings: list[str] = []
    cleaned = re.sub(r"```[a-zA-Z]*", "", text).replace("**", "").strip()

    title_match = re.search(r"^\s*#*\s*(?:song\s+)?TITLE\s*[:\-]\s*(.+)$", cleaned, re.IGNORECASE | re.MULTILINE)
    style_match = re.search(r"^\s*#*\s*STYLE\s*[:\-]\s*(.+)$", cleaned, re.IGNORECASE | re.MULTILINE)
    # gemma4:12b has written "LYRIC:" instead of "LYRICS:" in a real run; the
    # header line was then sung. Accept the variants a model plausibly writes.
    lyrics_match = re.search(r"^\s*#*\s*(?:song\s+)?LYRICS?\s*[:\-]?\s*$", cleaned, re.IGNORECASE | re.MULTILINE)
    title = title_match.group(1).strip().strip('"') if title_match else ""
    style = style_match.group(1).strip() if style_match else ""
    if lyrics_match:
        body = cleaned[lyrics_match.end():]
    else:
        warnings.append("The model did not follow the reply format; lyrics were extracted.")
        body = re.sub(r"^\s*(TITLE|STYLE)\s*:.*$", "", cleaned, flags=re.IGNORECASE | re.MULTILINE)

    # Sections are collected as (tag, repeats, lines) so that an "x2" marker can
    # be written out in full. YuE2 does not expand repeat shorthand; it sings it.
    blocks: list[tuple[str, int, list[str]]] = []
    expanded = False
    for raw in body.splitlines():
        line = raw.strip()
        # Any leftover reply header must never reach the singer.
        if _HEADER_LINE.match(line):
            continue
        tag = _TAG_LINE.match(line)
        if tag:
            matched = tag.group("bname") or tag.group("name")
            name = _TAG_ALIASES[re.sub(r"\s+", " ", matched.lower())]
            count = tag.group("bcount") or tag.group("count")
            repeats = min(int(count), 4) if count else 1
            blocks.append((f"[{name}]", repeats, []))
            continue
        # Repeat markers would be sung aloud.
        line = re.sub(r"\((?:x\s*\d+|\d+\s*x|repeat[^)]*|herhaal[^)]*)\)", "", line, flags=re.IGNORECASE)
        line = re.sub(r"^\s*[-*•]\s+", "", line).strip()
        # Markdown emphasis is never a sung line. Parentheses usually are, so a
        # parenthesised line keeps its words unless it reads as a production note.
        if re.fullmatch(r"\*.*\*", line):
            continue
        wrapped = re.fullmatch(r"\((.*)\)", line)
        if wrapped:
            content = wrapped.group(1).strip()
            if not content or _is_stage_direction(content):
                continue
            line = content
        if not line:
            continue
        if not blocks:
            blocks.append(("", 1, []))
        blocks[-1][2].append(line)

    rendered: list[str] = []
    for tag, repeats, section in blocks:
        if not tag and not section:
            continue
        # An empty tag is an instrumental passage and is emitted once.
        for _ in range(repeats if section else 1):
            if rendered:
                rendered.append("")
            if tag:
                rendered.append(tag)
            rendered.extend(section)
        if repeats > 1 and section:
            expanded = True

    lyrics = "\n".join(rendered).strip()
    if expanded:
        warnings.append('A repeated section was written out in full; YuE2 cannot expand "x2".')
    if lyrics and not lyrics.startswith("["):
        lyrics = "[Verse]\n" + lyrics
        warnings.append("No section tags were written; the lyrics were marked as one verse.")
    if not re.search(r"\[(Verse|Chorus)\]", lyrics):
        warnings.append("No [Verse] or [Chorus] section - check the structure before rendering.")
    return title, style, lyrics, warnings


class OllamaClient:
    """Thin client for the local Ollama HTTP API."""

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or get_config().ollama_url).rstrip("/")

    async def _get(self, path: str, timeout: float = 3.0) -> dict:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(f"{self.base_url}{path}")
            response.raise_for_status()
            return response.json()

    async def version(self) -> str | None:
        try:
            return (await self._get("/api/version", timeout=1.5)).get("version")
        except (httpx.HTTPError, ValueError):
            return None

    async def installed_models(self) -> list[str]:
        data = await self._get("/api/tags")
        return [m.get("name", "") for m in data.get("models", [])]

    async def loaded_models(self) -> list[dict]:
        data = await self._get("/api/ps")
        return list(data.get("models", []))

    async def unload(self, model: str) -> None:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"{self.base_url}/api/chat",
                json={"model": model, "messages": [], "keep_alive": 0},
            )
            response.raise_for_status()

    async def chat_stream(self, model: str, messages: list[dict], options: dict) -> AsyncIterator[dict]:
        payload = {
            "model": model,
            "messages": messages,
            "stream": True,
            # Gemma 4 and Qwen3 can think first; for lyrics that only adds a long,
            # invisible wait before the first word appears.
            "think": False,
            # Kept warm briefly so a "try again" is instant; the queue unloads
            # it before any render.
            "keep_alive": "5m",
            "options": options,
        }
        async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
            async with client.stream("POST", f"{self.base_url}/api/chat", json=payload) as response:
                if response.status_code >= 400:
                    body = (await response.aread()).decode("utf-8", "replace")
                    raise LyricsUnavailable(_ollama_error(response.status_code, body, model))
                async for line in response.aiter_lines():
                    if line.strip():
                        yield json.loads(line)


def _ollama_error(status: int, body: str, model: str) -> str:
    try:
        detail = json.loads(body).get("error", body)
    except ValueError:
        detail = body
    if status == 404 or "not found" in str(detail).lower():
        return f"The lyrics model {model!r} is not installed. Install it from Settings, or choose another model."
    return f"Ollama returned {status}: {detail}"


class LyricsWriter:
    """Coordinates the local model with the YuE2 queue."""

    def __init__(self, client: OllamaClient | None = None) -> None:
        self.client = client or OllamaClient()
        self._lock = asyncio.Lock()

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    async def status(self, model: str, *, gpu_busy: bool) -> dict:
        version = await self.client.version()
        info: dict = {
            "ollama_running": version is not None,
            "ollama_version": version,
            "model": model,
            "model_installed": False,
            "installed_models": [],
            "loaded": False,
            "loaded_vram_bytes": 0,
            "gpu_busy": gpu_busy,
            "writing": self.busy,
        }
        if version is None:
            return info
        try:
            installed = await self.client.installed_models()
            loaded = await self.client.loaded_models()
        except (httpx.HTTPError, ValueError):
            return info
        info["installed_models"] = installed
        info["model_installed"] = model in installed
        for entry in loaded:
            if entry.get("name") == model or entry.get("model") == model:
                info["loaded"] = True
                info["loaded_vram_bytes"] = int(entry.get("size_vram") or 0)
        return info

    async def write(
        self, request: LyricsRequest, model: str, *, gpu_busy: bool,
    ) -> AsyncIterator[str | LyricsPhase | LyricsResult]:
        """Yield text chunks as they are generated, then the parsed result."""
        if gpu_busy:
            raise LyricsBusy(
                "YuE2 is rendering a song, and the lyrics model cannot share the GPU with it. "
                "Lyrics can be written as soon as the queue is empty."
            )
        if self._lock.locked():
            raise LyricsBusy("Lyrics are already being written. Wait for them to finish.")
        async with self._lock:
            if await self.client.version() is None:
                raise LyricsUnavailable(
                    "The local lyrics model is not running. Start SongForge with "
                    "Start-SongForge.ps1, which starts Ollama too."
                )
            try:
                loaded = await self.client.loaded_models()
            except (httpx.HTTPError, ValueError):
                loaded = []
            if not any(model in (m.get("name"), m.get("model")) for m in loaded):
                # Measured on the RTX 3060: ~17 s from the SSD after an unload,
                # far longer on the first run after a download or reboot.
                yield LyricsPhase("loading", f"Loading {model} into the GPU...")
            started = time.monotonic()
            parts: list[str] = []
            output_tokens = 0
            options = {
                "temperature": 0.9,
                "top_p": 0.95,
                "num_ctx": _CONTEXT_TOKENS,
                "num_predict": output_token_budget(request.minutes),
            }
            truncated_output = False
            async for chunk in self.client.chat_stream(model, build_messages(request), options):
                if chunk.get("error"):
                    raise LyricsUnavailable(f"Ollama: {chunk['error']}")
                text = (chunk.get("message") or {}).get("content") or ""
                if text:
                    if not parts:
                        yield LyricsPhase("writing", "Writing lyrics...")
                    parts.append(text)
                    yield text
                if chunk.get("done"):
                    output_tokens = int(chunk.get("eval_count") or 0)
                    if chunk.get("done_reason") == "length":
                        truncated_output = True
                        log.warning("lyrics hit the output limit")
            title, style, lyrics, warnings = parse_output("".join(parts))
            if truncated_output:
                # This used to append an empty string, so a half-written song
                # reached the editor looking finished.
                warnings.append(
                    "The writer hit its output limit, so the lyrics may stop mid-section. "
                    "Ask for a shorter song, or finish the last section yourself."
                )
            if not lyrics:
                raise LyricsUnavailable("The model returned no lyrics. Try again.")
            yield LyricsResult(
                title=title, style=style, lyrics=lyrics,
                estimated_seconds=round(estimate_seconds(lyrics), 1),
                model=model, output_tokens=output_tokens,
                seconds=round(time.monotonic() - started, 1), warnings=warnings,
            )

    async def warm_up(self, model: str, *, gpu_busy: bool) -> float:
        """Load the model ahead of the first request. Returns seconds taken."""
        if gpu_busy:
            raise LyricsBusy("YuE2 is using the GPU; the lyrics model will load when it is free.")
        if self._lock.locked():
            raise LyricsBusy("The lyrics model is already loading or writing.")
        # Holding the lock matters: the queue's ensure_unloaded() waits for it.
        # Without it, a load still in flight when a render starts could finish
        # after the unload and leave 7.5 GB of weights on the GPU mid-render.
        async with self._lock:
            if await self.client.version() is None:
                raise LyricsUnavailable("The local lyrics model is not running.")
            started = time.monotonic()
            async with httpx.AsyncClient(timeout=_REQUEST_TIMEOUT) as client:
                # Same num_ctx as writing: a different context size makes
                # Ollama reload the whole model on the first real request,
                # which undid the warm-up in a real run.
                response = await client.post(
                    f"{self.client.base_url}/api/chat",
                    json={
                        "model": model, "messages": [], "keep_alive": "5m",
                        "options": {"num_ctx": _CONTEXT_TOKENS},
                    },
                )
                if response.status_code >= 400:
                    raise LyricsUnavailable(_ollama_error(response.status_code, response.text, model))
            return round(time.monotonic() - started, 1)

    async def unload_all(self, timeout: float = 30.0) -> bool:
        """Unload every model Ollama holds and wait until the GPU is free of it.

        Returns True when nothing is loaded (including when Ollama is not
        running at all), False if a model was still loaded at the deadline.
        """
        if await self.client.version() is None:
            return True
        try:
            loaded = await self.client.loaded_models()
        except (httpx.HTTPError, ValueError):
            return True
        for entry in loaded:
            try:
                await self.client.unload(entry.get("name") or entry.get("model"))
            except httpx.HTTPError as exc:
                log.warning("could not unload %s: %s", entry.get("name"), exc)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                if not await self.client.loaded_models():
                    return True
            except (httpx.HTTPError, ValueError):
                return True
            await asyncio.sleep(0.5)
        return False


_writer: LyricsWriter | None = None


def get_writer() -> LyricsWriter:
    global _writer
    if _writer is None:
        _writer = LyricsWriter()
    return _writer


async def ensure_unloaded() -> None:
    """Called by the queue before every render. Never raises."""
    try:
        writer = get_writer()
        # A lyrics request that is mid-generation holds the model; let it finish
        # rather than pulling the weights out from under it.
        waited = 0.0
        while writer.busy and waited < 120:
            await asyncio.sleep(0.5)
            waited += 0.5
        freed = await writer.unload_all()
        if not freed:
            log.warning("lyrics model still loaded after unload; the render may run out of memory")
    except Exception:  # noqa: BLE001 - a render must never fail because of this
        log.exception("unloading the lyrics model failed")
