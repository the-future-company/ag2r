#!/bin/bash
# main-watchdog.sh — Ensures the main AG2R server stays running and up-to-date.
# Combines health check + auto-update for the main server (port 3000).
# Designed to run as a cron job every 5 minutes.
# See ONBOARDING.md § "Auto-Managed Hub & Main Server" for setup.

set -euo pipefail

# Load nvm so `node` is available in cron context
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Ensure system tools (lsof, kill) are in PATH — cron defaults to /usr/bin:/bin
export PATH="/usr/sbin:/usr/local/bin:/opt/homebrew/bin:$PATH"

# Configuration
AG2R_MAIN_DIR="${AG2R_MAIN_DIR:-$HOME/Workspace/ag2r}"
MAIN_PORT="${AG2R_MAIN_PORT:-3000}"
MAIN_LOG="${MAIN_LOG:-/tmp/ag2r-main.log}"
BOOT_COMMIT_FILE="/tmp/ag2r-main-boot-commit"

cd "$AG2R_MAIN_DIR"

# ── 1. Health check — start server if not running ──
MAIN_PID=$(lsof -i :"${MAIN_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)

if [ -z "$MAIN_PID" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server on port ${MAIN_PORT} is down, starting..."

  # Pull latest before starting
  git fetch origin main --quiet 2>&1 || true
  LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
  REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "unknown")
  if [ "$LOCAL" != "$REMOTE" ] && [ "$REMOTE" != "unknown" ]; then
    git pull origin main --quiet 2>&1 || true
  fi

  # Install deps if needed (fresh start — always safe to run)
  npm ci --silent 2>&1 || true

  # Start server
  PORT="${MAIN_PORT}" nohup node server.js >> "$MAIN_LOG" 2>&1 &
  git rev-parse HEAD > "$BOOT_COMMIT_FILE" 2>/dev/null || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server started with PID $! (commit $(head -c 12 "$BOOT_COMMIT_FILE"))"
  exit 0
fi

# ── 2. Auto-update if code changed ──
git fetch origin main --quiet 2>&1 || exit 0

BOOT_COMMIT=""
if [ -f "$BOOT_COMMIT_FILE" ]; then
  BOOT_COMMIT=$(cat "$BOOT_COMMIT_FILE" 2>/dev/null || true)
fi

# If no boot commit recorded, record current HEAD and assume fresh
if [ -z "$BOOT_COMMIT" ]; then
  git rev-parse HEAD > "$BOOT_COMMIT_FILE" 2>/dev/null || true
  exit 0
fi

REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "unknown")

if [ "$BOOT_COMMIT" = "$REMOTE" ]; then
  # Server is running the latest code
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server is stale (${BOOT_COMMIT:0:12} → ${REMOTE:0:12}), updating..."

# Pull latest
git pull origin main --quiet 2>&1 || { echo "[$(date '+%Y-%m-%d %H:%M:%S')] git pull failed"; exit 1; }

# Check if package-lock changed → npm ci
if git diff --name-only "$BOOT_COMMIT" "$REMOTE" | grep -q "package-lock.json"; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] package-lock changed, running npm ci..."
  npm ci --silent 2>&1 || true
fi

# Restart the main server
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting main server on port ${MAIN_PORT}..."
kill "$MAIN_PID" 2>/dev/null || true
sleep 2

PORT="${MAIN_PORT}" nohup node server.js >> "$MAIN_LOG" 2>&1 &

# Record the new boot commit
echo "$REMOTE" > "$BOOT_COMMIT_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server restarted with PID $! (now at ${REMOTE:0:12})"
