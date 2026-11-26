"""Filesystem safety helpers.

Every path that is influenced by user input must pass through :func:`safe_join`.
Nothing in this module ever accepts raw user text as a path segment.
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

__all__ = ["PathTraversalError", "safe_join", "slugify", "safe_filename", "is_within"]

# Windows reserved device names; unusable as a file stem even with an extension.
_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
# Control characters plus every character Windows forbids in a filename.
# The set is escaped programmatically: writing the class by hand invites the
# backslash to be read as escaping the next character, which silently lets
# "a\b.txt" through.
_UNSAFE_CHARS = re.compile("[" + re.escape('\\/:*?"<>|') + r"\x00-\x1f]")


class PathTraversalError(ValueError):
    """Raised when a resolved path escapes its designated base directory."""


def is_within(base: Path, candidate: Path) -> bool:
    """True if ``candidate`` resolves to ``base`` itself or something beneath it."""
    try:
        base_r = base.resolve(strict=False)
        cand_r = candidate.resolve(strict=False)
    except (OSError, RuntimeError):
        return False
    return cand_r == base_r or base_r in cand_r.parents


def safe_join(base: Path, *parts: str) -> Path:
    """Join ``parts`` onto ``base``, guaranteeing the result stays inside ``base``.

    Rejects absolute segments, drive letters, UNC prefixes and ``..`` traversal.
    Raises :class:`PathTraversalError` rather than returning a path outside base.
    """
    base_r = base.resolve(strict=False)
    candidate = base_r
    for raw in parts:
        if raw is None:
            raise PathTraversalError("path segment must not be None")
        segment = str(raw)
        # Windows collapses trailing dots and spaces, so "...", " .." and ".. "
        # all normalise away and would silently resolve to the base directory -
        # handing the caller the parent while it believes it holds a child.
        if not segment or not segment.strip(". "):
            raise PathTraversalError(f"invalid path segment: {segment!r}")
        if segment != segment.strip(" ") or segment.endswith("."):
            raise PathTraversalError(
                f"segment must not begin or end with a space or dot: {segment!r}"
            )
        # Reject anything that could re-root the path.
        if segment.startswith(("/", "\\")) or ":" in segment:
            raise PathTraversalError(f"absolute or drive-qualified segment: {segment!r}")
        if "/" in segment or "\\" in segment:
            raise PathTraversalError(f"segment must not contain separators: {segment!r}")
        if "\x00" in segment:
            raise PathTraversalError("segment must not contain NUL")
        candidate = candidate / segment

    resolved = candidate.resolve(strict=False)
    if not is_within(base_r, resolved):
        raise PathTraversalError(f"path escapes base directory: {resolved}")
    return resolved


def slugify(text: str, *, fallback: str = "untitled", max_length: int = 60) -> str:
    """Produce a lowercase ASCII slug suitable for *display* folder names only.

    Never use the result as the sole identity of a project - IDs are UUIDs.
    """
    normalized = unicodedata.normalize("NFKD", text or "")
    ascii_only = normalized.encode("ascii", "ignore").decode("ascii").lower()
    slug = _SLUG_STRIP.sub("-", ascii_only).strip("-")
    slug = slug[:max_length].strip("-")
    if not slug or slug.upper() in _RESERVED:
        return fallback
    return slug


def safe_filename(name: str, *, fallback: str = "file") -> str:
    """Sanitise a single filename: strip separators, control and reserved forms."""
    cleaned = _UNSAFE_CHARS.sub("_", (name or "").strip())
    cleaned = cleaned.strip(" .")  # Windows discards trailing dots/spaces
    if not cleaned:
        return fallback
    if Path(cleaned).stem.upper() in _RESERVED:
        cleaned = f"_{cleaned}"
    return cleaned[:200]
