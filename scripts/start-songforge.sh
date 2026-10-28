#!/usr/bin/env bash
# Start SongForge: the optional lyrics model, the backend, and the frontend.
#
# The POSIX counterpart of Start-SongForge.ps1, for Linux and (on the macos
# branch) Apple Silicon. Same ports, same PID file, same refusal to start twice.
#
#   ./scripts/start-songforge.sh
#   PORT=4000 BACKEND_PORT=4001 ./scripts/start-songforge.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_dir="$root/app/backend"
frontend_dir="$root/app/frontend"
runtime="$root/runtime"
log_dir="$runtime/logs"
pid_file="$runtime/songforge.pids.json"
venv_python="$runtime/venv/bin/python"

port="${PORT:-3333}"
backend_port="${BACKEND_PORT:-3334}"
timeout_seconds="${TIMEOUT_SECONDS:-120}"
ollama_url="http://127.0.0.1:11434"

# Keep the last N runs of logs. Nothing used to remove them and the folder grew
# without limit; a version's own generation.log lives with the version and is
# an artifact, not a run log, so it is never touched here.
keep_runs=10

step() { printf '  %s\n' "$1"; }
fail() { printf '  %s\n' "$1" >&2; exit "${2:-1}"; }

is_running() { kill -0 "$1" 2>/dev/null; }

wait_for() {
    # wait_for <url> <seconds> <name> <pid>
    local url="$1" seconds="$2" name="$3" pid="$4" waited=0
    while [ "$waited" -lt "$seconds" ]; do
        if ! is_running "$pid"; then
            fail "$name exited while starting. See $log_dir."
        fi
        if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 1
}

printf '\nSongForge\n---------\n'

[ -x "$venv_python" ] || fail "Python environment missing: $venv_python
Run ./setup.sh first."

# --- refuse to start twice --------------------------------------------------
if [ -f "$pid_file" ]; then
    live=""
    for name in backend frontend; do
        pid="$(sed -n "s/.*\"$name\"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p" "$pid_file" | head -1)"
        if [ -n "$pid" ] && is_running "$pid"; then
            live="$live $name (pid $pid)"
        fi
    done
    if [ -n "$live" ]; then
        fail "SongForge is already running:$live
Stop it first with ./scripts/stop-songforge.sh" 3
    fi
    step 'Clearing a stale PID file from a previous run.'
    rm -f "$pid_file"
fi

mkdir -p "$log_dir"

# --- prune old run logs -----------------------------------------------------
stamps="$(ls -1 "$log_dir" 2>/dev/null |
    sed -n 's/^\(backend\|frontend\|ollama\)-\([0-9]\{8\}-[0-9]\{6\}\)\..*$/\2/p' |
    sort -ur || true)"
if [ -n "$stamps" ]; then
    stale="$(printf '%s\n' "$stamps" | tail -n +$((keep_runs + 1)))"
    if [ -n "$stale" ]; then
        count=0
        while IFS= read -r old; do
            [ -n "$old" ] || continue
            rm -f "$log_dir"/*-"$old".* 2>/dev/null || true
            count=$((count + 1))
        done <<< "$stale"
        step "Removed logs from $count older run(s); keeping the last $keep_runs."
    fi
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backend_log="$log_dir/backend-$stamp.log"
frontend_log="$log_dir/frontend-$stamp.log"
ollama_log="$log_dir/ollama-$stamp.log"

# --- optional lyrics model --------------------------------------------------
# Entirely optional: a failure here never blocks SongForge, and the Lyrics page
# explains itself when the model is absent.
ollama_pid=""
ollama_note="not installed (the lyrics writer is optional)"
# The .dmg installs Ollama as an application bundle and only adds the CLI to
# PATH if you let it, so the bundle is checked explicitly. A Homebrew install
# is already on PATH and is found by the command -v below.
ollama_exe="$runtime/ollama/ollama"
if [ ! -x "$ollama_exe" ]; then
    for candidate in "$(command -v ollama 2>/dev/null || true)" \
                     /Applications/Ollama.app/Contents/Resources/ollama \
                     "$HOME/Applications/Ollama.app/Contents/Resources/ollama"
    do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            ollama_exe="$candidate"
            break
        fi
    done
fi

if curl -fsS --max-time 3 "$ollama_url/api/version" >/dev/null 2>&1; then
    ollama_note="already running"
elif [ -x "$ollama_exe" ]; then
    step 'Starting the local lyrics model server (Ollama) ...'
    OLLAMA_HOST=127.0.0.1 OLLAMA_MODELS="$runtime/models/ollama" \
        "$ollama_exe" serve >"$ollama_log" 2>&1 &
    ollama_pid=$!
    if wait_for "$ollama_url/api/version" 30 'Ollama' "$ollama_pid"; then
        step "Lyrics model server ready (pid $ollama_pid)."
        ollama_note='running on localhost'
    else
        step 'Ollama did not answer in time; continuing without the lyrics writer.'
        ollama_note='did not start'
    fi
fi

# --- backend ----------------------------------------------------------------
step "Starting backend on 127.0.0.1:$backend_port ..."
(
    cd "$backend_dir"
    exec "$venv_python" -m uvicorn songforge.main:app \
        --host 127.0.0.1 --port "$backend_port"
) >"$backend_log" 2>&1 &
backend_pid=$!

if ! wait_for "http://127.0.0.1:$backend_port/api/health" "$timeout_seconds" 'Backend' "$backend_pid"; then
    kill "$backend_pid" 2>/dev/null || true
    fail "Backend did not respond within ${timeout_seconds}s. See $backend_log." 4
fi
step "Backend healthy (pid $backend_pid)."

# --- frontend ---------------------------------------------------------------
step "Starting frontend on 0.0.0.0:$port ..."
(
    cd "$frontend_dir"
    SONGFORGE_API_URL="http://127.0.0.1:$backend_port" \
        exec npm run start -- --hostname 0.0.0.0 --port "$port"
) >"$frontend_log" 2>&1 &
frontend_pid=$!

if ! wait_for "http://127.0.0.1:$port" "$timeout_seconds" 'Frontend' "$frontend_pid"; then
    kill "$frontend_pid" "$backend_pid" 2>/dev/null || true
    fail "Frontend did not respond within ${timeout_seconds}s. See $frontend_log." 5
fi
step "Frontend ready (pid $frontend_pid)."

printf '{\n  "backend": %s,\n  "frontend": %s,\n  "ollama": %s,\n  "started": "%s"\n}\n' \
    "$backend_pid" "$frontend_pid" "${ollama_pid:-0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$pid_file"

# The address on the interface holding the default route: the first private
# address is often a container or VM bridge that no other device can reach.
lan=""
if command -v ip >/dev/null 2>&1; then
    lan="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
elif command -v route >/dev/null 2>&1; then
    iface="$(route -n get default 2>/dev/null | sed -n 's/.*interface: *//p' | head -1)"
    [ -n "$iface" ] && lan="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
fi

printf '\nSongForge is running.\n'
printf '  On this PC:    http://localhost:%s\n' "$port"
[ -n "$lan" ] && printf '  On your LAN:   http://%s:%s\n                 (open this one on another device)\n' "$lan" "$port"
printf '  API docs:      http://localhost:%s/api/docs\n' "$backend_port"
printf '  Logs:          %s\n' "$log_dir"
printf '  Lyrics model:  %s\n' "$ollama_note"
printf '\n  Stop with: ./scripts/stop-songforge.sh\n\n'
