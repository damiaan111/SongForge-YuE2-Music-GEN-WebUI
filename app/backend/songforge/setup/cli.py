"""Entry point for ``python -m songforge.setup``.

Interactive by default; ``--yes`` and ``--only`` exist so the same code can run
in CI and in a scripted install, where there is no one to press a key.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import menu
from .components import (
    Context,
    SetupError,
    _ollama_executable,
    format_size,
    lyrics_model_name,
    ollama_installer,
    ollama_manual_instructions,
)
from .hardware import NEWEST_PYTHON, REQUIRED_PYTHON


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="setup",
        description="Detect this machine and install what SongForge needs.",
    )
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Install the required components without asking.")
    parser.add_argument("--with-lyrics", action="store_true",
                        help="With --yes: also install the optional lyrics writer "
                             "(needs Ollama to be installed already).")
    parser.add_argument("--no-lyrics", action="store_true",
                        help="Skip the lyrics writer without being asked about it.")
    parser.add_argument("--only", metavar="KEYS",
                        help="Comma-separated component keys to install, e.g. backend,frontend.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show what would be run without running it.")
    parser.add_argument("--detect", action="store_true",
                        help="Print the detected hardware as JSON and exit.")
    parser.add_argument("--root", type=Path, default=None,
                        help="Project root. Defaults to the checkout this file lives in.")
    return parser


def _detect_only(ctx: Context) -> int:
    import json

    from .hardware import settings_profile, warnings_for

    print(json.dumps({
        "system": ctx.machine.system,
        "machine": ctx.machine.machine,
        "python": ".".join(str(p) for p in ctx.machine.python),
        "gpu": {
            "vendor": ctx.gpu.vendor, "name": ctx.gpu.name,
            "memory_gib": ctx.gpu.memory_gib, "compute": ctx.gpu.compute,
            "driver": ctx.gpu.driver, "index": ctx.gpu.index,
        },
        "torch": {"label": ctx.torch.label, "index_url": ctx.torch.index_url,
                  "supported": ctx.torch.supported, "problem": ctx.torch.problem},
        "settings": settings_profile(ctx.gpu),
        "warnings": warnings_for(ctx.gpu, ctx.machine),
    }, indent=2))
    return 0


def _apply_only(rows: list[menu.Row], keys: str) -> list[str]:
    """Tick exactly the named components; returns any names that do not exist."""
    wanted = {key.strip() for key in keys.split(",") if key.strip()}
    known = {row.component.key for row in rows}
    for row in rows:
        row.chosen = row.component.key in wanted and row.actionable
    return sorted(wanted - known)


def _ask(prompt: str) -> str | None:
    """One line from the user, or None if there is nobody to answer."""
    try:
        return input(prompt).strip().lower()
    except EOFError:
        return None


def _offer_lyrics(ctx: Context, rows: list[menu.Row]) -> None:
    """Ask, in plain words, whether the optional lyrics writer is wanted.

    It is the one choice in setup that is a matter of taste rather than of
    what the machine needs, and it is a multi-gigabyte download, so it gets a
    question of its own instead of an unticked box in a list that most people
    confirm without reading. The answer only sets the box; the menu that
    follows still shows it and can still change it.
    """
    row = next((r for r in rows if r.component.key == "lyrics"), None)
    if row is None or not row.actionable:
        return
    size = format_size(row.component.size_bytes)
    print(
        "\nOptional: a lyrics writer\n"
        f"{menu.RULE}\n"
        "SongForge can write lyrics for you, using a language model that runs on\n"
        f"this computer ({lyrics_model_name(ctx)} through Ollama, about {size} to download).\n"
        "It is entirely optional: you can always type or paste your own lyrics,\n"
        "and you can add it later by running setup again.\n"
    )
    answer = _ask("Install the lyrics writer? [y/N] ")
    if answer not in ("y", "yes"):
        print("  Skipped. SongForge will work without it.")
        return

    if _ollama_executable(ctx) is None:
        command = ollama_installer(ctx)
        if command is None:
            print("\n  The lyrics writer needs Ollama, which is not installed.")
            print(f"  {ollama_manual_instructions(ctx)}")
            print("  Continuing without the lyrics writer for now.")
            return
        print("\n  The lyrics writer needs Ollama, a free app that runs language models")
        print("  locally. It is not installed on this computer.")
        consent = _ask(f"  Install Ollama now with {command[0]}? [y/N] ")
        if consent not in ("y", "yes"):
            print(f"  Skipped. {ollama_manual_instructions(ctx)}")
            return
        try:
            ctx.run(command)
        except SetupError as exc:
            print(f"  Ollama could not be installed: {exc}")
            print(f"  {ollama_manual_instructions(ctx)}")
            return
        if _ollama_executable(ctx) is None and not ctx.dry_run:
            print("  Ollama was installed but cannot be found yet. Close this window,")
            print("  open a new one and run setup again to add the lyrics writer.")
            return
    row.chosen = True


def _interactive(ctx: Context, rows: list[menu.Row]) -> bool:
    """Returns True if the user asked to install, False if they quit."""
    while True:
        print(menu.render(ctx, rows))
        answer = _ask("> ")
        if answer is None:
            # Piped input that ran out: treat as quit rather than as consent.
            return False
        if answer in ("q", "quit", "exit"):
            return False
        if answer == "":
            return True
        if answer == "a":
            for row in rows:
                row.chosen = row.actionable
            continue
        if answer == "n":
            for row in rows:
                row.chosen = False
            continue
        if answer.isdigit():
            index = int(answer) - 1
            if 0 <= index < len(rows) and rows[index].actionable:
                rows[index].chosen = not rows[index].chosen
            continue
        print("  Type a number to toggle, a, n, Enter to install, or q to quit.")


def _wrong_python() -> str:
    """Why this interpreter cannot build the environments, or "" if it can."""
    found = ".".join(str(part) for part in sys.version_info[:3])
    wanted = ".".join(str(part) for part in REQUIRED_PYTHON)
    newest = ".".join(str(part) for part in NEWEST_PYTHON)
    if sys.version_info[:2] < REQUIRED_PYTHON:
        reason = f"This is Python {found}; SongForge needs {wanted} or {newest}."
    elif sys.version_info[:2] > NEWEST_PYTHON:
        reason = (f"This is Python {found}, which is newer than SongForge supports "
                  f"({wanted} or {newest}).\nYuE2's dependencies are not published for it "
                  "yet, so the install would fail\nwhile compiling them.")
    else:
        return ""
    # _create_venv builds from sys.executable, so the wrong interpreter here
    # produces a venv nothing can be installed into. Left to run, it fails
    # minutes later inside pip, which reads like a packaging fault rather than
    # a wrong interpreter. The menu's warning does not help: --yes and --only
    # never show the menu.
    return (
        f"\n{reason}\n"
        "\nThe virtual environments are built from whatever interpreter runs setup,"
        "\nso continuing would build ones that cannot be used.\n"
        f"\n  Install Python {wanted} from https://www.python.org/downloads/ (it can sit"
        "\n  beside the one you have), then run the launcher, which finds it for you:"
        "\n    setup.bat           (Windows)"
        "\n    ./setup.sh          (macOS and Linux)\n"
        "\n--detect still works on this interpreter.\n"
    )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ctx = Context.discover(root=args.root, dry_run=args.dry_run)

    if args.detect:
        # Deliberately allowed on any interpreter: --detect is what a bug
        # report asks for, and someone on 3.11 still needs to be able to run
        # it. The version shows up in its output and in the warnings.
        return _detect_only(ctx)

    problem = _wrong_python()
    if problem and not args.dry_run:
        print(problem, file=sys.stderr)
        return 2

    rows = menu.build_rows(ctx)

    if args.only:
        unknown = _apply_only(rows, args.only)
        if unknown:
            known = ", ".join(row.component.key for row in rows)
            print(f"Unknown component(s): {', '.join(unknown)}. Choose from: {known}.",
                  file=sys.stderr)
            return 2
    elif args.yes:
        for row in rows:
            wanted = row.component.required or (
                args.with_lyrics and row.component.key == "lyrics")
            row.chosen = wanted and row.actionable
    elif not sys.stdin.isatty():
        print("Setup needs a terminal to ask its questions. For an unattended install use\n"
              "  --yes                 the required components\n"
              "  --yes --with-lyrics   ... plus the optional lyrics writer\n"
              "  --only=<keys>         exactly the components you name", file=sys.stderr)
        return 2
    else:
        if not args.no_lyrics:
            _offer_lyrics(ctx, rows)
        if not _interactive(ctx, rows):
            print("Nothing was installed.")
            return 0

    added = menu.resolve_dependencies(rows)
    for title in added:
        print(f"  + {title} was added because something you chose needs it.")

    notice = menu.licence_notice(rows)
    if notice:
        print(notice)
        if not (args.yes or args.only or args.dry_run):
            if _ask("Type 'agree' to accept and continue: ") != "agree":
                print("Nothing was downloaded.")
                return 0

    results = menu.install(ctx, rows)
    print(menu.summarise(ctx, results))
    return 1 if any(outcome.startswith("failed") for _, outcome in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
