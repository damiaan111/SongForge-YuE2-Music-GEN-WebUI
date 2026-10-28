"""Local lyrics writer: prompt, parsing, GPU hand-off and the API.

Ollama is replaced by an in-memory fake, so these run without a GPU. The
behaviour they pin was measured against gemma4:12b on the RTX 3060: the reply
format, the length plan landing within ~3% of target, and a 1 s unload.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from songforge import lyrics
from songforge.lyrics import (
    LyricsBusy,
    LyricsPhase,
    LyricsRequest,
    LyricsResult,
    LyricsUnavailable,
    LyricsWriter,
    build_messages,
    estimate_seconds,
    parse_output,
    plan_length,
)

REPLY = """TITLE: Neon Ghost
STYLE: Synthwave, analog pads, melancholic, 100 BPM, male vocal
LYRICS:
[Verse]
The engine hums a low and lonely tune
Beneath the glow of a pale and fading moon

[Chorus]
City lights are blurring in the rain
I'm driving home to numb the quiet pain
"""


class FakeOllama:
    def __init__(self, reply: str = REPLY, loaded: list[str] | None = None, running: bool = True):
        self.reply = reply
        self.loaded = list(loaded or [])
        self.running = running
        self.base_url = "http://127.0.0.1:1"
        self.unloaded: list[str] = []
        self.chats: list[dict] = []

    async def version(self):
        return "0.34.0" if self.running else None

    async def installed_models(self):
        return ["gemma4:12b"]

    async def loaded_models(self):
        return [{"name": name, "size_vram": 7_500_000_000} for name in self.loaded]

    async def unload(self, model):
        self.unloaded.append(model)
        self.loaded = [m for m in self.loaded if m != model]

    async def chat_stream(self, model, messages, options):
        self.chats.append({"model": model, "messages": messages, "options": options})
        self.loaded = [model]
        for index in range(0, len(self.reply), 40):
            yield {"message": {"content": self.reply[index:index + 40]}, "done": False}
        yield {"message": {"content": ""}, "done": True, "done_reason": "stop", "eval_count": 64}


async def collect(writer, request, gpu_busy=False):
    return [item async for item in writer.write(request, "gemma4:12b", gpu_busy=gpu_busy)]


# ---------------------------------------------------------------- length plan


@pytest.mark.parametrize("minutes", [1, 2, 3, 4, 5, 6])
def test_plan_hits_the_measured_length_model(minutes: float) -> None:
    plan = plan_length(minutes)
    assert abs((27 + plan.characters / 8.5) - minutes * 60) < 1
    assert plan.sections[0] == "Intro" and plan.sections[-1] == "Outro"
    assert "Chorus" in plan.sections and "Verse" in plan.sections


def test_longer_songs_get_more_sections() -> None:
    counts = [len(plan_length(m).sections) for m in (1, 3, 5)]
    assert counts == sorted(counts) and counts[0] < counts[-1]


def test_estimate_ignores_section_tags() -> None:
    assert estimate_seconds("[Verse]\n" + "a" * 85) == estimate_seconds("a" * 85) == 37.0


# -------------------------------------------------------------------- prompts


def test_prompt_carries_language_length_and_structure() -> None:
    messages = build_messages(LyricsRequest(idea="zomer aan zee", language="Dutch", minutes=3,
                                            style_hint="indie pop", mood="warm"))
    system, user = messages[0]["content"], messages[1]["content"]
    assert "[Verse]" in system and "TITLE:" in system and "Tags are always in English" in system
    assert "Dutch" in user and "zomer aan zee" in user and "about 3 minutes" in user
    assert "indie pop" in user and "Mood: warm" in user and "Suggested structure: [Intro]" in user


def test_revise_prompt_includes_the_current_lyrics_and_instruction() -> None:
    user = build_messages(LyricsRequest(idea="", existing_lyrics="[Verse]\nold line",
                                        instruction="make the chorus hopeful"))[1]["content"]
    assert "Revise these lyrics" in user and "make the chorus hopeful" in user and "old line" in user
    assert "Suggested structure" not in user


# -------------------------------------------------------------------- parsing


def test_parse_the_real_reply_format() -> None:
    title, style, text, warnings = parse_output(REPLY)
    assert title == "Neon Ghost"
    assert style.startswith("Synthwave")
    assert text.startswith("[Verse]\nThe engine hums") and "\n\n[Chorus]\n" in text
    assert warnings == []


def test_parse_normalises_what_small_models_get_wrong() -> None:
    messy = """```
**TITLE:** Test
STYLE: pop
LYRICS:
Verse 1:
- First line (x2)
(guitar solo)
*softly*
CHORUS
Second line
[Refrain]
Third line
Pre chorus
Fourth line
```"""
    _, _, text, warnings = parse_output(messy)
    assert text == "[Verse]\nFirst line\n\n[Chorus]\nSecond line\n\n[Chorus]\nThird line\n\n[Pre-Chorus]\nFourth line"
    assert warnings == []


def test_parse_without_the_format_still_extracts_lyrics() -> None:
    _, _, text, warnings = parse_output("just a line\nanother line")
    assert text == "[Verse]\njust a line\nanother line"
    assert any("format" in w for w in warnings)
    assert any("marked as one verse" in w for w in warnings)


# ------------------------------------------------------------------- writing


def test_write_streams_phases_text_and_result() -> None:
    fake = FakeOllama()
    items = asyncio.run(collect(LyricsWriter(fake), LyricsRequest(idea="night drive")))
    phases = [i.phase for i in items if isinstance(i, LyricsPhase)]
    assert phases == ["loading", "writing"]
    result = items[-1]
    assert isinstance(result, LyricsResult)
    assert result.title == "Neon Ghost" and result.output_tokens == 64 and result.model == "gemma4:12b"
    assert "".join(i for i in items if isinstance(i, str)) == REPLY
    assert fake.chats[0]["options"]["num_ctx"] == 8192


def test_no_loading_phase_when_already_loaded() -> None:
    items = asyncio.run(collect(LyricsWriter(FakeOllama(loaded=["gemma4:12b"])), LyricsRequest(idea="x")))
    assert [i.phase for i in items if isinstance(i, LyricsPhase)] == ["writing"]


def test_write_refuses_while_yue2_uses_the_gpu() -> None:
    with pytest.raises(LyricsBusy, match="rendering"):
        asyncio.run(collect(LyricsWriter(FakeOllama()), LyricsRequest(idea="x"), gpu_busy=True))


def test_write_explains_when_ollama_is_not_running() -> None:
    with pytest.raises(LyricsUnavailable, match="not running"):
        asyncio.run(collect(LyricsWriter(FakeOllama(running=False)), LyricsRequest(idea="x")))


def test_empty_reply_is_an_error_not_blank_lyrics() -> None:
    with pytest.raises(LyricsUnavailable, match="no lyrics"):
        asyncio.run(collect(LyricsWriter(FakeOllama(reply="TITLE: x\nSTYLE: y\nLYRICS:\n")), LyricsRequest(idea="x")))


# ------------------------------------------------------------- GPU hand-off


def test_unload_all_empties_the_gpu() -> None:
    fake = FakeOllama(loaded=["gemma4:12b"])
    assert asyncio.run(LyricsWriter(fake).unload_all()) is True
    assert fake.unloaded == ["gemma4:12b"] and fake.loaded == []


def test_ensure_unloaded_waits_for_a_write_in_progress(monkeypatch) -> None:
    """A render must not pull the weights out from under lyrics being written."""
    fake = FakeOllama(loaded=["gemma4:12b"])
    writer = LyricsWriter(fake)
    monkeypatch.setattr(lyrics, "_writer", writer)
    order: list[str] = []

    async def scenario():
        await writer._lock.acquire()

        async def finish_writing():
            await asyncio.sleep(0.8)
            order.append("write finished")
            writer._lock.release()

        task = asyncio.create_task(finish_writing())
        await lyrics.ensure_unloaded()
        order.append("unloaded")
        await task

    asyncio.run(scenario())
    assert order == ["write finished", "unloaded"]
    assert fake.loaded == []


def test_warm_up_holds_the_lock_so_a_render_waits_for_it(monkeypatch) -> None:
    class SlowLoad(FakeOllama):
        pass

    writer = LyricsWriter(SlowLoad())
    captured: dict = {}

    async def scenario():
        async def fake_post(*args, **kwargs):
            captured["json"] = kwargs.get("json")
            await asyncio.sleep(0.5)

            class R:
                status_code = 200
                text = ""
            return R()

        import httpx

        class FakeClient:
            def __init__(self, *a, **k): ...
            async def __aenter__(self): return self
            async def __aexit__(self, *a): return False
            post = staticmethod(fake_post)

        monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
        warm = asyncio.create_task(writer.warm_up("gemma4:12b", gpu_busy=False))
        await asyncio.sleep(0.1)
        assert writer.busy, "warm-up must hold the lock while loading"
        await warm
        assert not writer.busy
        assert captured["json"]["options"]["num_ctx"] == 8192, "must match writing, or Ollama reloads"


    asyncio.run(scenario())


def test_ensure_unloaded_never_raises(monkeypatch) -> None:
    class Broken(FakeOllama):
        async def loaded_models(self):
            raise RuntimeError("ollama exploded")

    monkeypatch.setattr(lyrics, "_writer", LyricsWriter(Broken()))
    asyncio.run(lyrics.ensure_unloaded())  # must not raise


def test_queue_unloads_before_yue2_renders_only(client, fast_mock, monkeypatch) -> None:
    from songforge import queue as queue_module

    calls: list[str] = []

    async def record():
        calls.append("unload")

    monkeypatch.setattr(queue_module.lyrics, "ensure_unloaded", record)
    from .test_backend_audit import generate
    from .test_features import make_project, settle

    settle(client, generate(client, make_project(client)))
    assert calls == [], "the mock runner uses no GPU, so nothing is unloaded"


# ----------------------------------------------------------------------- API


@pytest.fixture
def fake_writer(monkeypatch):
    writer = LyricsWriter(FakeOllama())
    monkeypatch.setattr(lyrics, "_writer", writer)
    return writer


def _events(body: str) -> list[tuple[str, dict]]:
    events = []
    for block in body.strip().split("\n\n"):
        name = block.split("\n")[0].removeprefix("event: ")
        data = json.loads(block.split("\n")[1].removeprefix("data: "))
        events.append((name, data))
    return events


def test_status_reports_model_and_gpu(client, fake_writer) -> None:
    body = client.get("/api/lyrics/status").json()
    assert body["ollama_running"] is True and body["model"] == "gemma4:12b"
    assert body["model_installed"] is True and body["gpu_busy"] is False and body["enabled"] is True


def test_generate_streams_events(client, fake_writer) -> None:
    response = client.post("/api/lyrics/generate", json={"idea": "night drive", "minutes": 2})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    events = _events(response.text)
    names = [name for name, _ in events]
    assert names[0] == "status" and names[-1] == "done" and "token" in names
    done = events[-1][1]
    assert done["title"] == "Neon Ghost" and done["lyrics"].startswith("[Verse]")


def test_generate_needs_an_idea_or_lyrics(client, fake_writer) -> None:
    assert client.post("/api/lyrics/generate", json={"idea": "  "}).status_code == 422


def test_generate_is_refused_while_a_song_is_queued(client, fake_writer, monkeypatch) -> None:
    from songforge.api import lyrics as lyrics_api

    monkeypatch.setattr(lyrics_api, "_gpu_busy", lambda session: True)
    response = client.post("/api/lyrics/generate", json={"idea": "x"})
    assert response.status_code == 409 and "cannot share the GPU" in response.json()["detail"]


def test_generate_is_refused_when_disabled(client, fake_writer) -> None:
    client.put("/api/settings", json={"lyrics_enabled": False})
    assert client.post("/api/lyrics/generate", json={"idea": "x"}).status_code == 409


def test_minutes_are_bounded(client, fake_writer) -> None:
    assert client.post("/api/lyrics/generate", json={"idea": "x", "minutes": 20}).status_code == 422


def test_unload_endpoint(client, fake_writer) -> None:
    fake_writer.client.loaded = ["gemma4:12b"]
    assert client.post("/api/lyrics/unload").json() == {"unloaded": True}


def test_model_name_is_validated(client) -> None:
    bad = client.put("/api/settings", json={"lyrics_model": "gemma4; rm -rf /"})
    assert bad.status_code == 422
    ok = client.put("/api/settings", json={"lyrics_model": "qwen3:8b"})
    assert ok.status_code == 200 and ok.json()["lyrics_model"] == "qwen3:8b"


@pytest.mark.parametrize("url", ["http://192.0.2.10:11434", "https://127.0.0.1:11434", "http://example.com"])
def test_ollama_url_must_be_loopback(url, monkeypatch) -> None:
    from pydantic import ValidationError

    from songforge.config import Config

    with pytest.raises(ValidationError):
        Config(ollama_url=url)


def test_real_gemma_reply_with_lyric_singular_header() -> None:
    """gemma4:12b wrote "LYRIC:" in a real one-click run; YuE2 then sang "LYRIC"."""
    real = (
        "TITLE: Sunday Stillness\nSTYLE: warm acoustic pop\nLYRIC:\n\n[Intro]\n\n[Verse]\n"
        "The steam rises slow in the morning light\n\n[Chorus]\nOne cup of coffee, one moment of grace\n"
    )
    title, style, text, warnings = parse_output(real)
    assert title == "Sunday Stillness" and style == "warm acoustic pop"
    assert text.startswith("[Intro]") and "LYRIC" not in text.upper().replace("[", "")
    assert warnings == []


@pytest.mark.parametrize("header", ["Lyrics:", "## Lyrics", "Song lyrics -", "LYRICS", "lyric:"])
def test_header_variants_are_never_sung(header: str) -> None:
    _, _, text, _ = parse_output(f"TITLE: x\nSTYLE: y\n{header}\n[Verse]\nla la\n")
    assert text == "[Verse]\nla la"


def test_stray_header_lines_inside_lyrics_are_dropped() -> None:
    _, _, text, _ = parse_output("TITLE: x\nLYRICS:\n[Verse]\nSTYLE: pop\nla la\n")
    assert text == "[Verse]\nla la"


# ------------------------------------------------- lyric integrity (phase 1)


def test_backing_vocals_are_kept_not_deleted() -> None:
    """A parenthesised line is a sung line; dropping it lost whole sentences."""
    _, _, text, warnings = parse_output(
        "TITLE: x\nSTYLE: y\nLYRICS:\n[Chorus]\nHold me now\n(ooh-ooh)\n(hold me closer)\n"
    )
    assert text == "[Chorus]\nHold me now\nooh-ooh\nhold me closer"
    assert warnings == []


@pytest.mark.parametrize("note", ["(guitar solo)", "(Fade Out)", "(no vocals)", "*softly*",
                                  "(repeat chorus)", "(instrumental break)"])
def test_production_notes_are_still_dropped(note: str) -> None:
    _, _, text, _ = parse_output(f"TITLE: x\nSTYLE: y\nLYRICS:\n[Verse]\nreal line\n{note}\n")
    assert text == "[Verse]\nreal line"


def test_decorated_section_tags_are_recognised_and_repeats_expanded() -> None:
    _, _, text, warnings = parse_output(
        "TITLE: x\nSTYLE: y\nLYRICS:\n[Verse 1 - soft]\nfirst line\n"
        "[Chorus x2]\nhook line\n[Intro: Piano]\n"
    )
    assert text == ("[Verse]\nfirst line\n\n[Chorus]\nhook line\n\n"
                    "[Chorus]\nhook line\n\n[Intro]")
    assert any("written out in full" in w for w in warnings)


def test_writer_truncation_is_reported_to_the_user() -> None:
    class CutOff(FakeOllama):
        async def chat_stream(self, model, messages, options):
            self.chats.append({"model": model, "messages": messages, "options": options})
            yield {"message": {"content": self.reply}, "done": False}
            yield {"message": {"content": ""}, "done": True,
                   "done_reason": "length", "eval_count": 3000}

    items = asyncio.run(collect(LyricsWriter(CutOff()), LyricsRequest(idea="a long song")))
    result = next(item for item in items if isinstance(item, LyricsResult))
    assert any("output limit" in w for w in result.warnings)


def test_output_budget_grows_with_the_requested_length() -> None:
    short, long = lyrics.output_token_budget(1), lyrics.output_token_budget(6)
    assert 1200 <= short < long <= 6000


def test_section_count_stays_within_the_requested_minutes() -> None:
    """A section is ~30 s, so a 6 minute song needs about 12 of them, not 16."""
    for minutes in (1, 3, 6):
        sections = plan_length(minutes).sections
        assert len(sections) <= round(minutes * 60 / 30) + 2


@pytest.mark.parametrize("line", [
    "Verse, I remember you",
    "Chorus of voices in the hall",
    "Bridge over the river at dawn",
    "Break my heart again",
])
def test_a_lyric_line_starting_with_a_section_word_is_not_a_tag(line: str) -> None:
    """The decorated-tag rule must not swallow ordinary sentences."""
    _, _, text, _ = parse_output(f"TITLE: x\nSTYLE: y\nLYRICS:\n[Verse]\n{line}\n")
    assert text == f"[Verse]\n{line}"
