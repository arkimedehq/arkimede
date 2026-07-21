#!/bin/bash
# ─── docker-entrypoint.sh ─────────────────────────────────────────────────────
#
# Initializes Nix on the /nix volume at the container's first startup, then
# launches the main process (node dist/main.js).
#
# The /nix volume persists across restarts and image rebuilds: the packages
# installed by the skills are not lost when the container is recreated.
#
# Flow:
#   1. If /nix/.nix-ready does not exist → first startup → install single-user Nix
#   2. Configure experimental-features (nix-command, flakes) in ~/.config/nix/nix.conf
#   3. Source the Nix profile to export PATH to the child node process
#   4. exec "$@"  →  node dist/main.js (or whatever CMD is passed)
#
set -euo pipefail

NIX_READY_FLAG="/nix/.nix-ready"
NIX_PROFILE_SCRIPT="$HOME/.nix-profile/etc/profile.d/nix.sh"

# ── 1. Nix installation (only at first startup with a fresh volume) ───────────
if [ ! -f "$NIX_READY_FLAG" ]; then
  echo "[entrypoint] /nix volume empty — installing single-user Nix..."

  curl -sSL https://nixos.org/nix/install | sh -s -- --no-daemon --no-channel-add

  # Source it right away to have `nix` in the current PATH
  if [ -f "$NIX_PROFILE_SCRIPT" ]; then
    # shellcheck disable=SC1090
    . "$NIX_PROFILE_SCRIPT"
  fi

  # Configure nixpkgs unstable as the main channel
  nix-channel --add https://nixos.org/channels/nixpkgs-unstable nixpkgs
  nix-channel --update

  echo "[entrypoint] Nix installed successfully."
  touch "$NIX_READY_FLAG"
else
  echo "[entrypoint] Nix already installed — sourcing profile..."
  if [ -f "$NIX_PROFILE_SCRIPT" ]; then
    # shellcheck disable=SC1090
    . "$NIX_PROFILE_SCRIPT" 2>/dev/null || true
  fi
fi

# ── 2. Nix configuration (nix-command + flakes, idempotent) ───────────────────
NIX_CONF_DIR="$HOME/.config/nix"
NIX_CONF_FILE="$NIX_CONF_DIR/nix.conf"
mkdir -p "$NIX_CONF_DIR"

if ! grep -q "experimental-features" "$NIX_CONF_FILE" 2>/dev/null; then
  echo "experimental-features = nix-command flakes" >> "$NIX_CONF_FILE"
  echo "[entrypoint] experimental-features enabled in $NIX_CONF_FILE"
fi

# ── 3. Export PATH with Nix for the child process ─────────────────────────────
NIX_PROFILE_BIN="$HOME/.nix-profile/bin"
if [ -d "$NIX_PROFILE_BIN" ]; then
  export PATH="$NIX_PROFILE_BIN:$PATH"
fi

# Fallback for container RECREATE: the /nix store is a persistent volume, but the
# ~/.nix-profile symlink lives in HOME (the container filesystem) and is lost when the
# container is recreated (image rebuild / `up` with a new container). Since /nix/.nix-ready
# exists, step 1 skips reinstall — leaving `nix` off PATH and system.nix skills silently
# skipped. Recover by putting the persistent store's nix binary directly on PATH.
if ! command -v nix >/dev/null 2>&1; then
  NIX_STORE_BIN="$(ls -d /nix/store/*-nix-[0-9]*/bin 2>/dev/null | sort | tail -1)"
  if [ -n "$NIX_STORE_BIN" ] && [ -x "$NIX_STORE_BIN/nix" ]; then
    export PATH="$NIX_STORE_BIN:$PATH"
    echo "[entrypoint] nix restored from persistent store: $NIX_STORE_BIN"
  fi
fi

echo "[entrypoint] PATH: $PATH"
echo "[entrypoint] Starting: $*"

# ── 4. Launch the main process ────────────────────────────────────────────────
exec "$@"
