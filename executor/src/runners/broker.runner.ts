import * as path from 'path';
import * as fs from 'fs';
import { ExecuteRequest, ExecuteResult } from '../types';
import { resolveNetworks, usesEgressProxy } from './networks';
import { listTopLevelFiles } from './outputs';

/**
 * broker.runner.ts — runs a skill as a **container-job** via the job-launcher
 * broker (D2), instead of the in-process spawn.
 *
 * Active only if `BROKER_URL` is set (feature flag): otherwise the executor uses
 * the usual in-process runners. This way local development stays unchanged.
 *
 * The broker mounts the skill dir (host) as `/skill:ro` in the container. When
 * the executor runs in a container, `SKILLS_HOST_BASE` remaps SKILLS_BASE_PATH
 * (volume) to the path on the host; locally it matches SKILLS_BASE_PATH.
 */
const BROKER_URL    = process.env.BROKER_URL || '';
const SKILLS_BASE   = process.env.SKILLS_BASE_PATH || '/app/skills';
const SKILLS_HOST   = process.env.SKILLS_HOST_BASE || SKILLS_BASE;
const JOB_RUNTIME   = process.env.JOB_RUNTIME || 'runc'; // 'runc' | 'runsc'
// global-agent bootstrap path INSIDE the runner image (node jobs under egress: Node does
// not honor HTTP_PROXY natively, so we preload global-agent to route http/https via proxy).
const RUNNER_GLOBAL_AGENT_BOOTSTRAP =
  process.env.RUNNER_GLOBAL_AGENT_BOOTSTRAP || '/opt/proxy/node_modules/global-agent/bootstrap';
// Host root for the per-skill persistent state (T5a). If not configured,
// no /skill-state mount.
const STATE_HOST    = process.env.SKILL_STATE_HOST_BASE || '';
// Host root for the ephemeral per-job work dirs (T5b copy-in/out).
const WORK_HOST     = process.env.WORK_HOST_BASE || '';
// Host skills-output dir where the job outputs are materialized (T5c copy-out).
const OUTPUT_HOST   = process.env.SKILLS_OUTPUT_HOST_BASE || '';

/** Recursively copies the contents of `src` into `dst` (preserves the structure). */
function copyDirInto(src: string, dst: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDirInto(s, d); }
    else if (e.isFile()) { fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(s, d); }
  }
}

/** Creates (if needed) and returns the per-skill persistent state host dir, or null. */
function prepareStateDir(skillId: string): string | null {
  if (!STATE_HOST) return null;
  const dir = path.join(STATE_HOST, skillId);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o777); // writable by the container uid (non-root runner)
    return dir;
  } catch {
    return null;
  }
}

export function brokerEnabled(): boolean {
  return !!BROKER_URL;
}


export async function runViaBroker(req: ExecuteRequest): Promise<ExecuteResult> {
  const t0 = Date.now();
  const hostSkillDir = path.join(SKILLS_HOST, req.skill_id);

  // Env for the container-job (only keys in the broker-side allowlist).
  const env: Record<string, string> = {
    USER_ID:              req.user_id ?? '',
    SKILL_ID:             req.skill_id,
    BACKEND_INTERNAL_URL: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000',
    INTERNAL_TOKEN:       req.run_token ?? '',
    // skill deps (mounted with the skill dir at /skill)
    PYTHONPATH:           '/skill/.deps/python',
    NODE_PATH:            '/skill/.deps/node/node_modules',
    // NB: per-job copy-in/out (C2 hard) is the next step; for now output to /tmp
    SKILLS_OUTPUT_DIR:    '/tmp',
  };
  // Egress proxy: only for the `internet` tier (skill declared external domains).
  // A backend-only job must NOT route through the proxy — its /internal/* calls go
  // direct on the internal network (and NO_PROXY covers `backend` anyway).
  if (usesEgressProxy(req.network)) {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
    // Node doesn't honor HTTP_PROXY natively → preload global-agent (in the runner image)
    // so http/https route through the egress proxy. Python's urllib honors it directly.
    const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (req.language === 'node' && proxy) {
      env.GLOBAL_AGENT_HTTP_PROXY  = proxy;
      env.GLOBAL_AGENT_HTTPS_PROXY = process.env.HTTPS_PROXY ?? proxy;
      env.GLOBAL_AGENT_NO_PROXY    = process.env.NO_PROXY ?? '';
      env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}-r ${RUNNER_GLOBAL_AGENT_BOOTSTRAP}`;
    }
  }

  // Per-skill persistent state (T5a): if configured, mounts /skill-state.
  const hostStateDir = prepareStateDir(req.skill_id);
  if (hostStateDir) env.SKILL_STATE_DIR = '/skill-state';

  // Nix: if the skill has system.nix deps installed ({skillDir}/.nix/bin), the job
  // mounts /nix:ro and puts the skill's profile in PATH (the nix binaries work
  // even on a Debian base because they are self-contained in /nix/store).
  let useNix = false;
  try { useNix = fs.existsSync(path.join(hostSkillDir, '.nix', 'bin')); } catch { /* */ }
  if (useNix) {
    env.PATH = '/skill/.nix/bin:/usr/local/bin:/usr/bin:/bin';
    env.NIX_SSL_CERT_FILE = '/etc/ssl/certs/ca-certificates.crt';
  }

  // The input + the config vars as `_config` (same contract as the in-process runner).
  const payload: Record<string, unknown> = req.config && Object.keys(req.config).length
    ? { ...req.input, _config: req.config }
    : { ...req.input };

  // Per-job copy-in (T5b): stages the files authorized by the backend into /work/inputs
  // and rewrites the argument with the path in the container. Working set = only these files.
  // Per-job work dir: created when WORK_HOST is configured (needed for both copy-in
  // and copy-out). `skills-output` as a subdir so the download_url the skill
  // computes ("skills-output/x") is already a valid ?rel= (no rewrite).
  const jobId = `${req.skill_id.slice(0, 8)}-${Date.now()}`;
  let hostWorkDir: string | null = null;
  if (WORK_HOST) {
    hostWorkDir = path.join(WORK_HOST, jobId);
    const inputs = path.join(hostWorkDir, 'inputs');
    const outDir = path.join(hostWorkDir, 'skills-output');
    fs.mkdirSync(inputs, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const d of [hostWorkDir, inputs, outDir]) fs.chmodSync(d, 0o777);
    // copy-in: stages the authorized files and rewrites the arguments
    for (const f of req.files ?? []) {
      const safe = path.basename(f.name); // no escaping from inputs/
      fs.copyFileSync(f.hostPath, path.join(inputs, safe));
      payload[f.param] = `/work/inputs/${safe}`;
    }
    env.SKILLS_OUTPUT_DIR = '/work/skills-output';
  }

  const cleanup = () => {
    if (hostWorkDir) { try { fs.rmSync(hostWorkDir, { recursive: true, force: true }); } catch { /* */ } }
  };

  let res: Response;
  try {
    res = await fetch(`${BROKER_URL.replace(/\/$/, '')}/run-job`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': process.env.SERVICE_API_KEY ?? '' },
      body: JSON.stringify({
        jobId,
        language: req.language,
        skillDir: hostSkillDir,
        filename: req.filename,
        input:    payload,
        env,
        runtime:  JOB_RUNTIME,
        networks: resolveNetworks(req.network, req.grantedNetworks),
        ...(hostStateDir ? { stateDir: hostStateDir } : {}),
        ...(hostWorkDir ? { workDir: hostWorkDir } : {}),
        ...(useNix ? { nix: true } : {}),
      }),
    });
  } catch (err: any) {
    cleanup();
    return { stdout: '', stderr: `[broker non raggiungibile]: ${err.message}`, exit_code: 1, duration_ms: Date.now() - t0 };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    cleanup();
    return { stdout: '', stderr: `[broker] HTTP ${res.status}: ${body.slice(0, 200)}`, exit_code: 1, duration_ms: Date.now() - t0 };
  }

  const r: any = await res.json();

  // T5c copy-out: materializes the job outputs (/work/skills-output) into a
  // PER-USER subdir of the host skills-output dir. Physical per-tenant isolation:
  // two users' outputs with the same filename never collide/overwrite, and the
  // ?rel= download is confined to the requester's own subdir (backend side), so a
  // guessed filename can never reach another tenant. Cross-tenant SHARING (team/
  // project) is served by the access-aware GET /api/files/:id/download instead.
  let outputs: string[] = [];
  if (hostWorkDir && OUTPUT_HOST) {
    const userSub = (req.user_id || '').replace(/[^a-zA-Z0-9_-]/g, '') || '_shared';
    const jobOutDir = path.join(hostWorkDir, 'skills-output');
    copyDirInto(jobOutDir, path.join(OUTPUT_HOST, userSub));
    outputs = listTopLevelFiles(jobOutDir); // the deliverables this job produced
  }
  cleanup();
  return {
    stdout:      r.stdout ?? '',
    stderr:      r.stderr ?? '',
    exit_code:   typeof r.exit_code === 'number' ? r.exit_code : 1,
    duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : (Date.now() - t0),
    outputs,
  };
}
