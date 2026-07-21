/**
 * @file daemon-manager.ts
 *
 * Manages the skills' daemon processes: start, stop, list, status.
 *
 * A daemon is a long-running process (python3 or node) that:
 *   - Receives the configuration via stdin JSON at startup (_config)
 *   - Runs indefinitely executing its own internal loop
 *   - Reports events to the backend via POST to PUSH_URL
 *   - Is terminated with SIGTERM + SIGKILL (5s grace) on stopDaemon()
 *
 * The manager keeps an in-memory Map: daemonId → DaemonEntry.
 * On process termination (expected or unexpected) the entry is removed
 * and the backend is notified via PUSH_URL with event_type=daemon_exit.
 *
 * Environment variables injected into the daemon process:
 *   PUSH_URL             — URL to POST events to the backend
 *   DAEMON_ID            — unique daemon ID (for correlation)
 *   SKILL_ID             — skill ID (to save config via internal API)
 *   USER_ID              — user ID (for notification routing)
 *   BACKEND_INTERNAL_URL — backend base URL (already available in the runner tasks)
 *   INTERNAL_TOKEN       — signed daemon token for the internal API (x-internal-token header)
 *   PYTHONPATH / NODE_PATH — path to the dependencies installed by the skill
 */
import { spawn, ChildProcess } from 'child_process';

// Absolute path to global-agent's bootstrap (installed in the executor image at /app).
// Preloaded via NODE_OPTIONS for node daemons under egress so http/https honor the proxy.
// Overridable for local/dev runs.
const GLOBAL_AGENT_BOOTSTRAP =
  process.env.GLOBAL_AGENT_BOOTSTRAP || '/app/node_modules/global-agent/bootstrap';
import * as path from 'path';
import * as fs from 'fs';
import { DaemonStartRequest, DaemonStartResult, DaemonStatusEntry } from './types';
import { buildSkillPath } from './utils';

const SKILLS_BASE = process.env.SKILLS_BASE_PATH ?? '/app/skills';

interface DaemonEntry {
  process:    ChildProcess;
  skill_id:   string;
  filename:   string;
  user_id:    string;
  push_url:   string;
  pid:        number;
  started_at: string;
}

const daemons = new Map<string, DaemonEntry>();

const log = {
  info:  (msg: string) => process.stderr.write(`[daemon-manager] ℹ ${msg}\n`),
  warn:  (msg: string) => process.stderr.write(`[daemon-manager] ⚠ ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[daemon-manager] ✗ ${msg}\n`),
};

// ─── start ────────────────────────────────────────────────────────────────────

export function startDaemon(req: DaemonStartRequest): DaemonStartResult {
  const skillDir  = path.join(SKILLS_BASE, req.skill_id);
  const scriptAbs = path.join(skillDir, req.filename);

  // Security: no path traversal
  if (!scriptAbs.startsWith(skillDir + path.sep)) {
    throw new Error(`Path traversal detected: ${req.filename}`);
  }
  if (!fs.existsSync(scriptAbs)) {
    throw new Error(`Script not found: ${req.filename}`);
  }

  // If a daemon with the same ID already exists, stop it first
  if (daemons.has(req.daemon_id)) {
    log.warn(`Daemon ${req.daemon_id} already running — restart`);
    stopDaemon(req.daemon_id);
  }

  // Path to the installed dependencies
  const pythonDepsDir = path.join(skillDir, '.deps', 'python');
  const nodeDepsDir   = path.join(skillDir, '.deps', 'node', 'node_modules');

  const baseEnv: NodeJS.ProcessEnv = {
    // PATH with the skill's Nix profile bin prepended (if present)
    PATH:  buildSkillPath(skillDir),
    HOME:  '/tmp',
    TMPDIR: '/tmp',
    // Internal API — identical to the runner tasks. Auth via signed daemon token.
    SKILL_ID:             req.skill_id,
    USER_ID:              req.user_id,
    DAEMON_ID:            req.daemon_id,
    PUSH_URL:             req.push_url,
    BACKEND_INTERNAL_URL: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000',
    INTERNAL_TOKEN:       req.daemon_token ?? '',
  };

  const langEnv: NodeJS.ProcessEnv = req.language === 'python'
    ? {
        PYTHONPATH:              fs.existsSync(pythonDepsDir) ? pythonDepsDir : '',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUNBUFFERED:        '1',
      }
    : {
        NODE_PATH:   fs.existsSync(nodeDepsDir) ? nodeDepsDir : '',
        NO_COLOR:    '1',
        FORCE_COLOR: '0',
      };

  // Egress proxy passthrough: under the egress overlay the executor has HTTP_PROXY set.
  // Daemons run in-process here, so they must inherit it to reach allowlisted external
  // domains. Python's urllib honors HTTP_PROXY natively; Node does NOT → for node daemons
  // we also preload global-agent, which patches http/https to route through the proxy.
  // Internal calls (backend) bypass it via NO_PROXY.
  const proxy = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  const proxyEnv: NodeJS.ProcessEnv = proxy ? {
    HTTP_PROXY:  process.env.HTTP_PROXY  ?? proxy,
    HTTPS_PROXY: process.env.HTTPS_PROXY ?? proxy,
    NO_PROXY:    process.env.NO_PROXY    ?? '',
  } : {};
  const nodeProxyEnv: NodeJS.ProcessEnv = (proxy && req.language === 'node') ? {
    GLOBAL_AGENT_HTTP_PROXY:  process.env.HTTP_PROXY  ?? proxy,
    GLOBAL_AGENT_HTTPS_PROXY: process.env.HTTPS_PROXY ?? proxy,
    GLOBAL_AGENT_NO_PROXY:    process.env.NO_PROXY    ?? '',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}-r ${GLOBAL_AGENT_BOOTSTRAP}`,
  } : {};

  const env = { ...baseEnv, ...proxyEnv, ...langEnv, ...nodeProxyEnv };

  const cmd = req.language === 'python' ? 'python3' : 'node';

  const child = spawn(cmd, [scriptAbs], {
    env,
    cwd: skillDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Send the configuration via stdin (same protocol as the runner tasks)
  // The script reads stdin once at startup: data = json.loads(sys.stdin.read())
  const payload = req.config && Object.keys(req.config).length > 0
    ? { _config: req.config }
    : {};
  child.stdin!.write(JSON.stringify(payload));
  child.stdin!.end();

  const started_at = new Date().toISOString();
  const pid        = child.pid ?? -1;

  // Log the daemon's stdout/stderr (we don't capture output as a result — it goes to the log)
  child.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.info(`[${req.daemon_id.slice(0, 8)}] ${text.slice(0, 500)}`);
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) log.warn(`[${req.daemon_id.slice(0, 8)}] stderr: ${text.slice(0, 500)}`);
  });

  child.on('exit', (code, signal) => {
    const reason = signal ? `signal=${signal}` : `code=${code}`;
    log.warn(`Daemon ${req.daemon_id.slice(0, 8)} terminated (${reason})`);
    daemons.delete(req.daemon_id);
    // Notify the backend of the unexpected exit (auth with the daemon token)
    notifyDaemonExit(req.daemon_id, req.user_id, req.skill_id, code, req.daemon_token ?? '').catch(() => {});
  });

  child.on('error', (err) => {
    log.error(`Daemon ${req.daemon_id.slice(0, 8)} spawn error: ${err.message}`);
    daemons.delete(req.daemon_id);
  });

  daemons.set(req.daemon_id, {
    process:    child,
    skill_id:   req.skill_id,
    filename:   req.filename,
    user_id:    req.user_id,
    push_url:   req.push_url,
    pid,
    started_at,
  });

  log.info(`Started daemon ${req.daemon_id.slice(0, 8)} (${req.filename}) PID=${pid}`);
  return { daemon_id: req.daemon_id, pid, started_at };
}

// ─── stop ─────────────────────────────────────────────────────────────────────

export function stopDaemon(daemonId: string): boolean {
  const entry = daemons.get(daemonId);
  if (!entry) return false;

  log.info(`Stopping daemon ${daemonId.slice(0, 8)} (SIGTERM)...`);

  try {
    entry.process.kill('SIGTERM');
  } catch (err: any) {
    log.warn(`SIGTERM error on daemon ${daemonId.slice(0, 8)}: ${err.message}`);
  }

  // Grace period: if it hasn't exited within 5s, SIGKILL
  const killTimer = setTimeout(() => {
    if (daemons.has(daemonId)) {
      log.warn(`Daemon ${daemonId.slice(0, 8)} not responding to SIGTERM — SIGKILL`);
      try { entry.process.kill('SIGKILL'); } catch { /* already dead */ }
      daemons.delete(daemonId);
    }
  }, 5_000);

  // Cancel the timer if the process exits within 5s
  entry.process.once('exit', () => clearTimeout(killTimer));

  daemons.delete(daemonId);
  return true;
}

// ─── query ────────────────────────────────────────────────────────────────────

export function listDaemons(): DaemonStatusEntry[] {
  return Array.from(daemons.entries()).map(([id, e]) => ({
    daemon_id:  id,
    skill_id:   e.skill_id,
    filename:   e.filename,
    user_id:    e.user_id,
    pid:        e.pid,
    running:    !e.process.killed,
    started_at: e.started_at,
  }));
}

export function getDaemon(daemonId: string): DaemonStatusEntry | null {
  const e = daemons.get(daemonId);
  if (!e) return null;
  return {
    daemon_id:  daemonId,
    skill_id:   e.skill_id,
    filename:   e.filename,
    user_id:    e.user_id,
    pid:        e.pid,
    running:    !e.process.killed,
    started_at: e.started_at,
  };
}

// ─── helper ───────────────────────────────────────────────────────────────────

async function notifyDaemonExit(
  daemonId:    string,
  userId:      string,
  skillId:     string,
  exitCode:    number | null,
  daemonToken: string,
): Promise<void> {
  const backendUrl = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000';
  try {
    await fetch(`${backendUrl}/internal/daemons/events`, {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-token': daemonToken,
      },
      body: JSON.stringify({
        skill_id:   skillId,
        user_id:    userId,
        daemon_id:  daemonId,
        event_type: 'daemon_exit',
        payload:    { exit_code: exitCode },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* best-effort */ }
}
