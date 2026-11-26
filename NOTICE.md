# Licences: two different ones, and the difference matters

SongForge is a user interface. The thing that actually writes and performs the
music is **YuE2**, which is somebody else's model under somebody else's
licence. Nothing in this repository changes that, and nothing in this
repository grants you rights to it.

## This repository's code — MIT

Everything in `app/`, `scripts/`, `setup.ps1` and `setup.sh` is MIT licensed.
Fork it, change it, ship it, sell it. See [LICENSE](LICENSE).

SongForge does not contain, redistribute or mirror any model weights. The
setup script downloads them from Hugging Face, from the official repositories,
at your request.

## The YuE2 weights — CC BY-NC 4.0 (non-commercial)

The model and VAE checkpoints are licensed
[Creative Commons Attribution-NonCommercial 4.0 International](https://creativecommons.org/licenses/by-nc/4.0/):

| Component | Source |
|---|---|
| YuE2-3B | <https://huggingface.co/m-a-p/YuE2-3B> |
| YuE2-Vae | <https://huggingface.co/m-a-p/YuE2-Vae> |
| YuE2-Vae-legacy | <https://huggingface.co/m-a-p/YuE2-Vae-legacy> |

**NonCommercial** means you may not use the weights, or distribute them,
primarily for commercial advantage or monetary compensation. Attribution means
naming YuE2, the model name and its source repository.

The `yue2_infer` inference package, which SongForge downloads from the YuE2-3B
repository, carries its own licence and third-party notices; they are installed
alongside it in the environment and are preserved in `THIRD_PARTY_NOTICES.md`
inside that package.

## What this means for songs you make

The weight licence is the restrictive one, and it is not SongForge's to
loosen. If you intend to release, sell, stream, monetise or otherwise use the
output commercially, read the CC BY-NC terms and the YuE2 model card first,
and take your own advice. The MIT licence on this interface does not help you
there.

Setup shows this before it downloads anything, and asks you to acknowledge it.
That is not a formality.

## Other dependencies

PyTorch, FastAPI, Next.js and the rest carry their own licences, which are
recorded in the environments the setup script creates (`runtime/venv`,
`runtime/venv-yue2`, `app/frontend/node_modules`). None of them are vendored
here.
