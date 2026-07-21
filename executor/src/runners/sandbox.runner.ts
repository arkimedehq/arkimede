import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { proxyEnv, nodeProxyEnv } from './proxy-env';
import { resolveNetworks, usesEgressProxy, NetworkMode } from './networks';
import { userOutputDir, snapshotOutputs, newOutputs } from './outputs';

// global-agent bootstrap paths: in-process sandbox runs in the EXECUTOR image (/app),
// broker sandbox jobs run in the RUNNER image (/opt/proxy). Preloaded for node under egress.
const EXECUTOR_GA_BOOTSTRAP = process.env.GLOBAL_AGENT_BOOTSTRAP || '/app/node_modules/global-agent/bootstrap';
const RUNNER_GA_BOOTSTRAP   = process.env.RUNNER_GLOBAL_AGENT_BOOTSTRAP || '/opt/proxy/node_modules/global-agent/bootstrap';
import { brokerEnabled } from './broker.runner';

/**
 * sandbox.runner.ts — execution of ARBITRARY code/shell written by the agent
 * (tool `run_in_sandbox`), in a PERSISTENT per-session (= per-chat) workspace.
 *
 * This is the IN-PROCESS path, used in development when the broker is not
 * configured: it is NOT isolated (runs as the executor). In production the
 * execution goes through the broker (hardened container-job) — see broker.runner/sandboxViaBroker.
 */
const SESSIONS_BASE = process.env.SANDBOX_SESSIONS_BASE
  ?? path.join(process.env.SKILLS_BASE_PATH ?? '/app/skills', '..', 'sandbox-sessions');
const MAX_OUTPUT  = parseInt(process.env.MAX_OUTPUT_BYTES ?? '524288', 10); // 512 KB
// Sandbox timeout more generous than the skill default: installs (pip/uvx/npm)
// download packages and easily exceed 30s. Override with SANDBOX_TIMEOUT_MS.
const MAX_TIMEOUT = parseInt(process.env.SANDBOX_TIMEOUT_MS ?? '120000', 10);
// SHARED output dir (= `local` fileshare/skills-output): files written here by the
// sandbox become downloadable/attachable in chat like the skill outputs.
const SKILLS_OUTPUT_DIR = process.env.SKILLS_OUTPUT_DIR
  ?? path.join(process.env.SKILLS_BASE_PATH ?? '/app/skills', '..', 'skills-output');
// Host path of the sessions base (what the broker mounts): matches SESSIONS_BASE
// locally; in a containerized deploy it is the host path of the shared volume.
const SESSION_HOST_BASE = process.env.SANDBOX_SESSION_HOST_BASE ?? SESSIONS_BASE;
const BROKER_URL  = process.env.BROKER_URL || '';
const JOB_RUNTIME = process.env.JOB_RUNTIME || 'runc';

/** The sandbox uses the broker when configured (isolated production path). */
export function sandboxBrokerEnabled(): boolean {
  return brokerEnabled();
}

// Per-session disk quota: blocks execution if the workspace exceeds the limit.
const SESSION_MAX_BYTES = parseInt(process.env.SANDBOX_SESSION_MAX_BYTES ?? '524288000', 10); // 500MB, 0=off

/** Sums the file sizes in dir (early-exit beyond the limit). */
function dirSizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += dirSizeBytes(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch { /* */ }
    if (SESSION_MAX_BYTES && total > SESSION_MAX_BYTES) return total; // enough to decide
  }
  return total;
}

/** If the workspace exceeds the quota, returns an error result (otherwise null). */
function quotaResult(workspace: string): SandboxResult | null {
  if (!SESSION_MAX_BYTES) return null;
  const bytes = dirSizeBytes(workspace);
  if (bytes <= SESSION_MAX_BYTES) return null;
  const mb = (n: number) => Math.round(n / 1048576);
  return {
    stdout: '', exit_code: 1, duration_ms: 0,
    stderr: `[workspace quota exceeded: ~${mb(bytes)}MB > ${mb(SESSION_MAX_BYTES)}MB. Delete files from /workspace (or uninstall deps) before continuing.]`,
  };
}

// GC of session workspaces: removes those unused for longer than TTL (mtime).
const SESSION_TTL_MS = parseInt(process.env.SANDBOX_SESSION_TTL_MS ?? '86400000', 10); // 24h

/** Removes the session workspaces older than the TTL. Returns how many were removed. */
export function gcSessions(): { removed: number; kept: number } {
  let removed = 0, kept = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(SESSIONS_BASE, { withFileTypes: true }); } catch { return { removed, kept }; }
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(SESSIONS_BASE, e.name);
    try {
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { recursive: true, force: true }); removed++; }
      else kept++;
    } catch { /* */ }
  }
  return { removed, kept };
}

export interface SandboxRequest {
  session_id: string;
  language:   'python' | 'node' | 'shell';
  code:       string;
  user_id?:   string;
  run_token?: string;
  timeout_ms?: number;
  network?:   NetworkMode;
  /** Execution profile: 'hardened' (default) | 'trusted' (writable rootfs + root). */
  exec_mode?: 'hardened' | 'trusted';
  /**
   * Descriptive skills (agentskills.io) to make available in the workspace: their
   * files are copied into /workspace/skills/<name>/ (copy-if-missing). The agent runs
   * them from there by reading the SKILL.md.
   */
  skills?:    { name: string; hostPath: string; version?: string }[];
  /**
   * Chat attachments to make available in the workspace: each file is copied
   * into /workspace/inputs/<name> (re-copied if the source changed). Paths are
   * trusted: they come from the backend, which resolves them with ACL checks.
   */
  attachments?: { name: string; hostPath: string }[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  files?: string[];
  /** Top-level deliverables materialized in the per-user skills-output dir this run. */
  outputs?: string[];
  /** true = broker container-job; false = in-process (dev, NOT isolated). Set by the /sandbox route. */
  isolated?: boolean;
}

const log = {
  info:  (m: string) => process.stderr.write(`[sandbox.runner] ${m}\n`),
  error: (m: string) => process.stderr.write(`[sandbox.runner] ✗ ${m}\n`),
};

/** Path of the session dir (sanitizes the session_id), without side-effects. */
function resolveSessionDir(sessionId: string): string {
  const safe = (sessionId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  const dir  = path.join(SESSIONS_BASE, safe);
  if (!dir.startsWith(SESSIONS_BASE + path.sep)) throw new Error('invalid session_id');
  return dir;
}

/** Like resolveSessionDir but creates the dir and prepares it (for executions). */
function safeSessionDir(sessionId: string): string {
  const dir = resolveSessionDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  // Writable by the non-root uid of the container-job (broker mounts /workspace).
  try { fs.chmodSync(dir, 0o777); } catch { /* fs without chmod */ }
  // Update mtime on every use: the per-TTL GC does not remove active sessions
  // (rewriting the same file would not update the dir's mtime).
  try { const now = new Date(); fs.utimesSync(dir, now, now); } catch { /* */ }
  return dir;
}

const MAX_DOWNLOAD_BYTES = parseInt(process.env.SANDBOX_MAX_DOWNLOAD_BYTES ?? '26214400', 10); // 25MB

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', html: 'text/html', xml: 'application/xml',
    zip: 'application/zip', py: 'text/x-python', js: 'text/javascript',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Reads a file from the session workspace (path-traversal guard + size cap). */
export function readSessionFile(sessionId: string, relPath: string): { name: string; mime: string; base64: string } | null {
  try {
    const dir = resolveSessionDir(sessionId);
    const target = path.resolve(dir, relPath);
    if (target !== dir && !target.startsWith(dir + path.sep)) return null; // traversal
    const st = fs.statSync(target);
    if (!st.isFile() || st.size > MAX_DOWNLOAD_BYTES) return null;
    return { name: path.basename(target), mime: mimeFor(target), base64: fs.readFileSync(target).toString('base64') };
  } catch { return null; }
}

/** Lists the top-level files of the workspace (excludes the staged script), best-effort. */
function listWorkspace(dir: string, exclude: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== exclude)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch { return []; }
}

function scriptFileName(language: SandboxRequest['language']): string {
  return language === 'python' ? '_sandbox_main.py' : language === 'node' ? '_sandbox_main.js' : '_sandbox_main.sh';
}

/** Recursive copy of src into dst (preserves the structure). */
function copyDirInto(src: string, dst: string): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDirInto(s, d); }
    else if (e.isFile()) { fs.copyFileSync(s, d); }
  }
}

/**
 * Stages the descriptive skills into /workspace/skills/<name>/. Copies once per
 * session; re-stages (refresh) if the skill's `version` has changed compared to
 * the saved stamp — so a skill updated mid-session does not stay stale.
 */
function stageSkills(workspace: string, skills?: { name: string; hostPath: string; version?: string }[]): void {
  if (!skills?.length) return;
  const root = path.join(workspace, 'skills');
  for (const sk of skills) {
    const safe = sk.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    if (!safe) continue;
    const dest  = path.join(root, safe);
    const stamp = path.join(dest, '.staged-version');
    if (fs.existsSync(dest)) {
      let cur = '';
      try { cur = fs.readFileSync(stamp, 'utf-8'); } catch { /* */ }
      if (!sk.version || cur === sk.version) continue;       // up to date → skip
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* */ }  // stale → re-stage
    }
    try {
      fs.mkdirSync(dest, { recursive: true });
      copyDirInto(sk.hostPath, dest);
      if (sk.version) fs.writeFileSync(stamp, sk.version);
      fs.chmodSync(dest, 0o777);
    } catch { /* best-effort */ }
  }
}

/**
 * Stages the chat attachments into /workspace/inputs/<name>. Copies when the
 * destination is missing or the source has changed (size or mtime) — so a
 * re-uploaded file with the same name does not stay stale.
 */
function stageAttachments(workspace: string, attachments?: { name: string; hostPath: string }[]): void {
  if (!attachments?.length) return;
  const root = path.join(workspace, 'inputs');
  for (const att of attachments) {
    const safe = path.basename(att.name).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 128);
    if (!safe || safe.startsWith('.')) continue;
    try {
      const src = fs.statSync(att.hostPath);
      if (!src.isFile()) continue;
      const dest = path.join(root, safe);
      let stale = true;
      try {
        const cur = fs.statSync(dest);
        stale = cur.size !== src.size || cur.mtimeMs < src.mtimeMs;
      } catch { /* missing → copy */ }
      if (!stale) continue;
      fs.mkdirSync(root, { recursive: true });
      try { fs.chmodSync(root, 0o777); } catch { /* fs without chmod */ }
      fs.copyFileSync(att.hostPath, dest);
    } catch { /* best-effort: unreadable source → skip */ }
  }
}

/** Creates (if needed) the session workspace, stages skills+attachments and writes the code into it. */
function stage(req: SandboxRequest): { workspace: string; fileName: string } {
  const workspace = safeSessionDir(req.session_id);
  stageSkills(workspace, req.skills);
  stageAttachments(workspace, req.attachments);
  const fileName  = scriptFileName(req.language);
  fs.writeFileSync(path.join(workspace, fileName), req.code);
  return { workspace, fileName };
}

/**
 * IN-PROCESS path (dev, NOT isolated): runs the staged code as a subprocess of
 * the executor. To be used ONLY with SANDBOX_ALLOW_INPROCESS=1 (arbitrary,
 * unconfined code). In production runSandboxViaBroker is used.
 */
export async function runSandbox(req: SandboxRequest): Promise<SandboxResult> {
  const { workspace, fileName } = stage(req);
  const over = quotaResult(workspace);
  if (over) return over;
  const scriptPath = path.join(workspace, fileName);
  const timeout_ms = req.timeout_ms ?? MAX_TIMEOUT;

  const isShell = req.language === 'shell';
  const cmd  = req.language === 'python' ? 'python3'
             : req.language === 'node'   ? 'node'
             :                             'bash';
  // Shell: traces EVERY executed command (trap DEBUG → fd 3), separate from the
  // stderr given to the agent. This way in the logs we see the commands/scripts
  // actually launched (e.g. `uvx markitdown input.docx`), not just the code block.
  const TRACE_WRAPPER = 'trap \'printf "+ %s\\n" "$BASH_COMMAND" >&3 2>/dev/null\' DEBUG; set -T 2>/dev/null; . "$0"';
  const args = isShell ? ['-c', TRACE_WRAPPER, scriptPath] : [scriptPath];

  // Per-user deliverables dir (physical tenant isolation; mirrors the broker path).
  const userOutDir = path.join(SKILLS_OUTPUT_DIR, (req.user_id || '').replace(/[^a-zA-Z0-9_-]/g, '') || '_shared');
  const env: NodeJS.ProcessEnv = {
    PATH:   process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME:   workspace,
    TMPDIR: '/tmp',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    NO_COLOR: '1',
    USER_ID:              req.user_id ?? '',
    INTERNAL_TOKEN:       req.run_token ?? '',
    BACKEND_INTERNAL_URL: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000',
    // Per-user dir for the deliverables (downloadable/attachable like the skill outputs).
    SKILLS_OUTPUT_DIR:    userOutDir,
    ...(usesEgressProxy(req.network) ? proxyEnv() : {}),
    // Node ignores HTTP_PROXY natively → preload global-agent (executor image) for node.
    ...(usesEgressProxy(req.network) && req.language === 'node' ? nodeProxyEnv(EXECUTOR_GA_BOOTSTRAP) : {}),
  };
  try { fs.mkdirSync(userOutDir, { recursive: true }); } catch { /* */ }
  const outBefore = snapshotOutputs(userOutDir);

  log.info(`session=${req.session_id} lang=${req.language} ws=${workspace} timeout=${timeout_ms}ms`);

  const start = Date.now();
  let stdout = '', stderr = '', trace = '', killed = false;

  return new Promise((resolve) => {
    const stdio = isShell ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'];
    // detached:true → the child becomes leader of a new process-group. This way on
    // timeout we can kill the WHOLE group (bash + its children: pip/uvx/…),
    // not just the bash process. Otherwise orphan installs survive the
    // SIGKILL and stay hanging (seen: pip 78s after a 30s timeout).
    const child = spawn(cmd, args, { env, cwd: workspace, stdio: stdio as any, detached: true });

    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* group already dead */ }
      child.kill('SIGKILL'); // fallback on the child alone
    }, timeout_ms);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT) + '\n[STDERR TRUNCATED]';
    });
    // fd 3: trace of the shell commands (trap DEBUG). For the log only, does not go back to the agent.
    const traceStream = (child.stdio as any)[3];
    if (traceStream) traceStream.on('data', (c: Buffer) => {
      trace += c.toString();
      if (trace.length > MAX_OUTPUT) trace = trace.slice(0, MAX_OUTPUT) + '\n[TRACE TRUNCATED]';
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (trace.trim()) log.info(`shell commands executed:\n${trace.trim().split('\n').map((l) => `    ${l}`).join('\n')}`);
      resolve({
        stdout,
        stderr: killed ? `[KILLED: timeout ${timeout_ms}ms]\n` + stderr : stderr,
        exit_code: killed ? 124 : (code ?? 1),
        duration_ms: Date.now() - start,
        files: listWorkspace(workspace, fileName),
        outputs: newOutputs(userOutDir, outBefore),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log.error(`spawn error: ${err.message}`);
      resolve({ stdout, stderr: `[SPAWN ERROR]: ${err.message}\n` + stderr, exit_code: 1, duration_ms: Date.now() - start });
    });
  });
}

/**
 * PRODUCTION path (isolated): stages the code in the session workspace and runs
 * it as a locked-down container-job via the broker (writable /workspace mount,
 * cap-drop ALL, read-only rootfs, no-new-priv, pids/memory limit, network none).
 */
export async function runSandboxViaBroker(req: SandboxRequest): Promise<SandboxResult> {
  const t0 = Date.now();
  const { workspace, fileName } = stage(req);          // executor-visible workspace
  const over = quotaResult(workspace);
  if (over) return over;
  const safe = path.basename(workspace);
  const hostWorkspace = path.join(SESSION_HOST_BASE, safe); // what the broker mounts

  // Per-user deliverables dir: the broker mounts it as /output in the job (same host
  // path the executor sees) → snapshot before/after to report the files produced.
  const userOutDir = userOutputDir(req.user_id);
  const outBefore  = snapshotOutputs(userOutDir);

  const env: Record<string, string> = {
    USER_ID:              req.user_id ?? '',
    INTERNAL_TOKEN:       req.run_token ?? '',
    BACKEND_INTERNAL_URL: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000',
  };
  // In the `internet` tier traffic goes through the allowlist-proxy (PROXY variables).
  // In `open` NO proxy: direct internet.
  if (usesEgressProxy(req.network)) {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
      if (process.env[k]) env[k] = process.env[k]!;
    }
    // Node ignores HTTP_PROXY natively → preload global-agent (runner image) for node jobs.
    if (req.language === 'node') {
      for (const [k, v] of Object.entries(nodeProxyEnv(RUNNER_GA_BOOTSTRAP))) {
        if (v != null) env[k] = v;
      }
    }
  }

  const jobId = `${safe.slice(0, 8)}-${Date.now()}`;
  let res: Response;
  try {
    res = await fetch(`${BROKER_URL.replace(/\/$/, '')}/run-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-service-key': process.env.SERVICE_API_KEY ?? '' },
      body: JSON.stringify({
        jobId,
        sandbox: true,
        language: req.language,
        workspaceDir: hostWorkspace,
        filename: fileName,
        env,
        runtime: JOB_RUNTIME,
        networks: resolveNetworks(req.network),
        execMode: req.exec_mode ?? 'hardened',
      }),
    });
  } catch (err: any) {
    return { stdout: '', stderr: `[broker unreachable]: ${err.message}`, exit_code: 1, duration_ms: Date.now() - t0 };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { stdout: '', stderr: `[broker] HTTP ${res.status}: ${body.slice(0, 200)}`, exit_code: 1, duration_ms: Date.now() - t0 };
  }

  const r: any = await res.json();
  return {
    stdout:      r.stdout ?? '',
    stderr:      r.stderr ?? '',
    exit_code:   typeof r.exit_code === 'number' ? r.exit_code : 1,
    duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : (Date.now() - t0),
    files:       listWorkspace(workspace, fileName),
    outputs:     newOutputs(userOutDir, outBefore),
  };
}
