#!/usr/bin/env bash
# Start SongForge and keep this terminal open while it runs.
#
# Starts the backend and the web app, waits until both answer, prints the
# address to open, and then stays in the foreground. This terminal IS the app:
# press Ctrl+C or close it and SongForge stops. Nothing is left running in the
# background.
#
#   ./scripts/start-songforge.sh                 this computer only
#   ./scripts/start-songforge.sh --lan           also reachable on your network
#   ./scripts/start-songforge.sh --no-browser    do not open the browser
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
lan=0
open_browser=1

for argument in "$@"; do
    case "$argument" in
        --lan) lan=1 ;;
        --no-browser) open_browser=0 ;;
        -h|--help)
            sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) printf '  Unknown option: %s (try --help)\n' "$argument" >&2; exit 2 ;;
    esac
done

# Keep the last N runs of logs. Nothing used to remove them and the folder grew
# without limit; a version's own generation.log lives with the version and is
# an artifact, not a run log, so it is never touched here.
keep_runs=10

if [ -t 1 ]; then
    bold=$'\033[1m'; dim=$'\033[2m'; green=$'\033[32m'; cyan=$'\033[36m'
    red=$'\033[31m'; yellow=$'\033[33m'; reset=$'\033[0m'
else
    bold=''; dim=''; green=''; cyan=''; red=''; yellow=''; reset=''
fi

step() { printf '  %s%s%s\n' "$cyan" "$1" "$reset"; }
note() { printf '  %s%s%s\n' "$dim" "$1" "$reset"; }
warn() { printf '  %s%s%s\n' "$yellow" "$1" "$reset"; }

is_running() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

is_ours() {
    # is_ours <pid> <name>: still running AND still the program we started.
    # After a crash and a reboot the numbers in the PID file can belong to
    # anything, and a PID alone is not proof that the process is SongForge's.
    local pid="$1" name="$2" program
    is_running "$pid" || return 1
    program="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
    case "$name" in
        backend)  case "$program" in *[Pp]ython*) return 0 ;; esac ;;
        frontend) case "$program" in *node*) return 0 ;; esac ;;
        ollama)   case "$program" in *ollama*) return 0 ;; esac ;;
        *) return 0 ;;
    esac
    return 1
}

children=()

stop_tree() {
    # The web app is node started by this shell, and the backend may be in the
    # middle of a render: both have children of their own that must go too.
    local pid="$1" child
    is_running "$pid" || return 0
    for child in $(pgrep -P "$pid" 2>/dev/null || true); do stop_tree "$child"; done
    kill -TERM "$pid" 2>/dev/null || true
    local waited=0
    while [ "$waited" -lt 20 ] && is_running "$pid"; do
        sleep 0.25
        waited=$((waited + 1))
    done
    if is_running "$pid"; then kill -KILL "$pid" 2>/dev/null || true; fi
}

stopped=0
stop_everything() {
    [ "$stopped" -eq 1 ] && return 0
    stopped=1
    if [ "${#children[@]}" -gt 0 ]; then
        printf '\n'
        step 'Stopping SongForge ...'
        local pid
        for pid in "${children[@]}"; do stop_tree "$pid"; done
        printf '  %sStopped.%s\n\n' "$green" "$reset"
        # Only files this run created; never anything outside runtime/.
        rm -f -- "${pid_file:?}" "${runtime:?}/songforge.lock"
    fi
}

# EXIT covers every way out: Ctrl+C, a closed terminal (SIGHUP), a failure
# below, and kill. Nothing started here may outlive this script.
trap stop_everything EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

fail() {
    printf '\n  %s%s%s\n' "$red" "$1" "$reset" >&2
    exit "${2:-1}"
}

wait_for() {
    # wait_for <url> <seconds> <pid>; 0 = answering, 1 = timed out, 2 = exited.
    local url="$1" seconds="$2" pid="$3" waited=0
    while [ "$waited" -lt "$seconds" ]; do
        is_running "$pid" || return 2
        if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        waited=$((waited + 1))
    done
    return 1
}

show_log_tail() {
    [ -s "$1" ] || return 0
    note '--- last lines of the log ---'
    tail -n 20 "$1" | sed 's/^/    /'
}

printf '\n  %sSongForge%s\n  ---------\n' "$bold" "$reset"

command -v curl >/dev/null 2>&1 || fail 'curl is needed to check that SongForge started. Install it and try again.'

[ -x "$venv_python" ] || fail "SongForge is not installed yet.
  Run ./setup.sh first." 4
[ -d "$frontend_dir/node_modules/next" ] || fail "The web app's packages are not installed.
  Run ./setup.sh again." 4
[ -f "$frontend_dir/.next/BUILD_ID" ] || fail "The web app has not been built.
  Run ./setup.sh again." 4
command -v node >/dev/null 2>&1 || fail 'Node.js was not found. Install the LTS version from https://nodejs.org.' 4

# --- refuse to start twice --------------------------------------------------
if [ -f "$pid_file" ]; then
    live=""
    for name in backend frontend; do
        pid="$(sed -n "s/.*\"$name\"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p" "$pid_file" | head -1)"
        if is_ours "$pid" "$name"; then
            live="$live $name (pid $pid)"
        fi
    done
    if [ -n "$live" ]; then
        fail "SongForge is already running:$live
  Use the terminal it was started in, or stop it with ./scripts/stop-songforge.sh" 3
    fi
    rm -f -- "${pid_file:?}"
fi
if curl -fsS --max-time 2 "http://127.0.0.1:$backend_port/api/health" >/dev/null 2>&1; then
    fail "Something is already answering on port $backend_port - probably another SongForge.
  Close that one first, or run ./scripts/stop-songforge.sh
  If another program owns that port, start with: BACKEND_PORT=3344 ./start.sh" 3
fi

mkdir -p "$log_dir"

# --- the web app must point at the engine port in use ------------------------
# The address the web app forwards /api to is fixed when it is built. Started
# on another engine port without rebuilding, every request went to the old
# port and the app opened to nothing but errors.
routes="$frontend_dir/.next/routes-manifest.json"
if [ -f "$routes" ] && ! grep -Fq "http://127.0.0.1:$backend_port/" "$routes"; then
    step "Rebuilding the web app for engine port $backend_port (about a minute, once) ..."
    if ! (
        cd "$frontend_dir"
        SONGFORGE_API_URL="http://127.0.0.1:$backend_port" NEXT_TELEMETRY_DISABLED=1 \
            node node_modules/next/dist/bin/next build
    ) >"$log_dir/rebuild.log" 2>&1; then
        show_log_tail "$log_dir/rebuild.log"
        fail "The web app could not be rebuilt for port $backend_port.
  Start without BACKEND_PORT, or run ./setup.sh again." 4
    fi
fi

# --- prune old run logs -----------------------------------------------------
stamps="$(ls -1 "$log_dir" 2>/dev/null |
    sed -En 's/^(backend|frontend|ollama)-([0-9]{8}-[0-9]{6})\..*$/\2/p' |
    sort -ur || true)"
if [ -n "$stamps" ]; then
    stale="$(printf '%s\n' "$stamps" | tail -n +$((keep_runs + 1)))"
    if [ -n "$stale" ]; then
        while IFS= read -r old; do
            [ -n "$old" ] || continue
            # :? stops the script rather than widening the glob if either
            # variable were ever empty.
            rm -f -- "${log_dir:?}"/*-"${old:?}".* 2>/dev/null || true
        done <<< "$stale"
    fi
fi

stamp="$(date +%Y%m%d-%H%M%S)"
backend_log="$log_dir/backend-$stamp.log"
frontend_log="$log_dir/frontend-$stamp.log"
ollama_log="$log_dir/ollama-$stamp.log"

# --- optional lyrics model --------------------------------------------------
# Entirely optional: a failure here never blocks SongForge, and the lyrics
# writer explains itself when the model is absent. An Ollama that is already
# running is used as it is and left running afterwards; one started here is
# stopped with SongForge.
ollama_note="not installed (optional)"
ollama_exe=""
# The macOS .dmg installs Ollama as an application bundle and only adds the
# CLI to PATH if you let it, so the bundle is checked explicitly.
for candidate in "$runtime/ollama/ollama" \
                 "$(command -v ollama 2>/dev/null || true)" \
                 /Applications/Ollama.app/Contents/Resources/ollama \
                 "$HOME/Applications/Ollama.app/Contents/Resources/ollama"
do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
        ollama_exe="$candidate"
        break
    fi
done

if curl -fsS --max-time 3 "$ollama_url/api/version" >/dev/null 2>&1; then
    ollama_note="running"
elif [ -n "$ollama_exe" ]; then
    step 'Starting the lyrics writer (Ollama) ...'
    # A portable copy keeps its models beside it. A system install keeps them
    # where its own installer put them, and pointing it elsewhere would hide
    # every model the user has already pulled.
    if [ "$ollama_exe" = "$runtime/ollama/ollama" ] || [ -d "$runtime/models/ollama" ]; then
        export OLLAMA_MODELS="$runtime/models/ollama"
    fi
    OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 \
        "$ollama_exe" serve >"$ollama_log" 2>&1 &
    ollama_pid=$!
    children+=("$ollama_pid")
    if wait_for "$ollama_url/api/version" 30 "$ollama_pid"; then
        ollama_note='running'
    else
        ollama_note="did not start (optional) - see $ollama_log"
        stop_tree "$ollama_pid"
    fi
fi

# --- backend ----------------------------------------------------------------
step 'Starting the engine ...'
(
    cd "$backend_dir"
    # Tells the engine whether it is being shared. While it is, the settings
    # that decide which program runs cannot be changed from the web page.
    export SONGFORGE_LAN="$lan"
    exec "$venv_python" -m uvicorn songforge.main:app \
        --host 127.0.0.1 --port "$backend_port"
) >"$backend_log" 2>&1 &
backend_pid=$!
children+=("$backend_pid")

if ! wait_for "http://127.0.0.1:$backend_port/api/health" "$timeout_seconds" "$backend_pid"; then
    printf '\n  %sThe engine did not start.%s\n' "$red" "$reset" >&2
    warn "Log: $backend_log"
    show_log_tail "$backend_log"
    exit 5
fi

# --- web app ----------------------------------------------------------------
step 'Starting the web app ...'
bind='127.0.0.1'
[ "$lan" -eq 1 ] && bind='0.0.0.0'
(
    cd "$frontend_dir"
    # node is started directly rather than through npm: one process fewer and
    # a real exit code.
    SONGFORGE_API_URL="http://127.0.0.1:$backend_port" NEXT_TELEMETRY_DISABLED=1 \
        exec node node_modules/next/dist/bin/next start --hostname "$bind" --port "$port"
) >"$frontend_log" 2>&1 &
frontend_pid=$!
children+=("$frontend_pid")

if ! wait_for "http://127.0.0.1:$port" "$timeout_seconds" "$frontend_pid"; then
    printf '\n  %sThe web app did not start.%s\n' "$red" "$reset" >&2
    warn "Log: $frontend_log"
    show_log_tail "$frontend_log"
    warn "If port $port is taken by another program, start with: PORT=8080 ./scripts/start-songforge.sh"
    exit 5
fi

printf '{\n  "backend": %s,\n  "frontend": %s,\n  "ollama": 0,\n  "port": %s,\n  "started": "%s"\n}\n' \
    "$backend_pid" "$frontend_pid" "$port" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > "$pid_file"

url="http://localhost:$port"
printf '\n  %sSongForge is running.%s\n\n' "$green" "$reset"
printf '    Open it here:    %s%s%s\n' "$bold" "$url" "$reset"
if [ "$lan" -eq 1 ]; then
    # The address on the interface holding the default route: the first
    # private address is often a container or VM bridge that no other device
    # can reach.
    address=""
    if command -v ip >/dev/null 2>&1; then
        address="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
    elif command -v route >/dev/null 2>&1; then
        iface="$(route -n get default 2>/dev/null | sed -n 's/.*interface: *//p' | head -1)"
        [ -n "$iface" ] && address="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    fi
    if [ -n "$address" ]; then
        printf '    Other devices:   %shttp://%s:%s%s\n' "$bold" "$address" "$port" "$reset"
    else
        warn '    No network address was found; only this computer can open it.'
    fi
else
    note '    Only this computer can open it. Start with --lan to share it on your network.'
fi
note "    Lyrics writer:   $ollama_note"
note "    Logs:            $log_dir"
printf '\n  %sKeep this terminal open while you use SongForge.%s\n' "$bold" "$reset"
printf '  %sPress Ctrl+C here, or close it, to stop.%s\n\n' "$bold" "$reset"

if [ "$open_browser" -eq 1 ]; then
    # Only where there is a desktop to open it on: over SSH this would either
    # fail noisily or open a browser on a screen nobody is looking at.
    if [ "$(uname -s)" = "Darwin" ]; then
        open "$url" >/dev/null 2>&1 || true
    elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" >/dev/null 2>&1 || true
    fi
fi

# --- stay in the foreground -------------------------------------------------
# One line per event, so the terminal reads as a short history of the session
# rather than a wall of server output (that is what the logs are for).
last_job=""
while true; do
    sleep 2
    if ! is_running "$backend_pid"; then
        printf '\n  %sThe engine stopped unexpectedly.%s\n' "$red" "$reset" >&2
        show_log_tail "$backend_log"
        exit 5
    fi
    if ! is_running "$frontend_pid"; then
        printf '\n  %sThe web app stopped unexpectedly.%s\n' "$red" "$reset" >&2
        show_log_tail "$frontend_log"
        exit 5
    fi
    health="$(curl -fsS --max-time 3 "http://127.0.0.1:$backend_port/api/health" 2>/dev/null || true)"
    [ -n "$health" ] || continue
    job="$(printf '%s' "$health" | sed -n 's/.*"active_job_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    if [ "$job" != "$last_job" ]; then
        now="$(date +%H:%M:%S)"
        if [ -n "$job" ]; then
            printf '  %s[%s] Rendering a song ...%s\n' "$cyan" "$now" "$reset"
        elif [ -n "$last_job" ]; then
            printf '  %s[%s] Done. Ready for the next one.%s\n' "$green" "$now" "$reset"
        fi
        last_job="$job"
    fi
done
