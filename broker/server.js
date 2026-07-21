// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

'use strict';
/**
 * broker/server.js — Job-launcher broker (D2).
 *
 * The ONLY component that talks to the Docker daemon (socket). Exposes a
 * NARROW API `POST /run-job`: receives high-level parameters (language, skill,
 * input, runtime, capabilities) and builds a `docker run` with HARDCODED
 * hardening flags (cap-drop, no-new-priv, read-only, ulimit, network, runtime).
 * It NEVER accepts arbitrary docker specs → a compromised caller can only
 * "run this locked-down job", not "create a container with --privileged".
 *
 * Service-to-service auth: x-service-key header.
 * Zero npm dependencies (minimal surface for the socket holder).
 *
 * Env:
 *   PORT                 (default 4100)
 *   SERVICE_API_KEY     (required)
 *   BROKER_SKILLS_ROOT   allowed host root for skill mounts (required)
 *   BROKER_RUNNER_IMAGE  runner image (default pa-executor:test)
 *   BROKER_NETWORK       job network: 'none' (default) | validated docker network name
 *   BROKER_ALLOW_RUNSC   '1' to allow runtime=runsc (gVisor)
 *   JOB_MEMORY / JOB_PIDS / JOB_TIMEOUT_MS  limits (default 256m / 128 / 120000)
 */
const http = require('http');
const {execFile} = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/** Constant-time string compare (avoids a timing side-channel on the service key). */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

const PORT = parseInt(process.env.PORT || '4100', 10);
const API_KEY = process.env.SERVICE_API_KEY || '';
const SKILLS_ROOT = path.resolve(process.env.BROKER_SKILLS_ROOT || '');
// Host root for per-skill persistent state (writable /skill-state mount).
const STATE_ROOT = process.env.BROKER_STATE_ROOT ? path.resolve(process.env.BROKER_STATE_ROOT) : '';
// Host root for per-job ephemeral work dirs (copy-in/out, /work mount).
const WORK_ROOT = process.env.BROKER_WORK_ROOT ? path.resolve(process.env.BROKER_WORK_ROOT) : '';
// Host root for the sandbox persistent workspaces (writable /workspace mount).
const SANDBOX_ROOT = process.env.BROKER_SANDBOX_ROOT ? path.resolve(process.env.BROKER_SANDBOX_ROOT) : '';
// Shared skills-output host dir: if configured, the sandbox job mounts it at /output
// (writable) and SKILLS_OUTPUT_DIR=/output → deliverables become downloadable/attachable.
const SANDBOX_OUTPUT = process.env.BROKER_SANDBOX_OUTPUT ? path.resolve(process.env.BROKER_SANDBOX_OUTPUT) : '';
// Nix store shared into jobs that have system.nix deps (mounted /nix:ro): the binaries
// in the /skill/.nix/bin profile are symlinks into /nix/store, so the SAME store the
// executor installed into must be visible in the job. Two ways to point at it:
//   • BROKER_NIX_VOLUME — a Docker NAMED VOLUME (e.g. arkimede_nix_store). Preferred:
//     it is the very volume the executor mounts at /nix, shared by name to the sibling
//     job (`docker run -v <vol>:/nix:ro`). Portable (Mac/Linux), no host-path guessing,
//     stays on the fast VM filesystem. This is the default in the broker overlay.
//   • BROKER_NIX_STORE — an absolute HOST PATH to a /nix store (real host Nix install).
// If both are set the named volume wins.
const NIX_VOLUME = process.env.BROKER_NIX_VOLUME || '';
// Memoized "the named volume exists" flag (see verifyNixSource): only the SUCCESS is
// cached — a first-job miss must be re-checkable once the executor has created it.
let nixVolumeOk = false;
const NIX_STORE = process.env.BROKER_NIX_STORE ? path.resolve(process.env.BROKER_NIX_STORE) : '';
const RUNNER_IMAGE = process.env.BROKER_RUNNER_IMAGE || 'pa-executor:test';
const NETWORK = process.env.BROKER_NETWORK || 'none';
// Allowed per-job networks (besides 'none'): comma-separated, e.g. "sandboxnet".
const ALLOWED_NETS = new Set(['none', ...(process.env.BROKER_ALLOWED_NETWORKS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
const ALLOW_RUNSC = process.env.BROKER_ALLOW_RUNSC === '1';
// Operator opt-in for the 'trusted' sandbox profile (writable rootfs + root + default
// caps → runtime apt-get). OFF by default: a real isolation downgrade, only advisable
// under gVisor (runsc) or a trusted single-tenant deploy. Without this, a 'trusted'
// request from the admin config falls back to the hardened profile.
const ALLOW_PRIVILEGED_SANDBOX = process.env.BROKER_ALLOW_PRIVILEGED_SANDBOX === '1';
const JOB_MEMORY = process.env.JOB_MEMORY || '256m';
const JOB_PIDS = process.env.JOB_PIDS || '128';
// Default 120s: apt-get/pip/npm installs (esp. the 'trusted' sandbox profile) easily
// exceed 30s. Matches the executor's SANDBOX_TIMEOUT_MS default so the two layers align.
const JOB_TIMEOUT = parseInt(process.env.JOB_TIMEOUT_MS || '120000', 10);

// Env vars allowed to be injected into the job (allowlist — no arbitrary env).
const ALLOWED_ENV = new Set([
    'USER_ID', 'SKILL_ID', 'BACKEND_INTERNAL_URL', 'INTERNAL_TOKEN',
    'SKILLS_OUTPUT_DIR', 'SKILL_STATE_DIR', 'PYTHONPATH', 'NODE_PATH',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    // Node egress: global-agent bootstrap (NODE_OPTIONS -r) + its proxy config, so node
    // jobs route http/https through the egress proxy (Node ignores HTTP_PROXY natively).
    'NODE_OPTIONS', 'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY', 'GLOBAL_AGENT_NO_PROXY',
    // PATH: the executor sets it for nix skills (includes /skill/.nix/bin); the job
    // only mounts /skill:ro, /work, /skill-state, /nix:ro → no useful arbitrary path.
    'PATH', 'NIX_SSL_CERT_FILE',
]);

function fail(reason) {
    return {ok: false, reason};
}

/**
 * Resolves and validates the job's network list. Accepts either `networks` (array,
 * multi-homing: the job is attached to nets[0] via `docker run/create` and to the
 * rest via `docker network connect`) or the legacy single `network`. EVERY network
 * must be in the allowlist (a compromised caller cannot request `host`/arbitrary).
 * Returns { ok, nets } or { ok:false, reason }.
 */
function resolveJobNets(body) {
    const raw = Array.isArray(body.networks) && body.networks.length
        ? body.networks
        : [body.network ?? NETWORK];
    const nets = [...new Set(raw.map(String).map((s) => s.trim()).filter(Boolean))];
    if (!nets.length) nets.push('none');
    for (const n of nets) {
        if (!ALLOWED_NETS.has(n)) return {ok: false, reason: `network not allowed: ${n}`};
    }
    return {ok: true, nets};
}

/** Container name the broker assigns to a job (must match run/create ↔ connect/start). */
function jobContainerName(body) {
    return body.sandbox ? `sbx-${body.jobId}` : `job-${body.jobId}`;
}

/** Validates the request and returns the `docker run` arguments (hardcoded flags). */
function buildDockerArgs(body) {
    const {
        jobId,
        language,
        skillDir,
        filename,
        runtime,
        env,
        network,
        stateDir,
        workDir,
        nix,
        sandbox,
        workspaceDir,
        execMode
    } = body;

    if (!jobId || typeof jobId !== 'string') return fail('jobId missing');

    // ── Sandbox job (arbitrary code/shell, run_in_sandbox tool) ──────────────────
    // No /skill:ro: the code is staged in a PERSISTENT per-session workspace
    // (mounted writable at /workspace). Same hardening flags as skill jobs.
    if (sandbox) {
        if (!['python', 'node', 'shell'].includes(language)) return fail('language not allowed (sandbox)');
        if (typeof filename !== 'string' || filename.includes('..') || filename.startsWith('/'))
            return fail('invalid filename');
        if (!SANDBOX_ROOT) return fail('sandbox required but BROKER_SANDBOX_ROOT not configured');
        const ws = path.resolve(workspaceDir || '');
        if (ws !== SANDBOX_ROOT && !ws.startsWith(SANDBOX_ROOT + path.sep))
            return fail('workspaceDir outside the allowed root');

        const netRes = resolveJobNets(body);
        if (!netRes.ok) return fail(netRes.reason);
        const nets = netRes.nets;

        let runtimeFlags = [];
        if (runtime === 'runsc') {
            if (!ALLOW_RUNSC) return fail('runtime runsc not enabled');
            runtimeFlags = ['--runtime', 'runsc'];
        } else if (runtime && runtime !== 'runc') {
            return fail('runtime not allowed');
        }

        const envFlags = [];
        for (const [k, v] of Object.entries(env || {})) {
            if (!ALLOWED_ENV.has(k)) return fail(`env not allowed: ${k}`);
            envFlags.push('-e', `${k}=${String(v)}`);
        }

        // Output (file delivery): mount a PER-USER subdir of host skills-output → /output
        // (rw) so a sandbox's deliverables are physically isolated per tenant (mirrors the
        // skill-job copy-out; the backend confines ?rel= to the caller's own subdir, and
        // shares via the access-aware /api/files/:id/download).
        let outputFlags = [];
        if (SANDBOX_OUTPUT) {
            const userSub = String((env && env.USER_ID) || '').replace(/[^a-zA-Z0-9_-]/g, '') || '_shared';
            const outHost = path.join(SANDBOX_OUTPUT, userSub);
            try { fs.mkdirSync(outHost, { recursive: true }); fs.chmodSync(outHost, 0o777); } catch { /* */ }
            outputFlags = ['-v', `${outHost}:/output`, '-e', 'SKILLS_OUTPUT_DIR=/output'];
        }

        // ── Execution profile ──────────────────────────────────────────────────
        // hardened (default): read-only rootfs + non-root uid + cap-drop ALL.
        // trusted: writable rootfs + root + default caps, so the code can apt-get
        //   system libraries at runtime. Gated by the operator flag; if requested but
        //   not enabled, fall back to hardened (safe default) and log it.
        const wantsTrusted = execMode === 'trusted';
        const trusted = wantsTrusted && ALLOW_PRIVILEGED_SANDBOX;
        if (wantsTrusted && !trusted) {
            console.warn(`[broker] sbx-${jobId}: trusted profile requested but BROKER_ALLOW_PRIVILEGED_SANDBOX is off → running hardened`);
        }
        // pids/memory/no-new-priv and the network tier stay in BOTH profiles.
        const profileFlags = trusted
            ? ['--user', '0', '--tmpfs', '/tmp']                       // writable rootfs + root + default caps
            : ['--cap-drop', 'ALL', '--read-only', '--tmpfs', '/tmp']; // isolated (default)

        const entry = language === 'python' ? 'python3' : language === 'node' ? 'node' : 'bash';
        return {
            ok: true,
            args: [
                'run', '--rm', '-i',
                '--name', `sbx-${jobId}`,
                '--entrypoint', entry,
                '--security-opt', 'no-new-privileges',
                ...profileFlags,
                '--pids-limit', JOB_PIDS,
                '--memory', JOB_MEMORY,
                '--network', nets[0],
                ...runtimeFlags,
                '-e', 'HOME=/workspace',
                ...envFlags,
                ...outputFlags,
                '-v', `${ws}:/workspace`,
                '-w', '/workspace',
                RUNNER_IMAGE,
                `/workspace/${filename}`,
            ],
        };
    }

    if (language !== 'python' && language !== 'node') return fail('language not allowed');
    if (typeof filename !== 'string' || filename.includes('..') || filename.startsWith('/'))
        return fail('invalid filename');

    // Per-job network(s): baseline + extras; each must be in the allowlist.
    const netRes = resolveJobNets(body);
    if (!netRes.ok) return fail(netRes.reason);
    const nets = netRes.nets;

    // The skill mount must stay under the allowed root (no /etc, etc.)
    const dir = path.resolve(skillDir || '');
    if (!SKILLS_ROOT || (dir !== SKILLS_ROOT && !dir.startsWith(SKILLS_ROOT + path.sep)))
        return fail('skillDir outside the allowed root');

    // Runtime: runc by default; runsc only if enabled
    let runtimeFlags = [];
    if (runtime === 'runsc') {
        if (!ALLOW_RUNSC) return fail('runtime runsc not enabled');
        runtimeFlags = ['--runtime', 'runsc'];
    } else if (runtime && runtime !== 'runc') {
        return fail('runtime not allowed');
    }

    // Env: allowlisted keys only
    const envFlags = [];
    for (const [k, v] of Object.entries(env || {})) {
        if (!ALLOWED_ENV.has(k)) return fail(`env not allowed: ${k}`);
        envFlags.push('-e', `${k}=${String(v)}`);
    }

    // Per-skill persistent state (writable): optional mount validated under STATE_ROOT.
    const stateFlags = [];
    if (stateDir) {
        if (!STATE_ROOT) return fail('stateDir required but BROKER_STATE_ROOT not configured');
        const sd = path.resolve(stateDir);
        if (sd !== STATE_ROOT && !sd.startsWith(STATE_ROOT + path.sep))
            return fail('stateDir outside the allowed root');
        stateFlags.push('-v', `${sd}:/skill-state`);
    }

    // Nix store (read-only) for skills with system.nix deps: the binaries in the
    // /skill/.nix/bin profile are symlinks into /nix/store → /nix must be mounted.
    if (nix) {
        if (NIX_VOLUME) {
            // Share the executor's Nix store by NAMED VOLUME (docker resolves it on the
            // same daemon → the exact store populated at skill-install time).
            stateFlags.push('-v', `${NIX_VOLUME}:/nix:ro`);
        } else if (NIX_STORE) {
            stateFlags.push('-v', `${NIX_STORE}:/nix:ro`);
        } else {
            return fail('nix required but neither BROKER_NIX_VOLUME nor BROKER_NIX_STORE configured');
        }
    }

    // Per-job ephemeral work dir (copy-in/out, writable): validated under WORK_ROOT.
    if (workDir) {
        if (!WORK_ROOT) return fail('workDir required but BROKER_WORK_ROOT not configured');
        const wd = path.resolve(workDir);
        if (wd !== WORK_ROOT && !wd.startsWith(WORK_ROOT + path.sep))
            return fail('workDir outside the allowed root');
        stateFlags.push('-v', `${wd}:/work`);
    }

    const entry = language === 'python' ? 'python3' : 'node';

    return {
        ok: true,
        args: [
            'run', '--rm', '-i',
            '--name', `job-${jobId}`,
            '--entrypoint', entry,
            // ── Hardcoded hardening (D1) ──
            '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges',
            '--read-only', '--tmpfs', '/tmp',
            '--pids-limit', JOB_PIDS,
            '--memory', JOB_MEMORY,
            '--network', nets[0],
            ...runtimeFlags,
            '-e', 'HOME=/tmp',
            ...envFlags,
            // ── Skill mount (read-only) + per-skill persistent state (writable) ──
            '-v', `${dir}:/skill:ro`,
            ...stateFlags,
            RUNNER_IMAGE,
            `/skill/${filename}`,
        ],
    };
}

/** Runs `docker <dockerArgs>` attached, pipes body.input to stdin, resolves the result. */
function execAttached(dockerArgs, body, t0) {
    return new Promise((resolve) => {
        const child = execFile('docker', dockerArgs, {
            timeout: JOB_TIMEOUT,
            maxBuffer: 8 * 1024 * 1024,
        }, (err, stdout, stderr) => {
            resolve({
                status: 200,
                payload: {
                    stdout: stdout || '',
                    stderr: stderr || '',
                    exit_code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
                    timed_out: !!(err && err.killed),
                    duration_ms: Date.now() - t0,
                },
            });
        });
        // skill input via stdin
        if (body.input !== undefined) {
            try {
                child.stdin.write(typeof body.input === 'string' ? body.input : JSON.stringify(body.input));
            } catch { /* */
            }
        }
        try {
            child.stdin.end();
        } catch { /* */
        }
    });
}

// Verify the configured Nix source actually exists BEFORE mounting it. A bare
// `docker run -v <name>:/nix:ro` with a wrong/absent volume name does NOT fail: docker
// silently creates an EMPTY named volume → /skill/.nix/bin symlinks dangle → a confusing
// runtime error. Pre-checking with `docker volume inspect` turns that into a clear message.
// (The volume's CONTENT isn't deep-verified: a job only sets nix=true when the skill has a
// .nix profile, which the executor produces by installing into this very store.)
function verifyNixSource() {
    if (NIX_VOLUME) {
        if (nixVolumeOk) return Promise.resolve({ok: true});
        return new Promise((resolve) => {
            execFile('docker', ['volume', 'inspect', NIX_VOLUME], {timeout: 10000}, (err) => {
                if (err) return resolve({ok: false, reason:
                    `nix store volume "${NIX_VOLUME}" not found — the executor must be up with a `
                    + `system.nix skill installed (it creates it). Check BROKER_NIX_VOLUME matches the `
                    + `executor's nix_store volume, or set BROKER_NIX_STORE to a host /nix path.`});
                nixVolumeOk = true;
                resolve({ok: true});
            });
        });
    }
    if (NIX_STORE) {
        // Host path: must contain a store/ subdir to be a real /nix.
        if (!fs.existsSync(path.join(NIX_STORE, 'store'))) return Promise.resolve({ok: false, reason:
            `BROKER_NIX_STORE "${NIX_STORE}" is not a valid Nix store (no store/ subdir).`});
        return Promise.resolve({ok: true});
    }
    return Promise.resolve({ok: false, reason:
        'nix required but neither BROKER_NIX_VOLUME nor BROKER_NIX_STORE configured'});
}

async function runJob(body) {
    // Fail fast with a clear message if a nix job's store isn't actually available,
    // instead of letting docker auto-create an empty volume.
    if (body && body.nix) {
        const v = await verifyNixSource();
        if (!v.ok) return {status: 400, payload: {error: v.reason}};
    }

    const built = buildDockerArgs(body);
    if (!built.ok) return {status: 400, payload: {error: built.reason}};

    const t0 = Date.now();
    const nets = resolveJobNets(body).nets;   // already validated by buildDockerArgs
    const extraNets = nets.slice(1);

    // Single network → the plain `docker run` path (unchanged, backward-compatible).
    if (!extraNets.length) return execAttached(built.args, body, t0);

    // Multi-homed → create → connect the extra networks → start attached. Guarantees
    // ALL networks are wired BEFORE the process runs (no run-then-connect race). The
    // container is auto-removed on exit via the `--rm` already in the create args.
    const name = jobContainerName(body);
    const createArgs = ['create', ...built.args.slice(1)]; // built.args[0] === 'run'
    const rmQuiet = () => { try { execFile('docker', ['rm', '-f', name], () => {}); } catch { /* */ } };

    return new Promise((resolve) => {
        execFile('docker', createArgs, {timeout: 20000}, (cErr, _o, cStderr) => {
            if (cErr) return resolve({status: 200, payload: {
                stdout: '', stderr: `[broker create] ${cStderr || cErr.message}`, exit_code: 1, duration_ms: Date.now() - t0}});
            let i = 0;
            const connectNext = () => {
                if (i >= extraNets.length) {
                    execAttached(['start', '-a', '-i', name], body, t0).then(resolve);
                    return;
                }
                const net = extraNets[i++];
                execFile('docker', ['network', 'connect', net, name], {timeout: 15000}, (nErr, _o2, nStderr) => {
                    if (nErr) { rmQuiet(); return resolve({status: 200, payload: {
                        stdout: '', stderr: `[broker net connect ${net}] ${nStderr || nErr.message}`, exit_code: 1, duration_ms: Date.now() - t0}}); }
                    connectNext();
                });
            };
            connectNext();
        });
    });
}

const server = http.createServer((req, res) => {
    const send = (status, obj) => {
        res.writeHead(status, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/health') return send(200, {ok: true});

    if (req.method !== 'POST' || req.url !== '/run-job') return send(404, {error: 'not found'});

    // Service-to-service auth (constant-time to avoid a timing side-channel)
    if (!API_KEY || !safeEqual(req.headers['x-service-key'], API_KEY)) return send(401, {error: 'unauthorized'});

    let raw = '';
    req.on('data', (c) => {
        raw += c;
        if (raw.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
        let body;
        try {
            body = JSON.parse(raw || '{}');
        } catch {
            return send(400, {error: 'invalid json'});
        }
        const {status, payload} = await runJob(body);
        send(status, payload);
    });
});

if (!API_KEY) {
    console.error('[broker] SERVICE_API_KEY is required');
    process.exit(1);
}
if (!SKILLS_ROOT) {
    console.error('[broker] BROKER_SKILLS_ROOT is required');
    process.exit(1);
}

server.listen(PORT, () => {
    console.error(`[broker] in ascolto su :${PORT} | image=${RUNNER_IMAGE} | net=${NETWORK} | runsc=${ALLOW_RUNSC} | skillsRoot=${SKILLS_ROOT}`);
});
