#!/usr/bin/env bash
# First-run setup for SongForge on macOS and Linux.
#
# Finds a Python 3.12 or 3.13, then hands over to the setup menu, which detects
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
#   ./setup.sh --yes --with-lyrics   ... and the optional lyrics writer
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
# 3.12 leads because that is what the project is built and tested on. Nothing
# newer than 3.13 is accepted: YuE2's dependencies are pinned to exact versions,
# and on an interpreter they have no wheels for pip tries to compile them and
# fails twenty minutes into the install.
find_python() {
    local candidate
    for candidate in python3.12 python3.13 python3 python; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        if "$candidate" -c 'import sys; raise SystemExit(0 if (3, 12) <= sys.version_info[:2] <= (3, 13) else 1)' 2>/dev/null; then
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
    echo "  Python 3.12 was not found (3.13 also works; older and newer do not)." >&2
    echo >&2
    case "$(uname -s)" in
        Darwin) echo "  Install it with:  brew install python@3.12" >&2 ;;
        *)      echo "  Install it with your package manager, e.g. apt install python3.12 python3.12-venv" >&2 ;;
    esac
    echo "  Or from https://www.python.org/downloads/. It can sit beside the Python you have." >&2
    echo >&2
    exit 1
fi

echo "  Using $("$python_exe" --version 2>&1)."
echo

exec "$python_exe" "$entry" "$@"
