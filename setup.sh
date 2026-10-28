#!/usr/bin/env bash
# First-run setup for SongForge on macOS and Linux.
#
# Finds a Python 3.12 or newer, then hands over to the setup menu, which detects
# this machine's GPU and offers to install what is needed. Nothing is downloaded
# until you agree to it in that menu.
#
# This script deliberately does almost nothing itself: every decision lives in
# app/backend/songforge/setup/, which is plain Python with no dependencies and is
# covered by the test suite.
#
#   ./setup.sh              interactive menu
#   ./setup.sh --detect     print the detected hardware and exit
#   ./setup.sh --yes        install the required components without asking
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
entry="$root/app/backend/songforge/setup/__main__.py"

if [ ! -f "$entry" ]; then
    echo "Cannot find $entry." >&2
    echo "Run this script from inside the SongForge checkout." >&2
    exit 1
fi

# Exact versions first: "python3" is frequently an older interpreter that the
# system depends on, and newer ones are installed beside it rather than over it.
# 3.12 leads because that is what the project is built and tested on; a newer
# interpreter is accepted but is not the one to reach for by default, since a
# dependency without a wheel for it turns into a compiler error.
find_python() {
    local candidate
    for candidate in python3.12 python3.13 python3.14 python3 python; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        if "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 12) else 1)' 2>/dev/null; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

echo
echo "SongForge setup"
echo "---------------"

if ! python_exe="$(find_python)"; then
    echo "  No Python 3.12 or newer was found." >&2
    echo >&2
    case "$(uname -s)" in
        Darwin) echo "  Install it with:  brew install python@3.12" >&2 ;;
        *)      echo "  Install it with your package manager, e.g. apt install python3.12" >&2 ;;
    esac
    echo "  Or from https://www.python.org/downloads/" >&2
    echo >&2
    exit 1
fi

echo "  Using $("$python_exe" --version 2>&1)."
echo

exec "$python_exe" "$entry" "$@"
