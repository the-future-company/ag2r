#!/bin/bash
# ag-watchdog.sh — Ensures the Antigravity desktop app is running with CDP enabled.
#
# Logic:
#   1. AG not running              → start with --remote-debugging-port=9000
#   2. AG running w/o debug port   → kill and restart with --remote-debugging-port=9000
#   3. AG running w/ debug port    → do nothing
#
# Cron: */5 * * * * ~/Workspace/ag2r/scripts/ag-watchdog.sh >> /tmp/ag2r-ag-watchdog.log 2>&1

set -euo pipefail

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

AG_BINARY="Antigravity.app/Contents/MacOS/Antigravity"

# pgrep doesn't work for Electron on macOS — must use ps aux (see ONBOARDING.md gotcha)
AG_LINE=$(ps aux | grep "$AG_BINARY" | grep -v grep || true)

if [ -z "$AG_LINE" ]; then
  log "Antigravity not running — starting with CDP on port 9000..."
  open -a Antigravity --args --remote-debugging-port=9000
  log "Launch command sent"
  exit 0
fi

if echo "$AG_LINE" | grep -q -- "--remote-debugging-port"; then
  exit 0
fi

# Running without CDP — kill and restart
AG_PID=$(echo "$AG_LINE" | awk '{print $2}')
log "Antigravity running without CDP (PID $AG_PID) — restarting..."

kill "$AG_PID" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! ps -p "$AG_PID" > /dev/null 2>&1; then break; fi
  sleep 1
done

open -a Antigravity --args --remote-debugging-port=9000
log "Restarted with CDP on port 9000"
