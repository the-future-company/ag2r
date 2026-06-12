#!/bin/bash
# watchdog.sh — Ensures the main AG2R server stays running.
# Designed to run as a cron job every 5 minutes.
# See ONBOARDING.md § "Auto-Managed Main Server" for setup.

set -euo pipefail

# Load nvm so `node` is available in cron context
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Configuration (override via environment or .env in MAIN_DIR)
AG2R_MAIN_DIR="${AG2R_MAIN_DIR:-$HOME/Workspace/ag2r}"
AG2R_MAIN_PORT="${AG2R_MAIN_PORT:-3000}"
AG2R_LOG="${AG2R_LOG:-/tmp/ag2r-main.log}"
BOOT_COMMIT_FILE="/tmp/ag2r-main-boot-commit"

# Health check — if server responds, nothing to do
HEALTH=$(curl -sk --connect-timeout 2 --max-time 5 \
    "https://localhost:${AG2R_MAIN_PORT}/health" 2>/dev/null || true)

if echo "$HEALTH" | grep -q '"status":"ok"'; then
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server on port ${AG2R_MAIN_PORT} is down, restarting..."

# Kill any zombie process on this port
EXISTING_PID=$(lsof -i :"${AG2R_MAIN_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  kill "$EXISTING_PID" 2>/dev/null || true
  sleep 1
fi

# Start server and record boot commit
cd "$AG2R_MAIN_DIR"
PORT="${AG2R_MAIN_PORT}" nohup node server.js >> "$AG2R_LOG" 2>&1 &
git rev-parse HEAD > "$BOOT_COMMIT_FILE" 2>/dev/null || true
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server restarted with PID $! (commit $(cat "$BOOT_COMMIT_FILE" | head -c 12))"
