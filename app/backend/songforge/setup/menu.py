"""The first-run menu: what is needed, what is already here, install or not.

Deliberately a plain text list rather than a wizard. It has to work over SSH,
in a bare Windows console, and before anything at all is installed, and a list
of checkboxes is the one interface that survives all three.

Nothing downloads without an explicit keypress, required items can be cleared
like any other, and re-running shows what is already present instead of doing
it again.
"""
from __future__ import annotations

from dataclasses import dataclass

from .components import (
    WEIGHT_LICENCE,
    WEIGHT_LICENCE_URL,
    Component,
    Context,
    SetupError,
    catalogue,
    format_size,
    free_space_bytes,
    write_profile,
)
from .hardware import warnings_for

RULE = "-" * 72


@dataclass
class Row:
    component: Component
    chosen: bool
    present: bool
    blocked: str

    @property
    def actionable(self) -> bool:
        return not self.present and not self.blocked


def build_rows(ctx: Context) -> list[Row]:
    rows = []
    for component in catalogue(ctx):
        present = component.present(ctx)
        blocked = component.blocked_because(ctx)
        rows.append(Row(
            component=component,
            # Required items start ticked; optional ones do not. Installed
            # items are never re-ticked, so Enter is always safe to press.
            chosen=component.required and not present and not blocked,
            present=present,
            blocked=blocked,
        ))
    return rows


def _status(row: Row) -> str:
    """Four characters, so the numbers line up whatever the state."""
    if row.present:
        return "done"
    if row.blocked:
        return "n/a"
    return "[x]" if row.chosen else "[ ]"


def render(ctx: Context, rows: list[Row]) -> str:
    out = ["", "SongForge setup", RULE,
           f"Detected: {ctx.gpu.describe()} - {ctx.machine.system}",
           f"PyTorch:  {ctx.torch.label}", ""]

    for index, row in enumerate(rows, start=1):
        component = row.component
        tag = "required" if component.required else "optional"
        out.append(
            f"  {_status(row):<4} {index}  {component.title:<42} "
            f"{format_size(component.size_bytes):>8}  {tag}"
            + (f"  {component.licence}" if component.licence else "")
        )
        out.append(f"          {component.detail}")
        for note in component.notes:
            out.append(f"          {note}")
        if row.blocked:
            out.append(f"          cannot install: {row.blocked}")
        out.append("")

    wanted = sum(r.component.size_bytes for r in rows if r.chosen and r.actionable)
    free = free_space_bytes(ctx.runtime)
    out.append(f"To download: {format_size(wanted)}   Free on this drive: {format_size(free)}")
    if wanted and free and wanted > free:
        out.append("  !! That does not fit. Clear some items or free up space.")

    for warning in warnings_for(ctx.gpu, ctx.machine):
        out.append(f"  ! {warning}")

    out += ["", RULE,
            "[1-9] toggle   [a] all   [n] none   [Enter] install   [q] quit", ""]
    return "\n".join(out)


def licence_notice(rows: list[Row]) -> str:
    """Shown before any weight download, because the weights are not free.

    The model is CC BY-NC 4.0. SongForge's own code is MIT, and conflating the
    two would mislead someone into a commercial release they are not licensed
    to make.
    """
    weights = [r.component for r in rows if r.chosen and r.actionable and r.component.licence]
    if not weights:
        return ""
    names = ", ".join(c.title for c in weights)
    return (
        f"\n{RULE}\n"
        f"The YuE2 weights ({names}) are licensed {WEIGHT_LICENCE}:\n"
        f"  {WEIGHT_LICENCE_URL}\n"
        "That is NON-COMMERCIAL. SongForge's own code is MIT, which does not\n"
        "extend to the model or to what you make with it. Attribution goes to\n"
        "m-a-p/YuE2-3B and m-a-p/YuE2-Vae.\n"
        f"{RULE}\n"
    )


def resolve_dependencies(rows: list[Row]) -> list[str]:
    """Tick whatever the chosen items need, and report what was added.

    Silently installing an extra component would be worse than asking, but so
    would failing six minutes in because the weights were ticked and the thing
    that downloads them was not.
    """
    by_key = {row.component.key: row for row in rows}
    added: list[str] = []
    changed = True
    while changed:
        changed = False
        for row in rows:
            if not (row.chosen and row.actionable):
                continue
            for need in row.component.needs:
                dependency = by_key.get(need)
                if dependency and dependency.actionable and not dependency.chosen:
                    dependency.chosen = True
                    added.append(dependency.component.title)
                    changed = True
    return added


def install(ctx: Context, rows: list[Row]) -> list[tuple[str, str]]:
    """Install every chosen component in catalogue order.

    A failure stops the run: later components generally depend on earlier ones,
    and continuing would turn one clear error into a cascade of confusing ones.
    """
    results: list[tuple[str, str]] = []
    for row in rows:
        if not (row.chosen and row.actionable):
            continue
        ctx.log(f"\n>> {row.component.title}")
        try:
            row.component.install(ctx)
        except SetupError as exc:
            results.append((row.component.title, f"failed: {exc}"))
            if row.component.required:
                ctx.log(f"   {exc}")
                break
            ctx.log(f"   skipped: {exc}")
            continue
        results.append((row.component.title, "installed"))
    return results


def summarise(ctx: Context, results: list[tuple[str, str]]) -> str:
    """Report what happened, and record the hardware unless something failed.

    The profile is written even when there was nothing to install: someone who
    re-runs setup after swapping a graphics card has nothing to install and
    every reason to expect the new card to be picked up.
    """
    out = ["", RULE]
    out.append("Setup finished." if results
               else "Everything you ticked is already installed.")
    out.append("")
    for title, outcome in results:
        out.append(f"  {outcome:<12} {title}")
    failures = [r for r in results if r[1].startswith("failed")]
    if results:
        out.append("")
    if failures:
        out.append("Some required steps did not complete. Fix the cause above and run")
        out.append("setup again; it picks up where it left off.")
    else:
        profile = write_profile(ctx)
        out.append(f"Hardware profile written to {profile}.")
        out.append("")
        out.append("Start SongForge with:")
        out.append("  .\\scripts\\Start-SongForge.ps1" if ctx.machine.is_windows
                   else "  ./scripts/start-songforge.sh")
    out.append("")
    return "\n".join(out)
