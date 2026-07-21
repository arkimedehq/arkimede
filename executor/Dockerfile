# ─── Stage 1: build TypeScript ───────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /build

# Toolchain for the native modules (isolated-vm requires python3/make/g++).
# Only in the builder: the runtime receives the already-compiled node_modules.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --legacy-peer-deps

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Keep only the production dependencies (native ones already compiled above).
RUN npm prune --omit=dev

# ─── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# ── Base system tools ────────────────────────────────────────────────────────
# xz-utils and curl are required by the Nix installer.
# python3-venv is required by pip --target on some distributions.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    curl \
    xz-utils \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# python → python3 alias
RUN ln -sf /usr/bin/python3 /usr/bin/python

# ── Executor user ────────────────────────────────────────────────────────────
# Home directory and bash shell are needed for single-user Nix:
#   - ~/.nix-profile/ is created by the installer
#   - ~/.config/nix/nix.conf is written by the entrypoint
#   - ~/.nix-defexpr/ is used by nix-channel
RUN groupadd -r executor && \
    useradd -r -g executor -m -d /home/executor -s /bin/bash executor

# ── Mount point for the Nix volume ────────────────────────────────────────────
# /nix is mounted as a named volume in docker-compose to persist the Nix store
# across container rebuilds.
# The Nix installer requires /nix to be owned by the installing user.
RUN mkdir -p /nix && chown executor:executor /nix

# ── App ───────────────────────────────────────────────────────────────────────
WORKDIR /app

COPY package*.json ./
# Production node_modules already compiled in the builder (no build-tools in the runtime).
COPY --from=builder /build/node_modules ./node_modules

COPY --from=builder /build/dist ./dist

RUN mkdir -p /app/skills
RUN chown -R executor:executor /app /home/executor

# ── Entrypoint ────────────────────────────────────────────────────────────────
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# ── Environment variables ──────────────────────────────────────────────────────
USER executor

ENV USER=executor
ENV HOME=/home/executor
ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0
ENV SKILLS_BASE_PATH=/app/skills
ENV MAX_TIMEOUT_MS=30000
ENV MAX_OUTPUT_BYTES=524288
ENV MAX_CONCURRENT=5
ENV JS_MEMORY_LIMIT_MB=128
ENV INSTALL_TIMEOUT_MS=300000
ENV NIX_SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:4000/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
