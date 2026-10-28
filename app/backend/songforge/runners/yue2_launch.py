"""Launch the yue2 CLI with memory-efficient attention for long songs.

Runs under the yue2 environment's own Python, not SongForge's, so it imports
nothing from SongForge. It changes one thing and then hands every argument to
the unmodified ``yue2.cli.main``.

Why this exists
---------------
YuE2-3B uses grouped-query attention (16 query heads over 8 key/value heads)
and passes ``enable_gqa=True`` to PyTorch's scaled_dot_product_attention. On
Windows PyTorch ships without FlashAttention, and the memory-efficient kernel
refuses grouped inputs, so every call falls back to the math kernel, which
materialises the full attention matrix. That is quadratic in context length:
measured on an RTX 3060, one causal call over 6,000 tokens needed 5.20 GiB
extra, which is why songs past about two minutes ran out of memory during
synthesis no matter the budget.

Expanding the key/value heads to match the query heads first lets PyTorch pick
the memory-efficient kernel: the same 6,000-token call needs 0.02 GiB, and
20,000 tokens 0.08 GiB. The results differ from the math kernel only by bf16
rounding (max |difference| 0.008 in the probe).

Only calls with a long query are rewritten. Token-by-token decoding (a query of
length 1) already costs almost nothing, and expanding its whole key/value cache
on every step would only slow generation down.
"""
from __future__ import annotations

import os
import sys

# Below this many query positions the math kernel is already cheap.
MIN_QUERY_LENGTH = 64


def install_memory_efficient_attention() -> None:
    import torch
    import torch.nn.functional as F

    original = F.scaled_dot_product_attention

    def scaled_dot_product_attention(
        query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False,
        scale=None, enable_gqa=False,
    ):
        if (
            enable_gqa
            and query.is_cuda
            and query.dim() == 4
            and query.shape[-2] >= MIN_QUERY_LENGTH
            and key.shape[-3] != query.shape[-3]
            and query.shape[-3] % key.shape[-3] == 0
        ):
            groups = query.shape[-3] // key.shape[-3]
            key = key.repeat_interleave(groups, dim=-3)
            value = value.repeat_interleave(groups, dim=-3)
            enable_gqa = False
        return original(
            query, key, value, attn_mask=attn_mask, dropout_p=dropout_p,
            is_causal=is_causal, scale=scale, enable_gqa=enable_gqa,
        )

    # yue2 calls F.scaled_dot_product_attention through the module attribute
    # (modeling_yue2.sdpa, nar.attention), so replacing it here reaches both.
    F.scaled_dot_product_attention = scaled_dot_product_attention
    torch.nn.functional.scaled_dot_product_attention = scaled_dot_product_attention


def _drop_own_directory_from_path() -> None:
    """Run as a script, this file's folder is sys.path[0] - and that folder
    holds SongForge's own runners/yue2.py, which would shadow the real yue2
    package on ``import yue2``."""
    here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
    sys.path[:] = [
        entry for entry in sys.path
        if os.path.normcase(os.path.abspath(entry or os.getcwd())) != here
    ]


def main(argv: list[str]) -> int:
    _drop_own_directory_from_path()
    install_memory_efficient_attention()
    # Logged so every run's generation.log says which attention path it used.
    print("[SongForge] attention: memory-efficient (grouped heads expanded)", file=sys.stderr, flush=True)
    from yue2.cli import main as yue2_main

    return int(yue2_main(argv) or 0)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
