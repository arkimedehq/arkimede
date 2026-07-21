#!/usr/bin/env bash
# bootstrap-broker.sh — prepares HOST_DATA_DIR for the broker mode (container-per-job).
#
# The sandbox/skill jobs run as "sibling" containers with a non-root uid (999) and
# a read-only rootfs: they write ONLY into the mounts. So the writable subfolders
# must exist AND be world-writable BEFORE the `up`, otherwise the jobs fail
# silently (the deliverable is not written).
#
# Usage:
#   ./scripts/bootstrap-broker.sh                 # reads HOST_DATA_DIR from .env
#   HOST_DATA_DIR=/srv/pa/data ./scripts/bootstrap-broker.sh
#
# Then:
#   docker build -t pa-runner ./runner
#   docker compose -f docker-compose.yml -f docker-compose.broker.yml up -d
set -euo pipefail

# Load HOST_DATA_DIR from .env if not passed in the environment.
if [[ -z "${HOST_DATA_DIR:-}" && -f .env ]]; then
  HOST_DATA_DIR="$(grep -E '^HOST_DATA_DIR=' .env | tail -1 | cut -d= -f2- | tr -d '"' | xargs || true)"
fi

if [[ -z "${HOST_DATA_DIR:-}" ]]; then
  echo "✗ HOST_DATA_DIR not set (neither in the environment nor in .env)." >&2
  exit 1
fi
if [[ "$HOST_DATA_DIR" != /* ]]; then
  echo "✗ HOST_DATA_DIR must be an ABSOLUTE path (it is: $HOST_DATA_DIR)." >&2
  exit 1
fi

echo "→ HOST_DATA_DIR = $HOST_DATA_DIR"

# skills: read-only for the jobs (:ro) → no 0777.
# work/state/skills-output/sandbox: writable by the jobs (uid 999) → 0777.
mkdir -p "$HOST_DATA_DIR"/{skills,work,state,skills-output,sandbox}
chmod 0777 "$HOST_DATA_DIR"/{work,state,skills-output,sandbox}

echo "✓ subfolders ready:"
ls -ld "$HOST_DATA_DIR"/{skills,work,state,skills-output,sandbox}

# pa-runner: image of the container-jobs. Without it, every broker job fails.
if ! docker image inspect pa-runner >/dev/null 2>&1; then
  echo "⚠ pa-runner image missing — build it with:  docker build -t pa-runner ./runner"
else
  echo "✓ pa-runner image present"
fi

echo "Ready. Isolated startup:"
echo "  docker compose -f docker-compose.yml -f docker-compose.broker.yml up -d"
