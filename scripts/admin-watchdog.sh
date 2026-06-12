#!/bin/bash
# scripts/admin-watchdog.sh — Keeps telemetry admin server alive
# Cron: */5 * * * * ~/Workspace/ag2r/scripts/admin-watchdog.sh >> /tmp/ag2r-admin-watchdog.log 2>&1

export PATH="/usr/sbin:/usr/local/bin:/usr/bin:/bin:$PATH"

ADMIN_PORT="${ADMIN_PORT:-3200}"
AG2R_DIR="${AG2R_MAIN_DIR:-$HOME/Workspace/ag2r}"
ADMIN_LOG="/tmp/ag2r-admin.log"
BOOT_COMMIT_FILE="/tmp/ag2r-admin-boot-commit"

log() { echo "[$(date '+%H:%M:%S')] $1"; }

# Check if admin server is listening
PID=$(lsof -i :"$ADMIN_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)

if [ -z "$PID" ]; then
  log "Admin server not running on port $ADMIN_PORT — starting..."

  cd "$AG2R_DIR" || exit 1
  COMMIT=$(git rev-parse HEAD 2>/dev/null)

  ADMIN_PORT="$ADMIN_PORT" nohup node .telemetry/server.js >> "$ADMIN_LOG" 2>&1 &

  sleep 2
  NEW_PID=$(lsof -i :"$ADMIN_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
  if [ -n "$NEW_PID" ]; then
    echo "$COMMIT" > "$BOOT_COMMIT_FILE"
    log "Admin server started (PID $NEW_PID, commit ${COMMIT:0:12})"
  else
    log "ERROR: Admin server failed to start"
  fi
else
  # Check for code drift
  cd "$AG2R_DIR" || exit 0
  git fetch origin main --quiet 2>/dev/null

  BOOT_COMMIT=""
  [ -f "$BOOT_COMMIT_FILE" ] && BOOT_COMMIT=$(cat "$BOOT_COMMIT_FILE")
  REMOTE_COMMIT=$(git rev-parse origin/main 2>/dev/null)

  if [ -n "$BOOT_COMMIT" ] && [ -n "$REMOTE_COMMIT" ] && [ "$BOOT_COMMIT" != "$REMOTE_COMMIT" ]; then
    log "Code drift detected (boot: ${BOOT_COMMIT:0:12} → remote: ${REMOTE_COMMIT:0:12}). Restarting..."

    kill "$PID" 2>/dev/null
    sleep 2

    git pull origin main --quiet 2>/dev/null

    ADMIN_PORT="$ADMIN_PORT" nohup node .telemetry/server.js >> "$ADMIN_LOG" 2>&1 &
    sleep 2

    NEW_PID=$(lsof -i :"$ADMIN_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
    NEW_COMMIT=$(git rev-parse HEAD 2>/dev/null)
    echo "$NEW_COMMIT" > "$BOOT_COMMIT_FILE"
    log "Admin server restarted (PID ${NEW_PID:-?}, commit ${NEW_COMMIT:0:12})"
  fi
fi
