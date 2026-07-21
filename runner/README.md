# Runner image (D2)

**Minimal** image for the container-jobs: the broker launches it for every skill
execution (`--entrypoint python3|node` + the script mounted in `/skill`).

## Why it is separate from the executor
- **Lighter** (~382MB vs ~540MB for the executor) and a smaller surface per job.
- **No server, no nix entrypoint**: each job is ephemeral and hardened.
- Separates the "executor service" role from the "runtime of a single job" role.

## What it contains
- `node:20-slim` + `python3` (no pip: dependencies are pre-installed and mounted).
- Non-root user `runner` (uid 999).
- The skill's `.deps` (pip/npm) arrive mounted with the skill dir on `/skill`;
  the broker sets `PYTHONPATH=/skill/.deps/python`, `NODE_PATH=/skill/.deps/node/...`.

## Build & usage
```bash
docker build -t pa-runner ./runner
# the broker uses it via:
BROKER_RUNNER_IMAGE=pa-runner
```

## Dependencies: pip, npm and nix (all cases covered)
The runner does **not** install packages at runtime. The three families of deps arrive
as follows:
- **pip** → `.deps/python` mounted with the skill on `/skill`; the broker sets
  `PYTHONPATH=/skill/.deps/python`.
- **npm** → `.deps/node/node_modules` mounted on `/skill`; `NODE_PATH=/skill/.deps/node/node_modules`.
- **nix** (`system.nix`: ffmpeg, imagemagick, …) → the installer creates the profile
  `{skillDir}/.nix/bin` (symlinks into `/nix/store`). The broker, if the skill has
  `.nix/bin`, mounts the entire **host Nix store `read-only` on `/nix`** and
  the executor puts `/skill/.nix/bin` at the front of the `PATH`. The nix binaries are
  self-contained in the `/nix/store`, so **there is no need to install them in the
  image**: the mount is enough. No variant of the runner image is needed.

Broker config for nix:
```bash
BROKER_NIX_STORE=/nix   # host path of the Nix store (mounted /nix:ro in nix jobs)
```
If a skill requires nix but `BROKER_NIX_STORE` is not configured, the job
**fails closed** (400) instead of running without the expected tools.

## Verification
Tested via the broker: **python** and **node** jobs ran correctly in the image
(non-root uid 999, input via stdin, output captured). **nix**: simulated a host
`/nix/store` with a binary + a skill profile `.nix/bin` → the job resolves it
via `PATH`, dereferences the symlink in the `/nix:ro` mount and runs (rc=0); without
`BROKER_NIX_STORE` the nix job is rejected fail-closed (400).
