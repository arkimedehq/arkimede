# runner/Dockerfile — image of the container-jobs (D2).
#
# Run by the broker, which launches it with `--entrypoint python3|node` + the
# script mounted in /skill. It is minimal on purpose: only the runtimes (python3 +
# node) and a non-root user. NO server, NO nix entrypoint — every job is ephemeral.
#
# Deps: the skill's `.deps` (pip/npm) are mounted with the skill dir on /skill;
# the broker sets PYTHONPATH=/skill/.deps/python and NODE_PATH=/skill/.deps/node/...
#
# Skills with SYSTEM dependencies (system.nix: ffmpeg, imagemagick, …): NO image
# variant is needed. The broker mounts the host's /nix store read-only on /nix and
# the executor puts /skill/.nix/bin in PATH (self-contained nix binaries). See
# README and SECURITY_HARDENING.md (BROKER_NIX_STORE).

FROM node:20-slim

# Python3 + pip. TYPED skills mount their own pre-installed `.deps` (no install at
# runtime), but the SANDBOX (arbitrary code with network=open) must be able to
# install packages at runtime in the persistent workspace: pip is needed (npm is
# already in the node base). The EXTERNALLY-MANAGED marker (PEP 668 on Debian) is
# removed so `pip install --user`/`--target` works without --break-system-packages.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ca-certificates \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -f /usr/lib/python3*/EXTERNALLY-MANAGED \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# global-agent: preloaded (NODE_OPTIONS -r) for node jobs under egress so http/https
# route through the egress proxy (Node ignores HTTP_PROXY natively; Python's urllib
# honors it). Installed world-readable in a fixed path; no writes at runtime.
RUN mkdir -p /opt/proxy && cd /opt/proxy \
    && npm init -y >/dev/null 2>&1 \
    && npm install global-agent@^3.0.0 --no-audit --no-fund --loglevel=error \
    && chmod -R a+rX /opt/proxy \
    && npm cache clean --force >/dev/null 2>&1 || true

# Non-root user (uid 999). The /work and /skill-state mounts are created
# world-writable by the executor; /skill is :ro (world-readable).
RUN groupadd -r -g 999 runner && useradd -r -u 999 -g runner -m -d /home/runner runner
USER runner

ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NO_COLOR=1

# The broker always overrides the entrypoint (python3|node). Harmless default CMD.
ENTRYPOINT []
CMD ["sh", "-c", "echo 'runner image: invoke via broker (--entrypoint python3|node)'"]
