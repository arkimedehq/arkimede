#!/usr/bin/env bash
#
# entrypoint.sh — starts Squid and acts as a watcher for the hot reload of the
# skill allowlist, WITHOUT any access to the Docker socket.
#
# Flow:
#   1. ensure the dynamic include file exists (Squid would fail the parse)
#   2. start Squid in the foreground (child process of this script)
#   3. poll the hash of the dynamic file; on every change send SIGHUP to Squid
#      (equivalent to `squid -k reconfigure`) → reloads the domains without downtime
#   4. forward SIGTERM/SIGINT to Squid for a clean shutdown
#
# The dynamic file is written by the backend (EgressSyncService) on the shared volume.
set -uo pipefail

CONF="/etc/squid/squid.conf"
DYN_DIR="/etc/squid/dynamic"
DYN_FILE="${DYN_DIR}/skill-domains.conf"
POLL_INTERVAL="${EGRESS_WATCH_INTERVAL:-2}"

log() { echo "[egress-entrypoint] $*"; }

# 1. The include file must exist BEFORE Squid starts (otherwise FATAL).
mkdir -p "${DYN_DIR}"
if [ ! -f "${DYN_FILE}" ]; then
  printf '# placeholder — will be overwritten by the backend (EgressSyncService)\n' > "${DYN_FILE}"
  log "created empty include file: ${DYN_FILE}"
fi

# Initialize any swap dirs (no-op without cache_dir). Non-blocking.
squid -f "${CONF}" -z 2>/dev/null || true
sleep 1

# 2. Start Squid in the foreground (-N) as a child: we know its PID.
squid -f "${CONF}" -N -d1 &
SQUID_PID=$!
log "Squid started (pid ${SQUID_PID})"

# 4. Clean shutdown: forward the signal to Squid and wait.
shutdown() {
  log "stop signal → shutting down Squid"
  kill -TERM "${SQUID_PID}" 2>/dev/null || true
  wait "${SQUID_PID}" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

hash_of() { md5sum "${DYN_FILE}" 2>/dev/null | awk '{print $1}'; }
last_hash="$(hash_of)"

# 3. Watch loop: hot reload when the file changes; exit if Squid dies.
while kill -0 "${SQUID_PID}" 2>/dev/null; do
  sleep "${POLL_INTERVAL}"
  cur_hash="$(hash_of)"
  if [ -n "${cur_hash}" ] && [ "${cur_hash}" != "${last_hash}" ]; then
    log "skill-domains.conf changed → reconfigure (SIGHUP)"
    if kill -HUP "${SQUID_PID}" 2>/dev/null; then
      last_hash="${cur_hash}"
    else
      log "SIGHUP failed — Squid no longer running?"
    fi
  fi
done

log "Squid terminated — exiting"
wait "${SQUID_PID}" 2>/dev/null || true
exit 1
