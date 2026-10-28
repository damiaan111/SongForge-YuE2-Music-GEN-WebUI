# SongForge on Apple Silicon

This is the `macos` branch. It is `main` plus the handful of differences below.
Everything else — the application, the setup menu, the tests — is shared, and
fixes to shared code belong on `main`.

## What works, and how well

YuE2 chooses Metal by itself. `pipeline.py` resolves its device as
`cuda → mps → cpu`, and there are explicit MPS branches in its attention
(`modeling_yue2.py`, `nar.py`, which expand grouped-query attention because
Metal's `enable_gqa` does not) and in its sampling loop (`torch.mps.synchronize`).
None of that is something SongForge adds; it is upstream.

Two things are slower or absent, and both are worth knowing before you blame
your own configuration:

- **The VAE decoder runs on the CPU.** `modeling_vae.py` picks `cuda` if it is
  available and `cpu` otherwise. There is no Metal branch, so the final decode
  from tokens to audio does not use the GPU at all. Generation does.
- **fp8 does not exist here.** `quantization.py` returns early unless the device
  is CUDA. Setup leaves `quantization` at `none`, which is correct.

The model always loads in bfloat16 (`torch_dtype=torch.bfloat16`). Metal
bfloat16 needs **macOS 14 or newer**; on macOS 13 the load fails rather than
falling back.

## Memory

Apple Silicon has no separate VRAM, so setup takes **60% of system RAM** as the
budget instead of the "card minus headroom" it uses on a discrete GPU. The rest
is not spare: macOS, the browser and the frontend all draw from the same pool.

| Machine | Expect |
| --- | --- |
| 32 GB or more | Comfortable. This is the configuration to want. |
| 16–24 GB | Works. Keep songs short and close other applications. |
| 8 GB | Setup warns. Long songs will not fit. |

Upstream YuE2 asks for 24 GB of VRAM. A 24 GB Mac is not the same thing as a
24 GB graphics card — it is less, because it is shared.

## Installing

```bash
./setup.sh
```

Setup detects the chip with `sysctl`, installs the ordinary PyPI PyTorch wheel
(Metal support is in it; there is no separate index for Metal, unlike CUDA and
ROCm), and offers the same checkbox menu as everywhere else.

Prerequisites it does not install:

| Need | Get it with |
| --- | --- |
| Python 3.12+ | `brew install python@3.12` |
| Node.js 20+ | `brew install node` |
| FFmpeg (optional) | setup will run `brew install ffmpeg` if you tick it |

FFmpeg is the one component setup installs through a package manager, because
Homebrew needs neither elevation nor a reopened shell.

## Starting it

```bash
./scripts/start-songforge.sh
./scripts/stop-songforge.sh
```

Same ports, same PID file, same refusal to start twice as the PowerShell
scripts on `main`. There are no equivalents of
`Create-DesktopShortcut.ps1` or `Install-StartupTask.ps1`; use a login item or
a `launchd` plist if you want SongForge to start automatically.

## The lyrics writer

Optional, as everywhere. Either install works:

```bash
brew install ollama        # CLI on PATH
```

or the `.dmg` from [ollama.com](https://ollama.com), which installs an
application bundle. The start script checks `PATH` first and then
`/Applications/Ollama.app/Contents/Resources/ollama`, because the `.dmg` only
adds the CLI if you let it.

## Keeping this branch current

```bash
git switch macos
git merge main
```

The differences are deliberately small and confined to these files. Check the
list against reality with `git diff --name-only main macos`; if it has drifted,
the list is the thing to fix.

- `setup/hardware.py` — the Metal warnings
- `setup/components.py` — FFmpeg through Homebrew
- `scripts/start-songforge.sh` — finding Ollama in an app bundle
- `tests/test_setup.py` — the test for those warnings
- `.github/workflows/ci.yml` — the macOS runners and the detection job
- `README.md` and this file

A conflict anywhere else means something Apple-specific has leaked into shared
code, which is a bug on this branch rather than on `main`.
