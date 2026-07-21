#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright © 2026 Andrea Genovese

# install.sh — guided installer for the containerized startup of Arkimede.
#
# Walks step-by-step through: Docker preflight → secrets → SECURITY LEVEL →
# build required images → bootstrap dirs → `docker compose up`. Idempotent:
# re-running it is safe (it re-reads the .env, does not duplicate the keys).
#
# Usage:
#   ./scripts/install.sh
#
# Non-destructive: it backs up the .env before touching it (.env.bak-<ts>).
set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    -h|--help) echo "Usage: $0 [--dry-run]  (--dry-run: shows the choices without writing/building/starting)"; exit 0 ;;
    *) echo "unknown argument: $a (use --help)"; exit 1 ;;
  esac
done

# ── Minimal styling ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then B=$'\e[1m'; DIM=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B=; DIM=; G=; Y=; R=; C=; N=; fi
step() { echo; echo "${B}${C}▸ $*${N}"; }
ok()   { echo "  ${G}✓${N} $*"; }
warn() { echo "  ${Y}⚠${N} $*"; }
err()  { echo "  ${R}✗${N} $*" >&2; }
ask()  { # ask "question" "default" → echo answer
  local q="$1" def="${2:-}" ans
  if [[ -n "$def" ]]; then read -rp "  ${B}$q${N} [${def}]: " ans; echo "${ans:-$def}"
  else read -rp "  ${B}$q${N}: " ans; echo "$ans"; fi
}
yesno() { # yesno "question" "Y|N" → returns 0 for yes
  local q="$1" def="${2:-Y}" ans
  read -rp "  ${B}$q${N} [$([[ $def == Y ]] && echo 'Y/n' || echo 'y/N')]: " ans
  ans="${ans:-$def}"; [[ "$ans" =~ ^[YySsì]+$ ]]
}

# ── Positioning: must run from the repo root ──────────────────────────────────
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
[[ -f docker-compose.yml ]] || { err "docker-compose.yml not found in $ROOT — run it from the repo root."; exit 1; }
ENV_FILE="$ROOT/.env"

echo "${B}╭───────────────────────────────────────────────╮${N}"
echo "${B}│   Arkimede · containerized installer   │${N}"
echo "${B}╰───────────────────────────────────────────────╯${N}"

# ── 1. Preflight ──────────────────────────────────────────────────────────────
step "1/6 · Preflight"
command -v docker >/dev/null 2>&1 || { err "docker not installed."; exit 1; }
docker compose version >/dev/null 2>&1 || { err "Docker Compose v2 ('docker compose') is required."; exit 1; }
docker info >/dev/null 2>&1 || { err "the Docker daemon is not responding — start Docker and retry."; exit 1; }
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) · compose v2 · daemon active"

GVISOR_OK=0
if docker info --format '{{range $r,$_ := .Runtimes}}{{$r}} {{end}}' 2>/dev/null | grep -qw runsc; then GVISOR_OK=1; ok "gVisor runtime (runsc) available"; fi

# ── .env helper: update or append KEY=VALUE preserving the rest ───────────────
set_env() {
  local key="$1" val="$2"
  if (( DRY )); then echo "  ${DIM}[dry-run] .env: ${key}=${val}${N}"; return 0; fi
  if grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # '|' delimiter (avoids '/' in paths); escape \, & and | in the replacement so
    # complex values (e.g. the SKILL_NETWORK_CATALOG JSON) are written verbatim.
    local esc; esc="$(printf '%s' "$val" | sed 's/[\\&|]/\\&/g')"
    sed -i.tmp "s|^${key}=.*|${key}=${esc}|" "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | xargs || true; }
gen_secret() { openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# ── 2. .env + secrets ─────────────────────────────────────────────────────────
step "2/6 · Configuration and secrets (.env)"
(( DRY )) && warn "--dry-run mode: no writes to .env, no build, no startup."
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$ROOT/.env.example" ]]; then
    warn ".env missing: seeding it from .env.example (every variable with its documented default)."
    (( DRY )) || cp "$ROOT/.env.example" "$ENV_FILE"
  else
    warn ".env missing: creating a new one."
    (( DRY )) || : > "$ENV_FILE"
  fi
elif (( ! DRY )); then
  cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
  ok ".env backup created"
fi

# Environment: dev (exposes the internal ports + dev db password) or prod.
if yesno "PRODUCTION installation? (no = development, exposes the internal ports)" "Y"; then
  IS_PROD=1; ok "production mode"
else
  IS_PROD=0; warn "development mode: the override exposes postgres/redis/qdrant to the host"
fi

# Secrets: in prod they must be strong. Regenerate if weak or on request.
# JWT_SECRET and TOOL_SECRETS_KEY are required by the backend fail-fast on boot
# (min 32 chars / 64 hex); gen_secret = `openssl rand -hex 32` = 64 hex satisfies both.
weak() { local v; v="$(get_env "$1")"; [[ -z "$v" || "$v" == "password" || "$v" == "postgres" || "$v" == "changeme" || ${#v} -lt 16 ]]; }
for key in JWT_SECRET TOOL_SECRETS_KEY RUN_TOKEN_SECRET SERVICE_API_KEY; do
  if weak "$key"; then set_env "$key" "$(gen_secret)"; ok "$key generated (was missing/weak)";
  elif (( IS_PROD )) && yesno "Regenerate $key? (will invalidate in-progress tokens/sessions)" "N"; then
    set_env "$key" "$(gen_secret)"; ok "$key regenerated"
  else ok "$key kept"; fi
done
# Upload size cap (nginx client_max_body_size + backend Multer), in MB.
# Asked interactively; default = current value (or 50 on fresh installs), so
# re-running the installer with Enter keeps the existing setting.
cur_up="$(get_env MAX_UPLOAD_MB)"
up_mb="$(ask "Max upload size in MB (file uploads via API/UI)" "${cur_up:-50}")"
if [[ "$up_mb" =~ ^[0-9]+$ ]] && (( up_mb > 0 )); then
  set_env MAX_UPLOAD_MB "$up_mb"; ok "MAX_UPLOAD_MB=${up_mb} MB"
else
  warn "invalid value \"$up_mb\": keeping ${cur_up:-50} MB"
  set_env MAX_UPLOAD_MB "${cur_up:-50}"
fi

# Embedding device. It is ALSO a build-arg: on 'cpu' the image is built from the CPU-only
# torch index, without the NVIDIA CUDA wheels (> 2 GB, ~3x the image size) that a machine
# with no NVIDIA GPU would never use. 'cuda' requires an NVIDIA GPU exposed to Docker.
cur_dev="$(get_env EMBEDDING_DEVICE)"
emb_dev="$(ask "Embedding device — cpu | cuda (cuda needs an NVIDIA GPU on this host)" "${cur_dev:-cpu}")"
case "$emb_dev" in
  cpu)  set_env EMBEDDING_DEVICE cpu;  ok "EMBEDDING_DEVICE=cpu (image built without the CUDA wheels)" ;;
  cuda) set_env EMBEDDING_DEVICE cuda; warn "EMBEDDING_DEVICE=cuda — the image will include the CUDA stack (bigger, slower to build); make sure the GPU is visible to Docker" ;;
  *)    warn "invalid value \"$emb_dev\": keeping ${cur_dev:-cpu}"; set_env EMBEDDING_DEVICE "${cur_dev:-cpu}" ;;
esac

if (( IS_PROD )); then
  if weak DB_PASSWORD; then
    if yesno "DB_PASSWORD is weak/missing: generate a strong one?" "Y"; then
      set_env DB_PASSWORD "$(gen_secret | cut -c1-32)"; ok "DB_PASSWORD generated"
    else warn "leaving DB_PASSWORD unchanged — postgres won't start in prod if empty"; fi
  else ok "DB_PASSWORD present"; fi

  # FRONTEND_URL: required in prod (the backend refuses CORS "*" with credentials).
  # Default to the local frontend; for a real deployment enter your public origin(s),
  # comma-separated (e.g. https://arkimede.example.com).
  cur_fe="$(get_env FRONTEND_URL)"
  fe_url="$(ask "Public frontend URL(s) for CORS (comma-separated)" "${cur_fe:-http://localhost:5173}")"
  set_env FRONTEND_URL "$fe_url"; ok "FRONTEND_URL set ($fe_url)"
fi

# ── 3. Security level (the heart of the installer) ────────────────────────────
step "3/6 · Security level of skill/sandbox execution"
cat <<EOF
  Skills and the sandbox run code. Choose how much to isolate them:

    ${B}1) Standard${N}      ${DIM}— base compose. Skills run IN-PROCESS in the
                     skill-executor container (already hardened: cap-drop ALL,
                     no-new-priv, pids/mem limits). Free egress. Lighter.${N}

    ${B}2) Isolated${N}      ${DIM}— + broker: every execution is an ephemeral,
                     hardened CONTAINER (read-only rootfs, non-root uid; jobs reach
                     the backend on arkimede-internal, no internet). Recommended.${N}

    ${B}3) Maximum${N}       ${DIM}— + egress allowlist: like Isolated, but when a job
                     needs the network it goes through a proxy that allows ONLY the
                     domains in the allowlist. + optional gVisor.${N}
EOF
LEVEL="$(ask "Level [1/2/3]" "2")"
case "$LEVEL" in 1|2|3) ;; *) warn "invalid value, using 2"; LEVEL=2;; esac

# Fixed compose project name → containers/volumes are `arkimede-*`, not derived from
# the working-directory name (which is still `personalAgent`). `-p` is a global option,
# so prepending it here propagates to every `docker compose` call AND the generated
# scripts/compose.sh wrapper (which reuses this array).
PROJECT_NAME="arkimede"
COMPOSE_FILES=("-p" "$PROJECT_NAME" "-f" "docker-compose.yml")
(( IS_PROD )) || COMPOSE_FILES+=("-f" "docker-compose.override.yml")
NEED_RUNNER=0; NEED_EGRESS=0

if [[ "$LEVEL" == "1" ]]; then
  ok "Level 1 · Standard (in-process)"
  set_env BROKER_URL ""   # empty → executor uses the in-process runners
  if yesno "Enable the sandbox tool (arbitrary code execution, NOT isolated in L1)?" "N"; then
    set_env SANDBOX_ALLOW_INPROCESS 1; warn "in-process sandbox active: code not confined, only if you trust the context"
  else
    set_env SANDBOX_ALLOW_INPROCESS 0; ok "sandbox disabled (fail-closed)"
  fi
else
  # L2 / L3 share the broker
  NEED_RUNNER=1
  COMPOSE_FILES+=("-f" "docker-compose.broker.yml")
  set_env SANDBOX_ALLOW_INPROCESS 0   # with the broker the in-process one is never needed

  # HOST_DATA_DIR: host==container invariant (see bootstrap-broker.sh)
  # Fall back to an OS-appropriate ABSOLUTE default when the seeded value is empty OR
  # relative (e.g. the `./data` example) — otherwise the absolute-path guard below would
  # reject a freshly-seeded .env and abort the install.
  def_host="$(get_env HOST_DATA_DIR)"
  if [[ -z "$def_host" || "$def_host" != /* ]]; then
    case "$(uname -s)" in Darwin) def_host="$HOME/arkimede-data";; *) def_host="/srv/arkimede/data";; esac
  fi
  HOST_DATA_DIR="$(ask "Host path of the shared data (HOST_DATA_DIR)" "$def_host")"
  [[ "$HOST_DATA_DIR" == /* ]] || { err "HOST_DATA_DIR must be absolute."; exit 1; }
  set_env HOST_DATA_DIR "$HOST_DATA_DIR"

  if (( GVISOR_OK )) && yesno "Use gVisor (runsc) for even stronger kernel isolation?" "N"; then
    set_env BROKER_ALLOW_RUNSC 1; set_env JOB_RUNTIME runsc; ok "gVisor active for the jobs"
  else
    set_env BROKER_ALLOW_RUNSC 0; set_env JOB_RUNTIME runc
  fi

  # Operator opt-in for the sandbox 'trusted' profile (writable rootfs + root + default caps →
  # the code can apt-get system libraries at runtime). Weakens isolation: only sensible on a
  # trusted single-tenant deploy or under gVisor. The admin still selects it in Settings → Sandbox.
  echo
  echo "  ${DIM}The sandbox 'trusted' profile lets user code run as root on a writable rootfs${N}"
  echo "  ${DIM}(install system libraries at runtime). It weakens isolation — recommended only${N}"
  echo "  ${DIM}for a trusted single-tenant deploy or with gVisor enabled.${N}"
  if yesno "Allow the sandbox 'trusted' profile on this broker (BROKER_ALLOW_PRIVILEGED_SANDBOX)?" "N"; then
    set_env BROKER_ALLOW_PRIVILEGED_SANDBOX 1; warn "trusted sandbox profile ALLOWED — admins can enable it in the app"
  else
    set_env BROKER_ALLOW_PRIVILEGED_SANDBOX 0; ok "trusted sandbox profile disabled (broker forces hardened)"
  fi

  if [[ "$LEVEL" == "3" ]]; then
    NEED_EGRESS=1
    COMPOSE_FILES+=("-f" "docker-compose.egress.yml")
    set_env BROKER_ALLOWED_NETWORKS "sandboxnet"
    set_env JOB_EGRESS_NETWORK "sandboxnet"
    ok "Level 3 · Maximum (broker + egress allowlist on 'sandboxnet')"
    warn "allowed domains are managed from the app (skill allowlist) → squid hot-reloads"
  else
    ok "Level 2 · Isolated (broker; jobs reach the backend on arkimede-internal, no internet)"
  fi

  # The per-run network TIER is a separate, admin-controlled choice (not set here):
  echo
  echo "  ${DIM}Network tiers (none | internal | internet | open) — same vocabulary for skills and sandbox:${N}"
  echo "  ${DIM}  · skills get 'internet' automatically when they declare domains (runtime.network);${N}"
  echo "  ${DIM}  · the sandbox tool's tier is an admin setting in the app (Settings → Sandbox).${N}"
  echo "  ${DIM}'internal' (backend only) is the always-on floor; 'internet' uses the allowlist above;${N}"
  echo "  ${DIM}'open' uses the full-internet network (default 'bridge', auto-allowed in the broker).${N}"

  # ── Reserved networks (Phase 3) ────────────────────────────────────────────
  # Baseline 'arkimede-internal' (backend, no-WAN) is ALWAYS on. Here we optionally
  # grant skills access to EXISTING docker networks (LAN/VPN/subnet): the broker
  # multi-homes the jobs onto them in addition to the baseline.
  echo
  echo "  ${DIM}Baseline: every skill job reaches the backend on 'arkimede-internal' (no internet).${N}"
  if yesno "Grant skills access to additional existing networks (LAN/VPN/subnet)?" "N"; then
    jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }   # JSON-escape \ and "
    entries=""; allowed_extra=""; global_extra=""
    while true; do
      net="$(ask "Docker network name (empty = finish)" "")"
      [[ -z "$net" ]] && break
      docker network inspect "$net" >/dev/null 2>&1 || warn "network '$net' not found yet — create it before starting, or the broker will reject it"
      label="$(ask "  Human label" "$net")"
      desc="$(ask "  Short description (optional)" "")"
      nid="$(printf '%s' "$net" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-')"
      kind="custom"; if yesno "  Is '$net' a corporate LAN/VPN (shows a LAN badge)?" "Y"; then kind="lan"; fi
      entries="${entries:+$entries,}{\"id\":\"$(jesc "$nid")\",\"dockerNetwork\":\"$(jesc "$net")\",\"label\":\"$(jesc "$label")\",\"description\":\"$(jesc "$desc")\",\"kind\":\"$kind\"}"
      allowed_extra="${allowed_extra:+$allowed_extra,}$net"
      if yesno "  Attach '$net' to ALL skills automatically (global), instead of per-skill grant?" "N"; then
        global_extra="${global_extra:+$global_extra,}$net"
      fi
      ok "added '$net'"
    done
    if [[ -n "$entries" ]]; then
      set_env SKILL_NETWORK_CATALOG "[$entries]"
      cur_allowed="$(get_env BROKER_ALLOWED_NETWORKS)"
      set_env BROKER_ALLOWED_NETWORKS "$(printf '%s' "${cur_allowed:+$cur_allowed,}$allowed_extra" | sed 's/^,//;s/,$//')"
      [[ -n "$global_extra" ]] && set_env BROKER_GLOBAL_NETWORKS "$global_extra"
      ok "reserved networks configured (catalog + broker allowlist)"
      warn "grant them per-skill from Settings → Skills → (skill) → Reserved networks"
    fi
  fi
fi

# ── 4. Build required images ──────────────────────────────────────────────────
step "4/6 · Build images"
if (( NEED_RUNNER )); then
  if (( DRY )); then echo "  ${DIM}[dry-run] docker build -t pa-runner ./runner${N}"
  else echo "  building pa-runner (image of the container-jobs)…"; docker build -t pa-runner ./runner >/dev/null && ok "pa-runner ready"; fi
fi
if (( NEED_EGRESS )); then
  if (( DRY )); then echo "  ${DIM}[dry-run] docker build -t pa-egress-proxy ./egress-proxy${N}"
  else echo "  building pa-egress-proxy…"; docker build -t pa-egress-proxy ./egress-proxy >/dev/null && ok "pa-egress-proxy ready"; fi
fi
(( NEED_RUNNER || NEED_EGRESS )) || ok "no extra image required by this level"

# ── 5. Bootstrap shared dirs (broker only) ────────────────────────────────────
step "5/6 · Filesystem preparation"
if (( NEED_RUNNER )); then
  if (( DRY )); then echo "  ${DIM}[dry-run] HOST_DATA_DIR=$HOST_DATA_DIR bash scripts/bootstrap-broker.sh${N}"
  else HOST_DATA_DIR="$HOST_DATA_DIR" bash "$ROOT/scripts/bootstrap-broker.sh"; fi
else
  ok "no host dir to prepare (in-process execution)"
fi

# ── 6. Start the stack ────────────────────────────────────────────────────────
step "6/6 · Starting the containers"
echo "  ${DIM}docker compose ${COMPOSE_FILES[*]} up -d --build${N}"
if (( DRY )); then
  warn "[dry-run] startup not executed."
elif yesno "Start the stack now?" "Y"; then
  docker compose "${COMPOSE_FILES[@]}" up -d --build
  echo
  docker compose "${COMPOSE_FILES[@]}" ps
else
  warn "startup skipped."
fi

# ── Persistence of the chosen profile: wrapper for future up/down/logs ────────
if (( DRY )); then
  echo "  ${DIM}[dry-run] would generate scripts/compose.sh + scripts/.compose-profile for: ${COMPOSE_FILES[*]}${N}"
  echo; echo "${B}${Y}Dry-run completed (level $LEVEL). No changes applied.${N}"
  exit 0
fi
{
  echo "# Generated by install.sh — compose chain of the chosen profile (level $LEVEL)."
  printf 'COMPOSE_ARGS=('
  printf '%q ' "${COMPOSE_FILES[@]}"
  echo ')'
} > "$ROOT/scripts/.compose-profile"

cat > "$ROOT/scripts/compose.sh" <<'WRAP'
#!/usr/bin/env bash
# compose.sh — wrapper: uses the file chain chosen by the installer.
#   ./scripts/compose.sh logs -f backend
#   ./scripts/compose.sh down
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/.compose-profile
exec docker compose "${COMPOSE_ARGS[@]}" "$@"
WRAP
chmod +x "$ROOT/scripts/compose.sh"

echo
echo "${B}${G}Installation completed (level $LEVEL).${N}"
echo "  Frontend:   ${C}http://localhost:5173${N}"
echo "  Management: ${C}./scripts/compose.sh ps | logs -f | down${N}"
(( LEVEL == 1 )) || echo "  Job data:   ${C}${HOST_DATA_DIR}${N}"
