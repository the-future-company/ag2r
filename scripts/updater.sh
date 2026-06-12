#!/bin/bash
# updater.sh — Detects code drift and restarts stale services.
# Compares the commit each service BOOTED at (stored in /tmp) against
# origin/main. Agent sessions advance local HEAD after merging PRs,
# so comparing HEAD to origin/main would miss the drift.
#
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
HUB_PORT="${HUB_PORT:-3100}"
HUB_LOG="${HUB_LOG:-/tmp/ag2r-hub.log}"
MAIN_BOOT_FILE="/tmp/ag2r-main-boot-commit"
HUB_BOOT_FILE="/tmp/ag2r-hub-boot-commit"

cd "$AG2R_MAIN_DIR"

# Fetch latest
git fetch origin main --quiet 2>&1 || exit 0
REMOTE=$(git rev-parse origin/main 2>/dev/null || echo "unknown")

# Pull to keep local main in sync (for agents that read from it)
LOCAL=$(git rev-parse HEAD 2>/dev/null || echo "unknown")
if [ "$LOCAL" != "$REMOTE" ]; then
  git pull origin main --quiet 2>&1 || true
fi

# ── Helper: check if a service needs restarting ──
needs_restart() {
  local boot_file="$1"
  if [ ! -f "$boot_file" ]; then
    return 1  # No boot commit recorded — service hasn't been started by us
  fi
  local boot_commit
  boot_commit=$(cat "$boot_file" 2>/dev/null || true)
  if [ -z "$boot_commit" ] || [ "$boot_commit" = "$REMOTE" ]; then
    return 1  # Up to date or empty
  fi
  return 0  # Stale
}

# ── Check if deps changed ──
deps_changed() {
  local boot_commit
  boot_commit=$(cat "$1" 2>/dev/null || true)
  [ -n "$boot_commit" ] && git diff --name-only "$boot_commit" "$REMOTE" 2>/dev/null | grep -q "package-lock.json"
}

DEPS_INSTALLED=false

# ── Main server update ──
MAIN_PID=$(lsof -i :"${AG2R_MAIN_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$MAIN_PID" ] && needs_restart "$MAIN_BOOT_FILE"; then
  BOOT=$(cat "$MAIN_BOOT_FILE" | head -c 12)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server is stale ($BOOT → ${REMOTE:0:12}), restarting..."

  if ! $DEPS_INSTALLED && deps_changed "$MAIN_BOOT_FILE"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] package-lock.json changed, running npm ci..."
    npm ci --silent 2>&1 || true
    DEPS_INSTALLED=true
  fi

  kill "$MAIN_PID" 2>/dev/null || true
  sleep 2
  PORT="${AG2R_MAIN_PORT}" nohup node server.js >> "$AG2R_LOG" 2>&1 &
  echo "$REMOTE" > "$MAIN_BOOT_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Main server restarted with PID $! (now at ${REMOTE:0:12})"
fi

# ── Hub update ──
HUB_PID=$(lsof -i :"${HUB_PORT}" -sTCP:LISTEN -t 2>/dev/null || true)
if [ -n "$HUB_PID" ] && needs_restart "$HUB_BOOT_FILE"; then
  BOOT=$(cat "$HUB_BOOT_FILE" | head -c 12)
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Hub is stale ($BOOT → ${REMOTE:0:12}), restarting..."

  if ! $DEPS_INSTALLED && deps_changed "$HUB_BOOT_FILE"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] package-lock.json changed, running npm ci..."
    npm ci --silent 2>&1 || true
    DEPS_INSTALLED=true
  fi

  kill "$HUB_PID" 2>/dev/null || true
  sleep 2
  HUB_PORT="${HUB_PORT}" nohup node hub.js >> "$HUB_LOG" 2>&1 &
  echo "$REMOTE" > "$HUB_BOOT_FILE"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Hub restarted with PID $! (now at ${REMOTE:0:12})"
fi
