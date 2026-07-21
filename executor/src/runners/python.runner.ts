import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ExecuteRequest, ExecuteResult } from '../types';
import { buildSkillPath } from '../utils';
import { proxyEnv } from './proxy-env';
import { userOutputDir, snapshotOutputs, newOutputs } from './outputs';

const SKILLS_BASE       = process.env.SKILLS_BASE_PATH    ?? '/app/skills';
const SKILLS_OUTPUT_DIR = process.env.SKILLS_OUTPUT_DIR   ?? path.join(SKILLS_BASE, '..', 'skills-output');
const MAX_OUTPUT        = parseInt(process.env.MAX_OUTPUT_BYTES ?? '524288', 10); // 512 KB

// Ensures the shared directory exists at runner startup
if (!fs.existsSync(SKILLS_OUTPUT_DIR)) {
  fs.mkdirSync(SKILLS_OUTPUT_DIR, { recursive: true });
}

/** Minimal logger that uses process.stderr so it doesn't pollute the scripts' stdout */
const log = {
  info:  (msg: string) => process.stderr.write(`[python.runner] ${msg}\n`),
  warn:  (msg: string) => process.stderr.write(`[python.runner] ⚠ ${msg}\n`),
  error: (msg: string) => process.stderr.write(`[python.runner] ✗ ${msg}\n`),
};

/**
 * Runs a Python script in an isolated subprocess.
 *
 * Applied isolation:
 * - PYTHONPATH points to the skill's isolated deps (/app/skills/{id}/.deps/python)
 * - HOME and TMPDIR point to /tmp (no access to the real home)
 * - Minimal PATH (only python3 and system tools)
 * - Hard timeout: SIGKILL after timeout_ms
 * - Output truncated to MAX_OUTPUT_BYTES
 *
 * The input is serialized as JSON and passed to the script via stdin.
 * The script must read from stdin: json.loads(sys.stdin.read())
 *
 * Note: network isolation depends on the container's Docker configuration
 * (no external network in the production environment).
 */
export async function runPython(req: ExecuteRequest): Promise<ExecuteResult> {
  const skillDir  = path.join(SKILLS_BASE, req.skill_id);
  const scriptAbs = path.join(skillDir, req.filename);

  // Path traversal validation
  if (!scriptAbs.startsWith(skillDir + path.sep)) {
    throw new Error(`Path traversal detected: ${req.filename}`);
  }

  if (!fs.existsSync(scriptAbs)) {
    throw new Error(`Script not found: ${req.filename}`);
  }

  const pythonDepsDir = path.join(skillDir, '.deps', 'python');
  const depsExist     = fs.existsSync(pythonDepsDir);
  const timeout_ms    = req.timeout_ms ?? parseInt(process.env.MAX_TIMEOUT_MS ?? '30000', 10);

  // PATH with the skill's Nix profile bin prepended (if present)
  const skillPath = buildSkillPath(skillDir);

  // Per-user deliverables dir + snapshot (for tracking the files produced this run).
  const userOutDir = userOutputDir(req.user_id);
  const outBefore  = snapshotOutputs(userOutDir);

  // Diagnostic log before execution
  log.info(`script=${req.filename}`);
  log.info(`skillDir=${skillDir}`);
  log.info(`PYTHONPATH=${depsExist ? pythonDepsDir : '(no deps)'}`);
  log.info(`PATH (first element)=${skillPath.split(':')[0]}`);
  log.info(`timeout=${timeout_ms}ms`);

  const env: NodeJS.ProcessEnv = {
    // PATH with the skill's Nix profile prepended: the binaries declared in
    // system.nix are reachable from subprocess.run() or os.system().
    PATH:        skillPath,
    HOME:        '/tmp',
    TMPDIR:      '/tmp',
    PYTHONPATH:  depsExist ? pythonDepsDir : '',
    // Disable writing __pycache__ outside /tmp
    PYTHONDONTWRITEBYTECODE: '1',
    // Unbuffered output to capture stdout in real time
    PYTHONUNBUFFERED: '1',

    // ── Internal API: allows scripts to call the backend's /internal/*
    // endpoints (save-config, datasources, vector, files). Auth via signed run
    // token (x-internal-token header) — non-forgeable identity, enforced scope.
    SKILL_ID:             req.skill_id,
    // Identity the skill runs as (C2): enables the access-scoped calls
    // to the backend's internal API (e.g. /internal/files/search).
    USER_ID:              req.user_id ?? '',
    BACKEND_INTERNAL_URL: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000',
    INTERNAL_TOKEN:       req.run_token ?? '',

    // ── Per-user deliverables dir (physical tenant isolation; same subdir the
    // backend `?rel=` download confines to, and where the broker copies out).
    // Shared across a user's own skills (inter-skill file passing, e.g. PDF → Gmail).
    // Accessible from any skill via: os.environ.get('SKILLS_OUTPUT_DIR')
    SKILLS_OUTPUT_DIR: userOutDir,

    // ── Egress proxy (C1) — passthrough: if configured (docker-compose.egress overlay),
    // the subprocesses route the network through the allowlist-proxy. No-op if absent.
    ...proxyEnv(),
  };

  const start = Date.now();
  let stdout  = '';
  let stderr  = '';
  let killed  = false;

  return new Promise((resolve) => {
    log.info(`spawn: python3 ${scriptAbs}`);

    const child = spawn('python3', [scriptAbs], {
      env,
      cwd: skillDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.on('spawn', () => log.info(`subprocess PID=${child.pid}`));

    // Send the input as JSON on stdin.
    // The config vars are injected as a `_config` field in the same JSON object,
    // so the script can read them with: cfg = data.get("_config", {})
    const payload = req.config && Object.keys(req.config).length > 0
      ? { ...req.input, _config: req.config }
      : req.input;
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    // Hard timeout
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeout_ms);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT) + '\n[STDERR TRUNCATED]';
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const duration = Date.now() - start;

      if (killed) {
        log.warn(`KILLED (timeout ${timeout_ms}ms) | duration=${duration}ms`);
      } else if (code === 0) {
        log.info(`exit=0 | duration=${duration}ms | stdout=${stdout.length}B stderr=${stderr.length}B`);
      } else {
        log.error(`exit=${code} | duration=${duration}ms`);
        if (stderr.trim()) log.error(`stderr: ${stderr.trim().slice(0, 800)}`);
      }

      resolve({
        stdout,
        stderr: killed ? `[KILLED: timeout ${timeout_ms}ms]\n` + stderr : stderr,
        exit_code: killed ? 124 : (code ?? 1),
        duration_ms: duration,
        outputs: newOutputs(userOutDir, outBefore),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log.error(`spawn error: ${err.message}`);
      // Common error: python3 not found in the PATH
      if ((err as any).code === 'ENOENT') {
        log.error(`python3 not found in PATH: ${skillPath}`);
      }
      resolve({
        stdout,
        stderr: `[SPAWN ERROR]: ${err.message}\n` + stderr,
        exit_code: 1,
        duration_ms: Date.now() - start,
      });
    });
  });
}
