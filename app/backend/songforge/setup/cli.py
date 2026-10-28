"""Entry point for ``python -m songforge.setup``.

Interactive by default; ``--yes`` and ``--only`` exist so the same code can run
in CI and in a scripted install, where there is no one to press a key.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import menu
from .components import Context


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="songforge-setup",
        description="Detect this machine and install what SongForge needs.",
    )
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Install the required components without asking.")
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
            "driver": ctx.gpu.driver,
        },
        "torch": {"label": ctx.torch.label, "index_url": ctx.torch.index_url,
                  "supported": ctx.torch.supported, "problem": ctx.torch.problem},
        "settings": settings_profile(ctx.gpu),
        "warnings": warnings_for(ctx.gpu, ctx.machine),
    }, indent=2))
    return 0


def _apply_only(rows: list[menu.Row], keys: str) -> None:
    wanted = {key.strip() for key in keys.split(",") if key.strip()}
    for row in rows:
        row.chosen = row.component.key in wanted and row.actionable


def _interactive(ctx: Context, rows: list[menu.Row]) -> bool:
    """Returns True if the user asked to install, False if they quit."""
    while True:
        print(menu.render(ctx, rows))
        try:
            answer = input("> ").strip().lower()
        except EOFError:
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


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    ctx = Context.discover(root=args.root, dry_run=args.dry_run)

    if args.detect:
        return _detect_only(ctx)

    rows = menu.build_rows(ctx)

    if args.only:
        _apply_only(rows, args.only)
    elif args.yes:
        for row in rows:
            row.chosen = row.component.required and row.actionable
    elif not sys.stdin.isatty():
        print("Setup needs a terminal. Use --yes for the required components, "
              "or --only=<keys>.", file=sys.stderr)
        return 2
    else:
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
            if input("Type 'agree' to accept and continue: ").strip().lower() != "agree":
                print("Nothing was downloaded.")
                return 0

    results = menu.install(ctx, rows)
    print(menu.summarise(ctx, results))
    return 1 if any(outcome.startswith("failed") for _, outcome in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
