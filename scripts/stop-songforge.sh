#!/usr/bin/env bash
# Stop SongForge. The POSIX counterpart of Stop-SongForge.ps1.
#
# A generation in progress is interrupted; its partial output and log stay on
# disk, and the backend marks the job interrupted the next time it starts.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="$root/runtime"
pid_file="$runtime/songforge.pids.json"

step() { printf '  %s\n' "$1"; }

is_running() { kill -0 "$1" 2>/dev/null; }

stop_tree() {
    # npm spawns a node child, so the whole process group has to go; killing
    # the launcher alone leaves the server holding the port.
    local pid="$1" name="$2"
    if [ -z "$pid" ] || [ "$pid" = "0" ] || ! is_running "$pid"; then
        return 1
    fi
    local children
    children="$(pgrep -P "$pid" 2>/dev/null || true)"

    kill -TERM "$pid" 2>/dev/null || true
    for child in $children; do kill -TERM "$child" 2>/dev/null || true; done

    # Give it a moment to close its files before insisting.
    local waited=0
    while [ "$waited" -lt 10 ] && is_running "$pid"; do
        sleep 0.5
        waited=$((waited + 1))
    done
    if is_running "$pid"; then
        kill -KILL "$pid" 2>/dev/null || true
        for child in $children; do kill -KILL "$child" 2>/dev/null || true; done
    fi
    step "$name (pid $pid) stopped."
    return 0
}

printf '\nStopping SongForge\n------------------\n'

if [ ! -f "$pid_file" ]; then
    step 'No PID file; SongForge does not appear to be running.'
    printf '\n'
    exit 0
fi

stopped=0
for name in frontend backend ollama; do
    pid="$(sed -n "s/.*\"$name\"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p" "$pid_file" | head -1)"
    if stop_tree "${pid:-0}" "$name"; then
        stopped=$((stopped + 1))
    fi
done

rm -f "$pid_file"
if [ -f "$runtime/songforge.lock" ]; then
    rm -f "$runtime/songforge.lock"
    step 'Removed a stale instance lock.'
fi

if [ "$stopped" -eq 0 ]; then
    step 'Nothing was running; cleared the stale PID file.'
fi

printf '\nSongForge stopped.\n\n'
