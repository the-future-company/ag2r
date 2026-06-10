#!/bin/bash
# hub-watchdog.sh — Ensures the AG2R hub stays running and the main server stays up-to-date.
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
MAIN_PORT="${AG2R_MAIN_PORT:-3000}"
MAIN_LOG="${MAIN_LOG:-/tmp/ag2r-main.log}"

# ── 1. Hub health check ──
HEALTH=$(curl -sk --connect-timeout 2 --max-time 5 \
    "https://localhost:${HUB_PORT}/_hub/api/status" 2>/dev/null || true)

if ! echo "$HEALTH" | grep -q '"servers"'; then
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
fi

# ── 2. Auto-update main server if code changed ──
# Only applies when the main server (port 3000) is running.
MAIN_PID=$(lsof -i :"${MAIN_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -z "$MAIN_PID" ]; then
  # Main server not running — nothing to update (user starts it via hub UI)
  exit 0
fi

cd "$AG2R_MAIN_DIR"
git fetch origin main --quiet 2>&1 || exit 0

LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "unknown")

if [ "$LOCAL" = "$REMOTE" ]; then
  # Already up-to-date
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server code is stale ($LOCAL → $REMOTE), updating..."

# Pull latest
git pull origin main --quiet 2>&1 || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] git pull failed"; exit 1; }

# Check if package-lock changed → npm ci
if git diff --name-only "$LOCAL" "$REMOTE" | grep -q "package-lock.json"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] package-lock changed, running npm ci..."
  npm ci --silent 2>&1 || true
fi

# Restart the main server
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting main server on port ${MAIN_PORT}..."
kill "$MAIN_PID" 2>/dev/null || true
sleep 2

PORT="${MAIN_PORT}" nohup node server.js >> "$MAIN_LOG" 2>&1 &
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server restarted with PID $! (now at $REMOTE)"
