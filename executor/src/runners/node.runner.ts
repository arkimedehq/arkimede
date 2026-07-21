import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { ExecuteRequest, ExecuteResult } from '../types';
import { buildSkillPath } from '../utils';
import { proxyEnv } from './proxy-env';
import { userOutputDir, snapshotOutputs, newOutputs } from './outputs';

const SKILLS_BASE       = process.env.SKILLS_BASE_PATH  ?? '/app/skills';
const SKILLS_OUTPUT_DIR = process.env.SKILLS_OUTPUT_DIR ?? path.join(SKILLS_BASE, '..', 'skills-output');
const MAX_OUTPUT        = parseInt(process.env.MAX_OUTPUT_BYTES ?? '524288', 10); // 512 KB

// Ensures the shared directory exists at runner startup
if (!fs.existsSync(SKILLS_OUTPUT_DIR)) {
  fs.mkdirSync(SKILLS_OUTPUT_DIR, { recursive: true });
}

/**
 * Runs a Node.js script in a real subprocess.
 *
 * Identical to the Python runner in protocol and process isolation, but uses
 * `node` instead of `python3`. Suitable for skills that require npm deps with
 * access to Node.js APIs (fs, https, child_process, etc.) or libraries that are
 * not serializable in isolated-vm (puppeteer, pdf-lib, canvas, etc.).
 *
 * Declaration in skill.yaml:
 *   scripts:
 *     - filename: scripts/report.js
 *       language: node          ← uses this runner
 *       description: "..."
 *
 * stdin/stdout protocol (identical to Python):
 *   - stdin:  JSON with the input parameters + _config injected by the backend
 *   - stdout: JSON with the result (the last valid line is used as output)
 *
 * Node script template:
 * ```js
 * const data    = JSON.parse(require('fs').readFileSync(0, 'utf8'));
 * const input   = data;
 * const _config = data._config ?? {};
 *
 * // ... logic ...
 *
 * console.log(JSON.stringify({ success: true, result: '...' }));
 * ```
 *
 * npm deps:
 *   Installed in {skillDir}/.deps/node/node_modules during installation.
 *   NODE_PATH points to that directory, so `require('lodash')` works
 *   without needing a package.json in the script directory.
 *
 * Isolation:
 *   - HOME and TMPDIR → /tmp
 *   - Minimal PATH (only node and system tools)
 *   - Hard timeout: SIGKILL after timeout_ms
 *   - Output truncated to MAX_OUTPUT_BYTES
 *   - Network isolation depends on the container's Docker configuration
 */
export async function runNode(req: ExecuteRequest): Promise<ExecuteResult> {
  const skillDir  = path.join(SKILLS_BASE, req.skill_id);
  const scriptAbs = path.join(skillDir, req.filename);

  // Path traversal validation
  if (!scriptAbs.startsWith(skillDir + path.sep)) {
    throw new Error(`Path traversal detected: ${req.filename}`);
  }

  if (!fs.existsSync(scriptAbs)) {
    throw new Error(`Script not found: ${req.filename}`);
  }

  const nodeDepsDir = path.join(skillDir, '.deps', 'node', 'node_modules');
  const timeout_ms  = req.timeout_ms ?? parseInt(process.env.MAX_TIMEOUT_MS ?? '30000', 10);

  // PATH with the skill's Nix profile bin prepended (if present)
  const skillPath = buildSkillPath(skillDir);

  // Per-user deliverables dir + snapshot (for tracking the files produced this run).
  const userOutDir = userOutputDir(req.user_id);
  const outBefore  = snapshotOutputs(userOutDir);

  const env: NodeJS.ProcessEnv = {
    // PATH with the skill's Nix profile prepended: the binaries declared in
    // system.nix are reachable from child_process.execFile() etc.
    PATH:     skillPath,
    HOME:     process.env.HOME ?? '/tmp',
    TMPDIR:   '/tmp',
    // NODE_PATH allows require('pkg') without a package.json in the script dir
    NODE_PATH: fs.existsSync(nodeDepsDir) ? nodeDepsDir : '',
    // Disable ANSI colors that pollute the JSON output
    NO_COLOR:    '1',
    FORCE_COLOR: '0',

    // ── Internal API: calls to the backend's /internal/* endpoints.
    // Auth via signed run token (x-internal-token header).
    SKILL_ID:             req.skill_id,
    // Identity the skill runs as (C2) — for the access-scoped calls
    // to the backend's internal API (e.g. /internal/files/search).
    USER_ID:              req.user_id ?? '',
    BACKEND_INTERNAL_URL: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:3000',
    INTERNAL_TOKEN:       req.run_token ?? '',

    // ── Per-user deliverables dir (physical tenant isolation; same subdir the
    // backend `?rel=` download confines to). Accessible via process.env.SKILLS_OUTPUT_DIR
    SKILLS_OUTPUT_DIR: userOutDir,

    // ── Remote browser (optional) — injected if configured in the container
    ...(process.env.CHROMIUM_WS_URL ? { CHROMIUM_WS_URL: process.env.CHROMIUM_WS_URL } : {}),

    // ── Egress proxy (C1) — no-op passthrough if not configured
    ...proxyEnv(),
  };

  const start = Date.now();
  let stdout  = '';
  let stderr  = '';
  let killed  = false;

  return new Promise((resolve) => {
    const child = spawn('node', [scriptAbs], {
      env,
      cwd: skillDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send the input as JSON on stdin, with _config injected (same schema as Python)
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
      resolve({
        stdout,
        stderr: killed ? `[KILLED: timeout ${timeout_ms}ms]\n` + stderr : stderr,
        exit_code: killed ? 124 : (code ?? 1),
        duration_ms: Date.now() - start,
        outputs: newOutputs(userOutDir, outBefore),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `[SPAWN ERROR]: ${err.message}\n` + stderr,
        exit_code: 1,
        duration_ms: Date.now() - start,
      });
    });
  });
}
