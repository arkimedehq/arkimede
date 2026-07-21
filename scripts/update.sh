#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

# update.sh — upgrade an existing Arkimede deployment to the latest source.
#
# install.sh brings the stack up from whatever is already in the working tree;
# it does NOT fetch new code. This script is the counterpart for an existing
# deployment: it pulls, rebuilds, and restarts, preserving your data and config.
#
# What it does, in order:
#   1. Backs up the data (scripts/backup.sh) unless --no-backup.
#   2. git pull --ff-only  (new code; refuses if your tree has local changes).
#   3. Flags any NEW variables that appeared in .env.example (your .env is never
#      auto-edited — secrets/values are yours to fill in).
#   4. Rebuilds the broker job images (pa-runner / pa-egress-proxy) IF your profile
#      uses them AND runner/ or egress-proxy/ changed in the pull — `up --build`
#      alone never rebuilds these (they are referenced by image name, not build:).
#   5. docker compose up -d --build  (backend/frontend/etc.; DB migrations run
#      automatically on backend boot — migrationsRun: true).
#   6. Health-checks the result.
#
# Volumes (Postgres, uploads, skills, Qdrant) persist across the rebuild, and
# .env / scripts/compose.sh / .compose-profile are gitignored, so `git pull`
# never touches them.
#
# Usage:
#   ./scripts/update.sh                 # backup, pull, rebuild, restart (asks to confirm)
#   ./scripts/update.sh --yes           # no confirmation prompt
#   ./scripts/update.sh --no-backup     # skip the backup step (not recommended)
set -euo pipefail

# ── Styling (matches install.sh) ─────────────────────────────────────────────
if [[ -t 1 ]]; then B=$'\e[1m'; DIM=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=; DIM=; G=; Y=; R=; C=; N=; fi
step() { echo; echo "${B}${C}▸ $*${N}"; }
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}⚠${N} $*"; }
err()  { echo "  ${R}✗${N} $*" >&2; }

# ── Args ──────────────────────────────────────────────────────────────────────
DO_BACKUP=1; ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --no-backup) DO_BACKUP=0 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    -h|--help)   echo "Usage: $0 [--yes] [--no-backup]"; exit 0 ;;
    *) err "unknown argument: $a (use --help)"; exit 1 ;;
  esac
done

# ── Position at the repo root ─────────────────────────────────────────────────
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "${B}╭───────────────────────────────────────────────╮${N}"
echo "${B}│   Arkimede · update an existing deployment   │${N}"
echo "${B}╰───────────────────────────────────────────────╯${N}"

# ── Preflight ─────────────────────────────────────────────────────────────────
step "Preflight"
command -v docker >/dev/null 2>&1 || { err "docker not installed."; exit 1; }
docker compose version >/dev/null 2>&1 || { err "Docker Compose v2 is required."; exit 1; }
command -v git >/dev/null 2>&1 || { err "git not installed."; exit 1; }
[[ -d .git ]] || { err "not a git checkout — this deployment was not cloned with git, so it cannot self-update. Re-clone with 'git clone', or update the files manually and run ./scripts/install.sh."; exit 1; }
[[ -f .env ]] || { err ".env not found — run ./scripts/install.sh first."; exit 1; }
ok "git checkout, .env present, docker + compose ok"

# The working tree must be clean, or git pull --ff-only will refuse / conflict.
if ! git diff --quiet || ! git diff --cached --quiet; then
  err "you have local changes to tracked files. Commit or stash them first:"
  git status --short | grep -vE '^\?\?' | sed 's/^/      /'
  exit 1
fi
ok "working tree clean (untracked files are fine)"

# ── Compose profile → which overlays (and therefore which broker images) ──────
if [[ -f scripts/.compose-profile ]]; then
  source scripts/.compose-profile
  ok "using the profile install.sh generated"
else
  COMPOSE_ARGS=(-f docker-compose.yml)
  warn "scripts/.compose-profile missing — assuming the base compose only. If you run the broker/egress overlays, re-run ./scripts/install.sh instead."
fi
USES_BROKER=0; USES_EGRESS=0
for f in "${COMPOSE_ARGS[@]}"; do
  [[ "$f" == *broker* ]] && USES_BROKER=1
  [[ "$f" == *egress* ]] && USES_EGRESS=1
done
dc() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

# ── Confirm ───────────────────────────────────────────────────────────────────
echo
echo "  ${DIM}This will: back up → git pull → rebuild → restart. Data volumes are preserved.${N}"
if (( ! ASSUME_YES )); then
  read -rp "  ${B}Proceed?${N} [Y/n]: " ans; ans="${ans:-Y}"
  [[ "$ans" =~ ^[YySs]$ ]] || { warn "aborted."; exit 0; }
fi

# ── 1. Backup ─────────────────────────────────────────────────────────────────
if (( DO_BACKUP )); then
  step "Backup"
  bash "$ROOT/scripts/backup.sh" || { err "backup failed — aborting before touching anything."; exit 1; }
else
  warn "skipping backup (--no-backup)"
fi

# ── 2. Pull ───────────────────────────────────────────────────────────────────
step "Fetch new code (git pull --ff-only)"
PRE="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git pull --ff-only || { err "git pull failed (diverged history?). Resolve manually, then re-run."; exit 1; }
POST="$(git rev-parse HEAD)"
if [[ "$PRE" == "$POST" ]]; then
  ok "already up to date ($BRANCH @ ${POST:0:8}) — will still rebuild/restart"
else
  ok "updated $BRANCH: ${PRE:0:8} → ${POST:0:8}"
  echo "${DIM}$(git log --oneline "$PRE..$POST" | head -12 | sed 's/^/    /')${N}"
fi

# ── 3. New .env keys (informational — never auto-edited) ──────────────────────
step "Config drift (.env vs .env.example)"
if [[ -f .env.example ]]; then
  missing="$(comm -23 \
    <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env.example | sort -u) \
    <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env         | sort -u) || true)"
  if [[ -n "$missing" ]]; then
    warn "new variable(s) in .env.example not present in your .env:"
    echo "$missing" | sed 's/=$//; s/^/      · /'
    warn "add the ones you need to .env before the backend restarts (it may fail-fast on a required one)."
  else
    ok "no new variables"
  fi
else
  warn ".env.example missing — cannot diff"
fi

# ── 4. Rebuild broker images only if used AND their source changed ────────────
if (( USES_BROKER || USES_EGRESS )); then
  step "Broker job images"
  if [[ "$PRE" == "$POST" ]]; then
    ok "no code change → broker images unchanged"
  else
    if (( USES_BROKER )) && ! git diff --quiet "$PRE" "$POST" -- runner; then
      echo "  runner/ changed → rebuilding pa-runner…"; docker build -t pa-runner ./runner >/dev/null && ok "pa-runner rebuilt"
    elif (( USES_BROKER )); then ok "runner/ unchanged → pa-runner kept"; fi
    if (( USES_EGRESS )) && ! git diff --quiet "$PRE" "$POST" -- egress-proxy; then
      echo "  egress-proxy/ changed → rebuilding pa-egress-proxy…"; docker build -t pa-egress-proxy ./egress-proxy >/dev/null && ok "pa-egress-proxy rebuilt"
    elif (( USES_EGRESS )); then ok "egress-proxy/ unchanged → pa-egress-proxy kept"; fi
  fi
fi

# ── 5. Rebuild + restart (migrations auto-run on backend boot) ────────────────
step "Rebuild and restart the stack"
dc up -d --build
ok "stack up (DB migrations apply automatically on backend boot)"

# ── 6. Health check ───────────────────────────────────────────────────────────
step "Health check"
up=0
for i in $(seq 1 60); do
  hb=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/health --max-time 3 2>/dev/null || true)
  if [[ "$hb" == "200" ]]; then up=1; break; fi
  sleep 5
done
if (( up )); then
  ok "backend /api/health → 200 (after $((i*5))s)"
else
  err "backend did not report healthy within 300s. Check the logs:"
  echo "      ./scripts/compose.sh logs -f backend"
  exit 1
fi

echo
echo "${B}${G}Update complete.${N}  (${BRANCH} @ ${POST:0:8})"
echo "  Status: ${C}./scripts/compose.sh ps${N}"
echo "  Logs:   ${C}./scripts/compose.sh logs -f${N}"
