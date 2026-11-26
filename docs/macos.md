# SongForge on Apple Silicon

**Status: experimental.** Setup detects the chip and installs the right
PyTorch, the app starts, and the automated checks run on an Apple Silicon
machine on every change. What has *not* been done is a real render on a Mac by
the maintainers. If you try it, a report - good or bad - is very welcome.

Everything is shared with Windows and Linux; there is no separate branch. The
few places that differ are conditions on the detected platform.

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
budget instead of the whole card it uses on a discrete GPU. The rest is not
spare: macOS, the browser and the web app all draw from the same pool.

| Machine | Expect |
| --- | --- |
| 32 GB or more | Comfortable. This is the configuration to want. |
| 16–24 GB | Should work. Keep songs short and close other applications. |
| 8 GB | Setup warns. Long songs will not fit. |

Upstream YuE2 asks for 24 GB of VRAM. A 24 GB Mac is not the same thing as a
24 GB graphics card — it is less, because it is shared.

## Installing

```bash
./setup.sh
```

Setup detects the chip with `sysctl`, installs the ordinary PyPI PyTorch wheel
(Metal support is in it; there is no separate index for Metal, unlike CUDA and
ROCm), and offers the same menu as everywhere else.

Prerequisites it does not install:

| Need | Get it with |
| --- | --- |
| Python 3.12 | `brew install python@3.12` |
| Node.js 20+ | `brew install node` |
| FFmpeg (optional) | setup runs `brew install ffmpeg` if you tick it |
| Ollama (optional, for the lyrics writer) | setup offers `brew install ollama` when you say yes to the lyrics question |

## Starting it

```bash
./start.sh
```

A terminal stays open while SongForge runs and shows the address to open;
closing it, or Ctrl+C, stops everything. `./start.sh --lan` also makes it
reachable from other devices on your network.

There is deliberately no login item or `launchd` service: SongForge runs when
you start it and stops when you close it.

## The lyrics writer

Optional, as everywhere. Either install works:

```bash
brew install ollama        # CLI on PATH
```

or the `.dmg` from [ollama.com](https://ollama.com), which installs an
application bundle. Setup and the start script check `PATH` first and then
`/Applications/Ollama.app/Contents/Resources/ollama`, because the `.dmg` only
adds the CLI if you let it.
