#!/usr/bin/env bash
# Starts SongForge. See scripts/start-songforge.sh for the options (--lan, --no-browser).
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/start-songforge.sh" "$@"
