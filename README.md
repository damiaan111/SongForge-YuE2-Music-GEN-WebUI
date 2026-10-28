# SongForge | YuE2 Music GEN WebUI — macOS / Apple Silicon

> **This is the `macos` branch.** It is `main` plus a few Apple-specific
> differences, listed in [docs/macos.md](docs/macos.md) — read that first. For
> Windows or Linux, use `main`.

A self-hosted music studio for the **YuE2** text-to-music model. It runs on your
own machine and is used from any browser on the same local network — there is no
cloud service, no account, and nothing leaves the computer.

Generation is real: the model writes a symbolic score, renders it to audio, and
saves a 24-bit / 48 kHz FLAC master.

Every timing in this file was measured on the reference machine for `main`, a
12 GB RTX 3060. **No Apple Silicon measurements exist yet.** Expect slower,
partly because the VAE decode has no Metal path and runs on the CPU. If you
have numbers, they are the most useful thing you could contribute to this
branch.

```
git clone -b macos https://github.com/damiaan111/SongForge-YuE2-Music-GEN-WebUI
cd SongForge-YuE2-Music-GEN-WebUI
./setup.sh
```

Setup detects your GPU, tells you what is needed and how large it is, and
installs only what you tick. Nothing is downloaded before you agree to it.

> **The model weights are CC BY-NC 4.0 — non-commercial.** This application is
> MIT, which does not extend to the model or to what you make with it. See
> [NOTICE.md](NOTICE.md).

---

## What it does

- **Library** — every song, with search, filters, tags, favourites, sorting,
  multi-select archive/delete/export, and a queue that survives a refresh.
- **Create** — a Quick mode (describe it, add lyrics, go), a Custom mode with the
  model's real controls (planning mode, seed, guidance scale, language, vocal
  preference, output formats), and a Cover mode that takes an ABC melody and
  plans the melody only, as YuE2's own guidance recommends.
- **Guided prompting** — the style box composes comma-separated tags in the order
  YuE2 was trained on, with genre, mood and "avoid" chips, tempo and key hints,
  and a checklist of the four tags that most change the result. The lyrics
  editor flags what costs you words: shorthand like `x2`, sections over six
  lines, production notes, and repeats whose syllable counts have drifted.
- **Budget meter** — before you spend GPU time, an estimate of sung length against
  YuE2's six-minute ceiling and of the prompt against its 24,576-token context,
  so an overlong lyric is caught at the keyboard rather than in the render.
- **Learn** — in-app guidance for this model: writing style tags, writing lyrics
  it will actually sing, and why songs get cut short, plus a troubleshooting
  table keyed to the warnings the app emits. It works offline.
- **Song workspace** — Overview, Lyrics, Style, **Score**, Versions, Files, Logs.
  Completed versions are immutable; edits are drafts until you render again.
- **Plan → edit → render** — YuE2 can write only the score first (about 86 s
  instead of 220 s), let you edit the ABC by hand, then render audio from it.
  This is the feature no hosted service offers.
- **Reproducibility** — every version records its seed, planning mode, guidance
  scale, sampling overrides, model and decoder checksums, and the exact command
  line. **Reuse this take** in Versions puts all of it back into the editor.
- **Several takes per Generate** — two by default, up to 8, each with its own seed,
  compared side by side. Best-of-two is YuE2's own published baseline, so a
  single take is the model at its worst rather than its average. They run one
  after another; on the RTX 3060 that is 3–4 minutes each, and the Create page
  quotes an estimate scaled to your own hardware.
- **Sampling controls** — score and audio sampling (temperature, top-p, top-k,
  repetition penalty, token limits) and synthesis steps, with YuE2's defaults
  shown in every blank field.
- **Lyrics writer** — a local language model (gemma4:12b through Ollama) writes
  or revises lyrics in any language, sized to a target length, from a
  **Generate lyrics** button on every lyrics box or the **Lyrics** page. One click
  can also write the lyrics and start the render. Nothing leaves this computer.
- **Settings** — first-run wizard, runner configuration with a command preview,
  and a safe diagnostic that loads nothing onto the GPU.

### What it deliberately does not do

These are model limits, not missing features, so no control pretends otherwise:

| Not available | Why |
| --- | --- |
| Stem separation | The pipeline decodes one stereo mix; there is no separation model. |
| Extend / continue a song | Conditioning takes score tokens, not audio. |
| Remix from an uploaded recording | There is no audio input. A cover starts from an ABC score. |
| MIDI export | The symbolic output is ABC text. `score.abc` is downloadable. |
| Voice cloning / personas | The request has no speaker or reference-audio field. |
| A song-length dial | Length follows the lyrics and stops when the model ends the piece. |
| Cover art | Removed: it was a generated gradient, not artwork, and nobody wanted it. |

Instrumental mode works, but as a prompt directive plus empty lyrics rather than
a model flag — the UI says so where you turn it on.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| macOS 14 Sonoma or newer, on Apple Silicon | 14 is a floor, not a preference: the model loads in bfloat16 and Metal bfloat16 arrived in 14. Intel Macs have no Metal path and fall back to the CPU. |
| Python 3.12 | `brew install python@3.12`. Setup finds it; two virtual environments are created from it. |
| Node.js 20 LTS or newer | `brew install node`. For the web frontend. |
| ~40 GB free disk | Weights are ~15 GB; songs accumulate quickly. |
| FFmpeg | Optional. Setup installs it with Homebrew if you tick it. Only for MP3/WAV exports; the FLAC master never needs it. |

**Memory.** Apple Silicon shares one pool between CPU and GPU, so setup takes a
share of RAM rather than a card's VRAM. Upstream YuE2 asks for 24 GB of *video*
memory; 24 GB of shared memory is less than that, not equal to it.

| Machine | Status |
| --- | --- |
| 32 GB or more | Comfortable. |
| 16–24 GB | Works. Keep songs short and close other applications. |
| 8 GB | Setup warns. Long songs will not fit. |
| Intel Mac | No Metal path. The CPU opt-in works; a song takes hours. |

Two upstream limits apply here and not on CUDA: the **VAE decode runs on the
CPU**, and **fp8 is unavailable**. Both are explained in
[docs/macos.md](docs/macos.md).

No pagefile configuration is needed; macOS grows its swap by itself. Keep a few
tens of gigabytes free on the boot volume and it will.

---

## Install

```
./setup.sh
```

That is the whole thing. The script finds a Python 3.12+, then shows a menu:

```
SongForge setup
------------------------------------------------------------------------
Detected: Apple M3 Pro, 18 GB shared - Darwin
PyTorch:  Apple Metal (MPS)

  [x]  1  Python backend environment                   120 MB  required
  [x]  2  Node.js frontend packages                    430 MB  required
  [x]  3  PyTorch 2.10.0 for Apple Metal (MPS)         3.0 GB  required
  [x]  4  YuE2 inference package                         2 MB  required
  [x]  5  YuE2-3B weights (m-a-p/YuE2-3B)             13.0 GB  required  CC BY-NC 4.0
  [x]  6  YuE2 VAE weights (m-a-p/YuE2-Vae)            1.4 GB  required  CC BY-NC 4.0
  [ ]  7  Local lyrics writer (Ollama)                 9.0 GB  optional
  [ ]  8  FFmpeg                                        90 MB  optional

To download: 17.9 GB   Free on this drive: 212.4 GB

------------------------------------------------------------------------
[1-9] toggle   [a] all   [n] none   [Enter] install   [q] quit
```

Every line is a checkbox, including the required ones. Nothing is downloaded
until you press Enter, and the non-commercial weight licence is shown and
acknowledged before any weight is fetched.

Run it again whenever you like: anything already installed shows as `done` and
is skipped.

**Useful flags**

| Flag | Does |
| --- | --- |
| `--detect` | Print the detected GPU, the chosen PyTorch build and the settings derived from it, as JSON. Include this in bug reports. |
| `--yes` | Install the required components without asking. For scripts and CI. |
| `--only=backend,frontend` | Install just those. Enough to develop against the mock runner without the 15 GB of weights. |
| `--dry-run` | Print every command that would run, without running any of it. |

**What it writes.** Everything lands under `runtime/`, which is gitignored in
full: two virtual environments, the weights, the database, the logs and your
songs. Setup also writes `runtime/hardware-profile.json`, which the backend
reads the first time it starts to fill in the model paths and a memory budget
that suits your card — so there is nothing to type in Settings afterwards.

Installing by hand instead: [docs/manual-install.md](docs/manual-install.md).

**Verify before the first render**

```bash
runtime/venv-yue2/bin/python -m yue2.cli doctor --verify-hashes
```

Reports dependencies, the device it will use — look for `"mps_available": true`
— and every weight file's checksum. It loads nothing onto the GPU. There is no
shell equivalent of `Test-YuE2Runner.ps1`; this is the command it wraps. To render one
short song end to end, which does use it.

---

## First startup

```bash
./scripts/start-songforge.sh
```

The script refuses to start a second copy, waits for `/api/health`, and prints
both addresses:

```
  On this PC:    http://localhost:3333
  On your LAN:   http://192.168.1.42:3333
```

Open the first one. The **first-run wizard** appears and walks through storage,
runner, model and GPU, the command template, a safe test, and network access.
Nothing touches the GPU until you press **Run test**.

Stop it with `./scripts/stop-songforge.sh`. A generation in progress is
cancelled cleanly and its logs are kept.

### Optional convenience

The desktop-shortcut and startup-task scripts on `main` are PowerShell and
have no shell equivalents. To start SongForge at login, add
`start-songforge.sh` as a login item in **System Settings → General → Login
Items**, or write a `launchd` plist if you also want it restarted when it
exits.

---

## Lyrics writer (optional)

**SongForge works without this.** You can write or paste lyrics into the editor
and never install any of it. It is offered because having the model write a
first draft to the right shape — four to six lines a section, repeats written
out in full — saves more time than it costs.

When it is there, it runs locally through
[Ollama](https://github.com/ollama/ollama), so nothing is sent to a cloud
service. Setup picks a Gemma model sized to your card: 12B on 11 GB or more,
4B on a smaller one, 1B below that.

**Install**

1. Get Ollama from [ollama.com](https://ollama.com) (or unpack the portable
   build into `runtime/ollama`, which the start script will then launch for
   you, on localhost only and with its cloud features disabled).
2. Tick the lyrics writer in `setup`, or pull the model yourself:
   `ollama pull gemma4:12b`.

To keep the download inside the project rather than your home directory, set
`OLLAMA_MODELS` to `runtime/models/ollama` before pulling; the start script
sets it the same way.

Without Ollama, the Lyrics page explains that it is optional and points here.
Nothing errors, and no feature other than lyric writing is affected.

**Using it**

- **Generate lyrics** on any lyrics box opens the writer. Describe what the song
  is about, pick a language and a length, and press Generate lyrics. The text
  streams in; **Use these lyrics** puts it in the editor, and your previous
  lyrics are kept in History.
- **Revise** mode changes the lyrics already in the editor: "make the chorus more
  hopeful", "add a bridge".
- **Write lyrics & render song** does both in one step. If the writer notices
  anything off about the lyrics it produced, it stops and shows them instead of
  rendering.
- The **Lyrics** page is a separate workspace for trying ideas, with earlier
  results kept in the browser, and **Open in Create** or **Render as a new song**.

**Sharing the graphics card with YuE2**

The two cannot run at the same time on a 12 GB card: gemma4:12b takes about
7.5 GB, and YuE2 needs about 10.8 GB while rendering. SongForge handles this:

- The writer is unavailable while a song is rendering or queued, and says so.
- Before every render, SongForge unloads the lyrics model and waits until the
  GPU is free. It takes about a second.
- Opening the writer loads the model in the background when the GPU is free, so
  the ~17-second load usually happens while you type. The first load after
  installing or rebooting can take up to two minutes.

Measured on the RTX 3060: a three-minute song's lyrics take about 13 seconds to
write once the model is loaded, and the requested length lands within about 5%.
The lyrics writer is a separate, much smaller model and runs on Metal through
Ollama, which supports it well; this is the part of the stack least affected by
the platform.

## Connecting from another device on your network

1. Both machines must be on the same network. Substitute your own subnet
   below; `192.168.1.0/24` is only an example.
2. macOS has no port-level firewall rule to add. Its application firewall
   works per-application, so the first time the frontend listens you are
   asked whether to allow incoming connections to `node` — answer yes. With
   the firewall switched off, nothing is asked and the port is already open.

3. Open `http://<host-pc-ip>:3333` in a browser on the other device. The address is
   printed by the start script, and shown in **Settings → Access**.

Only the frontend listens on the network. The API binds to `127.0.0.1` and is
reached through the frontend's proxy, so it is never directly exposed. Do not
port-forward either one, and do not put this behind a tunnel: there is no
authentication, by design.

---

## Model configuration

Everything below lives in **Settings**, and each field explains itself there.

| Setting | Sensible value | Why |
| --- | --- | --- |
| Model | `runtime/models/YuE2-3B` | Local path, or a Hugging Face id. |
| Audio decoder | `standard` | `legacy` scores higher on musicality benchmarks; `standard` sounds cleaner. |
| GPU index | `0` | Ignored on Metal; there is one device. |
| Memory budget | 60% of RAM | Set by setup. This is shared memory, not a card's VRAM: YuE2 caps itself at budget − 2 GiB, and whatever it takes is taken from macOS. Lower it if the system starts swapping; raising it past about 70% makes things worse, not faster. |
| Attention backend | `torch-eager` | **Required.** Plain `torch` needs FlashAttention, which is CUDA-only. |
| Quantization | `none` | `fp8` is CUDA-only in yue2 and cannot be used here. |
| Offline mode | on, after the first download | Prevents any Hugging Face lookup. |

The **command template** builds the `yue2` command line from documented
placeholders. Only the `yue2` CLI and its own flags are accepted — the field is
constrained on purpose, because Settings is reachable by anyone who can reach
the app, and a free-form executable plus free-form arguments would be a remote
code execution hole. Arguments are always passed as a list; no shell is
involved.

---

## Backup

The library is two folders inside `runtime`:

```
runtime\projects\    one folder per song: lyrics, style, score, every version's audio and logs
runtime\database\    songforge.db - titles, tags, versions, job history
```

Stop the app, copy both, and you have everything. Restoring is copying them
back. Weights in `runtime\models` are re-downloadable and do not need backing
up.

A single song can be exported at any time from its **Files** tab as a ZIP
containing the audio, score, request and logs. To export several, select them
in the Library and choose **Export ZIP**; each song gets its own folder.

---

## Updating

```bash
./scripts/stop-songforge.sh
runtime/venv/bin/python -m pip install -e "app/backend[test]"
(cd app/frontend && npm ci && npm run build)
./scripts/start-songforge.sh
```

The database migrates itself on startup: columns added by a newer version are
added to your existing database. The migration only ever adds; it never drops or
rewrites data. To update the model package, install
the new wheel into `runtime/venv-yue2` and re-run `yue2.cli doctor
--verify-hashes` — the weight checksums are re-verified, and Settings will report any mismatch.

---

## Troubleshooting

**The model fails to load, or the render is killed part-way**

Loading a 3B model briefly needs far more memory than its resident footprint
suggests, and on Apple Silicon that memory is the same pool the system is
using. Quit other applications — a browser with many tabs is usually the
largest — and keep tens of gigabytes free on the boot volume so macOS can
grow its swap.

If it still fails, lower **Memory budget** in Settings. Setup sets it to 60%
of RAM, which is a starting point rather than a measurement.

**`load failed` or a dtype error immediately on model load**

The model loads in bfloat16, and Metal bfloat16 needs macOS 14. On macOS 13
there is no fallback. Check with `sw_vers`.

**`FlashAttention is not available`, or a crash immediately after model load**

The attention backend is set to `torch`. Change it to `torch-eager` in
Settings. FlashAttention is CUDA-only and will never be available here;
`torch-eager` is the working configuration, not a workaround with a cost.

**The lyrics writer says the model is not running**

Ollama starts with `start-songforge.sh` only if it is found on `PATH`, in
`runtime/ollama/`, or as `/Applications/Ollama.app`; check the newest
`runtime/logs/ollama-*.log`. If another Ollama is
already running on port 11434, SongForge uses it instead, and that copy needs
gemma4:12b installed.

**How long can a song be, and how long does it take?**

Measured on the reference RTX 3060 12 GB with the budget at 12 GiB and
memory-efficient attention on. **These are CUDA numbers, not Apple ones.**
The shape holds — memory flat, time growing with length — but the constants do
not transfer:

| Song | Audio | Generation time | GPU peak (whole card) |
| --- | --- | --- | --- |
| 2 short sections | 0:44 | 3 min | 9.0 GB |
| Instrumental, no lyrics | 3:51 | 11.7 min | 10.8 GB |
| 13 sections | 3:55 | 11.7 min | 10.8 GB |
| 17 sections | 4:55 | 16.3 min | 10.8 GB |
| 21 sections | 5:31 | 19.3 min | 10.8 GB |

Memory stays flat as songs get longer; time grows a little faster than length.
Length follows the lyrics - roughly 27 seconds plus one second per 8.5
characters of lyric - and the Create page shows that estimate as you type. The
audio token limit defaults to 9,000 (about six minutes); for anything longer,
raise **Audio sampling → Max tokens**, or the song is cut short and marked so.

**Songs past about two minutes fail with "OutOfMemoryError"**

On Metal this is memory pressure rather than a kernel problem. YuE2 expands
its grouped attention heads for MPS itself (`nar.py`, `modeling_yue2.py`), so
the quadratic fallback that affects CUDA on Windows does not arise here, and
SongForge's own attention shim is a no-op on this platform — it is guarded on
`is_cuda`. Leaving **Memory-efficient attention** on costs nothing.

Lower the **Memory budget**, shorten the lyrics, and quit other applications.
A song that fits on a 32 GB Mac may not fit on a 16 GB one.

**A song fails with "OutOfMemoryError"**

YuE2 limits itself to the memory budget minus 2 GiB. Unlike a discrete card,
raising the budget here does not give you memory the system was not using — it
takes it from macOS, which then swaps. Longer pieces need more memory. An
instrumental with no lyrics tends to plan a much longer score (one real run
planned 2,475 score tokens against 525 for a two-verse song), so lowering
**Score sampling → Max tokens** keeps it within reach.

**`fp8` does nothing, or errors**

Set Quantization to `none`. yue2 applies fp8 only on CUDA; setup leaves it off
here for that reason.

**Generate is rejected because lyrics are required**

YuE2 always needs a lyric block, even in Quick mode — a prompt alone is not a
valid request. For an instrumental piece, turn on the instrumental toggle, which
sends an instrumental directive and allows the lyrics to be empty.

**The sampling controls say they are unavailable**

Your command template predates them. In **Settings → Command template**, press
**Reset**. The controls need the `{request_file}` and `{config_file}`
placeholders, and resume needs `{resume}`; SongForge refuses overrides rather
than silently ignoring them.

**The Score tab is empty**

Planning mode was `off` for that version. That mode skips the symbolic stage
entirely — it is roughly 15 % faster and produces no score to edit. Use `full`
or `melody` if you want an editable score.

**A version says the song was cut short**

The model hit its token ceiling before finishing. Shorten the lyrics, or raise
the audio token limit in the advanced sampling controls. The default ceiling is
about six minutes of audio.

**MP3 or WAV downloads are missing**

FFmpeg is not on PATH. The FLAC master is always written by the model itself and
is unaffected; install FFmpeg and re-render, or just download the FLAC.

**The page loads but says the backend is unreachable**

The frontend is up and the API is not. Check the newest
`runtime/logs/backend-*.log`. The
most common cause is a stale lock file after a hard shutdown, which
`stop-songforge.sh` clears.

**A job is stuck as "interrupted" after a crash or power cut**

That status is correct and deliberate: the backend cannot know whether the run
finished, so it does not claim it did. In the song's **Logs** tab:

- **Recover finished run** — if YuE2 had already finished before SongForge
  stopped, this records that result in seconds. YuE2 re-checks it against the
  request, settings and weight checksums, and SongForge tells you plainly when
  there is nothing to recover. YuE2 cannot continue a half-finished run.
- **Retry with the same settings** — renders it again as a new version.

The logs and any partial output are kept either way.

**Another device cannot reach the app**

Confirm the firewall rule exists and names the right subnet
(`Get-NetFirewallRule -DisplayName SongForge`), that both machines are on the
same network, and that you are using the LAN address rather than `localhost`.

---

## Licences

Two of them, and the difference matters.

- **This repository's code is MIT.** Fork it, change it, ship it. See
  [LICENSE](LICENSE).
- **The YuE2 weights are CC BY-NC 4.0 — non-commercial.** They are not
  redistributed here; setup downloads them from
  [m-a-p/YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B) and
  [m-a-p/YuE2-Vae](https://huggingface.co/m-a-p/YuE2-Vae) at your request, and
  shows the licence before it does.

The MIT licence on this interface grants you nothing in respect of the model or
of what you generate with it. If you plan to release, sell or monetise a song,
read [NOTICE.md](NOTICE.md) first.

Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Development

```bash
runtime/venv/bin/python -m uvicorn songforge.main:app --app-dir app/backend --reload --port 3334
```

```bash
cd app/frontend && npm run dev
```

```bash
(cd app/backend && ../../runtime/venv/bin/python -m pytest -q)
(cd app/frontend && npm run typecheck && npm run lint)
```

Set the runner to **Mock** in Settings to exercise the whole interface —
queue, progress, cancellation, versions, downloads — without a GPU.

API documentation is served at `http://localhost:3334/api/docs` while the
backend is running.

### Layout

```
app/backend/songforge/   FastAPI app: api/, runners/, models, queue, storage
app/frontend/src/        Next.js app: app/ pages, components/, lib/
runtime/projects/        one folder per song
runtime/database/        SQLite
runtime/models/          weights
runtime/logs/            service logs, pruned to the last 10 starts
scripts/                 start and stop; the .ps1 scripts belong to `main`
```
