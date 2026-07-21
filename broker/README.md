# Job-launcher broker (D2)

Component that launches the **hardened ephemeral container-jobs** for skill execution
(D2). It is the **only** component that talks to the Docker daemon (socket): for this
reason it is minimal (pure Node, zero dependencies), internal-only, with a **narrow
API**.

## Why it exists
Giving out the Docker socket = root on the host. Instead of giving it to the executor
(close to untrusted code) or to the backend (large, internet-facing), it is isolated in
this broker: it exposes only `POST /run-job` with high-level parameters and builds a
`docker run` with **hardcoded hardening** flags. A compromised caller can only "run this
hardened job", **not** "create a container with --privileged".

## API
`POST /run-job` (header `x-service-key`):
```json
{ "jobId": "...", "language": "python|node", "skillDir": "<host path under BROKER_SKILLS_ROOT>",
  "filename": "scripts/x.py", "input": { ... }, "runtime": "runc|runsc",
  "env": { "USER_ID": "...", "SERVICE_API_KEY": "...", "...": "(allowlist only)" } }
```
→ `{ stdout, stderr, exit_code, timed_out, duration_ms }`.

Hardcoded flags on every job: `--rm --cap-drop ALL --security-opt no-new-privileges
--read-only --tmpfs /tmp --pids-limit --memory --network <BROKER_NETWORK>`
(+ `--runtime runsc` if `BROKER_ALLOW_RUNSC=1`), entrypoint bypassed
(`python3`/`node`), skill mounted `:ro`.

Validations: `language` ∈ {python,node}; `runtime` ∈ {runc,runsc}; `filename` without
`..`/absolute; `skillDir` under `BROKER_SKILLS_ROOT`; `env` only keys in the allowlist;
auth via `x-service-key`.

## Env
`PORT` (4100) · `SERVICE_API_KEY` (required) · `BROKER_SKILLS_ROOT` (required) ·
`BROKER_RUNNER_IMAGE` · `BROKER_NETWORK` (none) · `BROKER_ALLOW_RUNSC` ·
`JOB_MEMORY` · `JOB_PIDS` · `JOB_TIMEOUT_MS`.

## Deploy
Runs as a separate container with the socket mounted
(`-v /var/run/docker.sock:/var/run/docker.sock`), on an internal network, reachable
**only** by the orchestrator (executor/backend). Never exposed.

## Status (D2)
- ✅ Hardened container-job primitive verified (cap-drop, no-new-priv, network
  none, read-only, stdin, non-root uid).
- ✅ Broker + narrow API + security validations verified.
- ⏳ Integration: executor's `/execute` → broker (in place of the in-process spawn);
  runner image / deps mounting; gVisor switch; per-capability mount
  (copy-in/out C2) + per-job network C1.
