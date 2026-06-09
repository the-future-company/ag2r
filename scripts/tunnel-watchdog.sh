#!/bin/bash
# tunnel-watchdog.sh — Ensures the Cloudflare tunnel stays running.
# Designed to run as a cron job every 5 minutes.
# See ONBOARDING.md § "Auto-Managed Hub & Main Server" for setup.

set -euo pipefail

TUNNEL_LOG="${TUNNEL_LOG:-/tmp/ag2r-tunnel.log}"

# Check if cloudflared is already running
if pgrep -x cloudflared > /dev/null 2>&1; then
  exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Tunnel is down, restarting..."

nohup cloudflared tunnel run >> "$TUNNEL_LOG" 2>&1 &
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Tunnel restarted with PID $!"
