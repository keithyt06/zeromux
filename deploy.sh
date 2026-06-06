#!/bin/bash
# Atomic systemd deploy for the live zeromux.keithyu.cloud server.
#
# Why this exists: the manual "stop -> cp -> start" dance has twice left the
# service stopped (stopped, then the deploy was interrupted before start),
# returning 502. This script makes the swap atomic: it ALWAYS leaves a running
# service, auto-rolling-back to the previous binary if the new one fails health
# check. `systemctl restart` is NOT enough on its own — the running process
# holds the binary open, so `cp` over it fails with "Text file busy"; the binary
# must be replaced while stopped.
#
# Usage:
#   ./deploy.sh            # replace installed binary with target/release/zeromux, restart, verify
#   ./deploy.sh --build    # build frontend + cargo release first, then deploy
#
# Requires: passwordless sudo (already configured on this host).

set -euo pipefail
cd "$(dirname "$0")"

SERVICE=zeromux
INSTALLED=/usr/local/bin/zeromux
BUILT=target/release/zeromux

# Health-check URL derived from the unit's --port (falls back to 8090).
PORT="$(systemctl cat "$SERVICE" | sed -n 's/.*--port \([0-9]\+\).*/\1/p' | head -1)"
PORT="${PORT:-8090}"
HEALTH="http://127.0.0.1:${PORT}/"

if [ "${1:-}" = "--build" ]; then
  echo ">> Building frontend (rust-embed reads frontend/dist/ at compile time)..."
  ( cd frontend && npm run build )
  echo ">> Building release binary (slow: opt-level=z + lto)..."
  cargo build --release
fi

[ -f "$BUILT" ] || { echo "!! $BUILT not found — run with --build first."; exit 1; }
echo ">> Smoke-testing new binary..."
"$BUILT" --help >/dev/null

BACKUP="${INSTALLED}.bak-$(date +%Y%m%d-%H%M%S)"
echo ">> Backing up current binary -> $BACKUP"
sudo cp "$INSTALLED" "$BACKUP"

echo ">> Stopping $SERVICE..."
sudo systemctl stop "$SERVICE"
echo ">> Installing new binary..."
sudo cp "$BUILT" "$INSTALLED"
echo ">> Starting $SERVICE..."
sudo systemctl start "$SERVICE"

echo ">> Verifying (${HEALTH}) ..."
for i in $(seq 1 10); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH" || true)"
  [ "$code" = "200" ] && { echo ">> OK: HTTP 200, deploy complete."; exit 0; }
  sleep 1
done

echo "!! Health check failed (last code: ${code:-none}). Rolling back to $BACKUP"
sudo systemctl stop "$SERVICE"
sudo cp "$BACKUP" "$INSTALLED"
sudo systemctl start "$SERVICE"
echo "!! Rolled back. Service restarted with previous binary. Check: journalctl -u $SERVICE -n 30"
exit 1
