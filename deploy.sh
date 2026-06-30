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
# THE cgroup SELF-KILL TRAP (the real reason mobile deploys kept 502-ing):
# zeromux spawns its PTY shells AS CHILDREN, so they live inside the
# zeromux.service cgroup. The unit's KillMode=control-group means `systemctl
# stop zeromux` kills the ENTIRE cgroup. If you run this script from a zeromux
# terminal (e.g. on your phone — the only terminal you have there), the script
# process is ALSO in that cgroup: the moment it reaches `systemctl stop`, systemd
# kills the script itself before it can reach `start`. Result: service down, 502,
# and the auto-rollback never runs either (its process was killed too).
#
# Fix: re-exec ourselves into a transient systemd scope OUTSIDE the zeromux
# cgroup before touching the service. Then `systemctl stop zeromux` can't reach
# us. This makes the script safe to run from anywhere, including a phone.
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

# ── The dangerous swap: stop -> cp -> start -> health-check -> auto-rollback ──
# Everything that touches the service lives here so it can be run as one unit
# inside a detached cgroup (see the dispatch below). Uses only sudo/systemctl/
# cp/curl, so it is safe to run under a root scope. Takes $BUILT as $1.
# Guard state for the EXIT trap below. NOT `local`: the EXIT trap fires at shell
# exit, after do_swap has returned, so its locals would already be gone.
SWAP_BACKUP=""
SWAP_DONE=0
# Last-resort guard: from the moment we stop the service until we exit cleanly,
# ANY abnormal exit (cp fails, `systemctl start` errors, EPIPE, SIGTERM) must
# still leave a RUNNING service — the script's whole promise. The health-check
# rollback inside do_swap only covers "started but unhealthy"; this trap covers
# the gaps where we'd otherwise die with the service stopped. SWAP_DONE=1
# disarms it on success and on the handled-rollback path.
_ensure_running() {
  [ "$SWAP_DONE" = 1 ] && return
  [ -n "$SWAP_BACKUP" ] || return
  echo "!! Abnormal exit with service stopped — restoring from $SWAP_BACKUP" >&2
  sudo cp "$SWAP_BACKUP" "$INSTALLED" 2>/dev/null || true
  sudo systemctl start "$SERVICE" 2>/dev/null || true
}

do_swap() {
  local built="$1"
  SWAP_BACKUP="${INSTALLED}.bak-$(date +%Y%m%d-%H%M%S)"
  local backup="$SWAP_BACKUP"
  echo ">> Backing up current binary -> $backup"
  sudo cp "$INSTALLED" "$backup"

  trap _ensure_running EXIT

  echo ">> Stopping $SERVICE..."
  sudo systemctl stop "$SERVICE"
  echo ">> Installing new binary..."
  sudo cp "$built" "$INSTALLED"
  echo ">> Starting $SERVICE..."
  sudo systemctl start "$SERVICE"

  echo ">> Verifying (${HEALTH}) ..."
  # Startup can take ~36s when --vault-dir is set: the vault index is walked
  # synchronously before the HTTP listener binds, and the vault lives on the
  # slow JuiceFS/S3-backed FS (6869 files / 12GB). A short window here would
  # false-negative and roll back to the previous binary. Poll up to 90s.
  local code
  for _ in $(seq 1 90); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH" || true)"
    [ "$code" = "200" ] && { SWAP_DONE=1; echo ">> OK: HTTP 200, deploy complete."; return 0; }
    sleep 1
  done

  echo "!! Health check failed (last code: ${code:-none}). Rolling back to $backup"
  sudo systemctl stop "$SERVICE"
  sudo cp "$backup" "$INSTALLED"
  sudo systemctl start "$SERVICE"
  SWAP_DONE=1
  echo "!! Rolled back. Service restarted with previous binary. Check: journalctl -u $SERVICE -n 30"
  return 1
}

# Internal entrypoint: the detached scope re-invokes the script with this flag
# to run ONLY the swap (build already happened in the original context).
if [ "${1:-}" = "__swap__" ]; then
  do_swap "$BUILT"
  exit $?
fi

if [ "${1:-}" = "--build" ]; then
  echo ">> Building frontend (rust-embed reads frontend/dist/ at compile time)..."
  ( cd frontend && npm run build )
  echo ">> Building release binary (slow: opt-level=z + lto)..."
  cargo build --release
fi

[ -f "$BUILT" ] || { echo "!! $BUILT not found — run with --build first."; exit 1; }
echo ">> Smoke-testing new binary..."
"$BUILT" --help >/dev/null

# ── cgroup self-kill guard ───────────────────────────────────────────────────
# If we're inside the zeromux.service cgroup (script launched from a zeromux PTY,
# e.g. on a phone — the only terminal you have there), `systemctl stop zeromux`
# would kill THIS script before it reaches `start`: service down, 502, and the
# rollback never runs either. So run the swap as a TRANSIENT SYSTEMD SERVICE,
# which PID 1 owns in its own cgroup under system.slice — `systemctl stop
# zeromux` can't reach it.
#
# NOTE: it must be a service (`systemd-run`), NOT `systemd-run --scope`. A scope
# stays attached to the launching session's cgroup and dies with it (verified
# empirically). `--wait` blocks until the swap finishes and propagates its exit
# code. The build above already ran as the normal user; only the root-safe swap
# is detached.
#
# DO NOT add `--pipe` here. `--pipe` connects the swap service's stdout back to
# THIS systemd-run client — and this client, reached via `exec` from a zeromux
# PTY, is still inside the zeromux.service cgroup (exec does not change cgroup).
# The instant the swap reaches `systemctl stop zeromux`, KillMode=control-group
# kills this client, breaking the pipe; the swap's next `echo` then dies on
# EPIPE under `set -e` — AFTER stop, BEFORE cp+start. That leaves the service
# dead and 502-ing (the exact failure this script exists to prevent, observed
# twice: 2026-06-11 23:40 and 2026-06-12 03:49). Without `--pipe`, the swap's
# output goes to the journal instead of a fd tethered to the doomed cgroup, so
# the swap always runs stop->cp->start->verify to completion. Follow it with:
#   journalctl -u zeromux-deploy-<pid> -f   (pid printed below)
# When launched from a zeromux PTY, THIS terminal also drops at `stop` — that is
# expected; reconnect and the service is already back up.
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
CURRENT_CGROUP="$(head -1 /proc/self/cgroup 2>/dev/null || true)"
if printf '%s' "$CURRENT_CGROUP" | grep -q "${SERVICE}.service"; then
  UNIT="zeromux-deploy-$$"
  echo ">> Inside ${SERVICE}.service cgroup — running swap as a detached systemd service so 'systemctl stop' can't kill it."
  echo ">> This terminal may drop when the service stops; the swap completes independently. Follow it with: journalctl -u ${UNIT} -f"
  exec sudo systemd-run --wait --collect --quiet --unit="${UNIT}" \
    bash "$SCRIPT_PATH" __swap__
fi

# Not in the zeromux cgroup (SSH / code-server / CI): swap directly.
do_swap "$BUILT"
exit $?
