#!/bin/bash
# watchdog.sh — Keeps an AG2R server running and auto-updates from the tracked branch.
# Detects the current branch automatically and tracks origin/<branch>.
# Designed to run as a cron job every 5 minutes.
#
# Usage:
#   AG2R_PORT=3000 ./scripts/watchdog.sh
#
# Cron example (every 5 minutes):
#   */5 * * * * cd ~/ag2r && AG2R_PORT=3000 ./scripts/watchdog.sh >> /tmp/ag2r-watchdog.log 2>&1
#
# Environment variables:
#   AG2R_PORT  — Port to run the server on (default: 3000)

set -euo pipefail

# Load nvm so `node` is available in cron context
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Ensure system tools (lsof, kill) are in PATH — cron defaults to /usr/bin:/bin
export PATH="/usr/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Configuration
PORT="${AG2R_PORT:-3000}"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Not on a branch (detached HEAD or not a git repo)"
  exit 1
fi

LOG="${AG2R_LOG:-/tmp/ag2r-${BRANCH}.log}"
BOOT_COMMIT_FILE="/tmp/ag2r-${BRANCH}-boot-commit"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Watchdog checking branch=$BRANCH port=$PORT"

# ── 1. Health check — start server if not running ──
SERVER_PID=$(lsof -i :"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)

if [ -z "$SERVER_PID" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server on port ${PORT} is down, starting..."

  # Pull latest before starting
  git fetch origin "$BRANCH" --quiet 2>&1 || true
  LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "unknown")
  if [ "$LOCAL" != "$REMOTE" ] && [ "$REMOTE" != "unknown" ]; then
    git pull origin "$BRANCH" --quiet 2>&1 || true
  fi

  # Install deps if needed (fresh start — always safe to run)
  npm ci --silent 2>&1 || true

  # Start server
  PORT="${PORT}" nohup node server.js >> "$LOG" 2>&1 &
  git rev-parse HEAD > "$BOOT_COMMIT_FILE" 2>/dev/null || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server started with PID $! on branch $BRANCH (commit $(head -c 12 "$BOOT_COMMIT_FILE"))"
  exit 0
fi

# ── 2. Auto-update if code changed ──
git fetch origin "$BRANCH" --quiet 2>&1 || exit 0

BOOT_COMMIT=""
if [ -f "$BOOT_COMMIT_FILE" ]; then
  BOOT_COMMIT=$(cat "$BOOT_COMMIT_FILE" 2>/dev/null || true)
fi

# If no boot commit recorded, record current HEAD and assume fresh
if [ -z "$BOOT_COMMIT" ]; then
  git rev-parse HEAD > "$BOOT_COMMIT_FILE" 2>/dev/null || true
  exit 0
fi

REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "unknown")

if [ "$BOOT_COMMIT" = "$REMOTE" ]; then
  # Server is running the latest code
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server is stale (${BOOT_COMMIT:0:12} → ${REMOTE:0:12}), updating..."

# Pull latest
git pull origin "$BRANCH" --quiet 2>&1 || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] git pull failed"; exit 1; }

# Check if package-lock changed → npm ci
if git diff --name-only "$BOOT_COMMIT" "$REMOTE" | grep -q "package-lock.json"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] package-lock changed, running npm ci..."
  npm ci --silent 2>&1 || true
fi

# Restart the server
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting server on port ${PORT}..."
kill "$SERVER_PID" 2>/dev/null || true
sleep 2

PORT="${PORT}" nohup node server.js >> "$LOG" 2>&1 &

# Record the new boot commit
echo "$REMOTE" > "$BOOT_COMMIT_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server restarted with PID $! on branch $BRANCH (now at ${REMOTE:0:12})"
