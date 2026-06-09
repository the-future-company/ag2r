#!/bin/bash
# updater.sh — Pulls latest main and restarts if changes detected.
# Designed to run as a cron job every 10 minutes.
# See ONBOARDING.md § "Auto-Managed Main Server" for setup.

set -euo pipefail

# Load nvm so `node` and `npm` are available in cron context
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Configuration (override via environment or .env in MAIN_DIR)
AG2R_MAIN_DIR="${AG2R_MAIN_DIR:-$HOME/Workspace/ag2r}"
AG2R_MAIN_PORT="${AG2R_MAIN_PORT:-3000}"
AG2R_LOG="${AG2R_LOG:-/tmp/ag2r-main.log}"

cd "$AG2R_MAIN_DIR"

# Fetch latest
git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

# No changes — nothing to do
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] New changes: ${LOCAL:0:7} → ${REMOTE:0:7}"

# Pull
git pull origin main --quiet

# Reinstall deps if package-lock changed
if git diff --name-only "$LOCAL" "$REMOTE" | grep -q "package-lock.json"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] package-lock.json changed, running npm ci..."
  npm ci --silent
fi

# Restart server
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting server..."
EXISTING_PID=$(lsof -i :"${AG2R_MAIN_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
  kill "$EXISTING_PID" 2>/dev/null || true
  sleep 1
fi

PORT="${AG2R_MAIN_PORT}" nohup node server.js >> "$AG2R_LOG" 2>&1 &
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server restarted with PID $!"
