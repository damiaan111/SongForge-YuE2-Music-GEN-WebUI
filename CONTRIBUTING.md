# Contributing

SongForge is a local web interface for the [YuE2](https://huggingface.co/m-a-p/YuE2-3B)
music model. It was built for one person's RTX 3060 and then made to work on
other people's machines, so if something still assumes a 12 GB NVIDIA card on
Windows, that is a bug worth reporting.

## Getting a working checkout

```
git clone <your fork>
cd SongForge
./setup.sh        # or .\setup.ps1 on Windows
```

Setup detects your GPU, lists what is needed with sizes, and installs only
what you tick. See [README.md](README.md).

To work on the code without the 15 GB of weights, install just the first two
components and leave the runner on its mock:

```
./setup.sh --only=backend,frontend
```

The mock runner produces real files and real timings, and every end-to-end
test uses it. Most of the application can be developed and tested without ever
loading the model.

## Running the checks

What CI runs, in the order worth running them:

```
cd app/backend && python -m pytest -q
cd app/frontend && npx tsc --noEmit && npx eslint src && npx next build && node scripts/smoke.mjs
```

`scripts/smoke.mjs` serves a stubbed API and requests every route, which
catches a page that compiles and then throws on render.

Four tests report `skipped` without FFmpeg on `PATH`. The mock runner writes
WAV through the standard library, and the FLAC master is transcoded from it,
so downloading FLAC needs a binary the suite does not install. `pytest -rs`
prints the reason. CI installs FFmpeg on the Ubuntu runner only, which is
enough to cover a transcode that is not platform-specific.

## What a good change looks like

- **Match the surrounding code.** The backend is typed, uses SQLModel, and
  keeps comments for the things that are not obvious from the code. The
  frontend is plain React with a hand-written fetch client and no UI library;
  please do not add one.
- **Explain the why, not the what.** The comments in this codebase exist to
  record a decision or a trap - a SQLite quirk, a measured number, a kernel
  that silently falls back. A comment that restates the line below it is noise.
- **Numbers need a source.** Several constants here are measured rather than
  chosen (25 semantic tokens per second of audio, the wall-clock ratio, the
  lyric-length fit). If you change one, say what you measured it on.
- **A new assumption about hardware is a bug.** Anything that depends on the
  card belongs in `songforge/setup/hardware.py` and the hardware profile, not
  in a constant or a sentence of UI copy.
- **Tests**: a fix gets a test that fails before it. There is no coverage
  target; there is an expectation that the test would have caught the bug.

## Platforms

`main` targets Windows and Linux and carries both sets of launch scripts:
`scripts/*.ps1` and the `scripts/*.sh` equivalents. Hardware detection on
`main` already has an Apple branch, and YuE2 selects Metal by itself, so
`main` is not CUDA-only.

The `macos` branch is the small remainder that only makes sense on a Mac:
the Metal-specific warnings, FFmpeg through Homebrew, finding Ollama in an
app bundle, and a macOS-first README. Its `docs/macos.md` lists the files it
is allowed to differ in.

Fix shared code on `main`. The macOS branch merges from it, and a merge
conflict outside those few files means something platform-specific has leaked
into shared code.

## Reporting a problem

Useful reports include the output of:

```
python app/backend/songforge/setup/__main__.py --detect
```

which prints your GPU, the PyTorch build chosen for it and the settings
derived from it, and the run log from **Logs** on the song page, which has the
exact command, the per-stage timings and the runner's own output.

## Licensing

Contributions are MIT, like the rest of the code. The model weights are not
ours and are not MIT - see [NOTICE.md](NOTICE.md) before doing anything
commercial with the output, and never commit weights, audio or anything from
`runtime/` to the repository.
