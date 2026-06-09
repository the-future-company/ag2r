#!/bin/bash
# hub-watchdog.sh — Ensures the AG2R hub stays running.
# Designed to run as a cron job every 5 minutes.
# See ONBOARDING.md § "Auto-Managed Main Server" for setup.

set -euo pipefail

# Load nvm so `node` is available in cron context
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Configuration
AG2R_MAIN_DIR="${AG2R_MAIN_DIR:-$HOME/Workspace/ag2r}"
HUB_PORT="${HUB_PORT:-3100}"
HUB_LOG="${HUB_LOG:-/tmp/ag2r-hub.log}"

# Health check — if hub responds, nothing to do
HEALTH=$(curl -sk --connect-timeout 2 --max-time 5 \
    "https://localhost:${HUB_PORT}/_hub/api/status" 2>/dev/null || true)

if echo "$HEALTH" | grep -q '"servers"'; then
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Hub on port ${HUB_PORT} is down, restarting..."

# Kill any zombie process on this port
EXISTING_PID=$(lsof -i :"${HUB_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  kill "$EXISTING_PID" 2>/dev/null || true
  sleep 1
fi

# Start hub from the main repo dir (where hub.js lives)
cd "$AG2R_MAIN_DIR"
HUB_PORT="${HUB_PORT}" nohup node hub.js >> "$HUB_LOG" 2>&1 &
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Hub restarted with PID $!"
