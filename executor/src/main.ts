import './env';   // loads .env.executor (root) — MUST come before everything else
import Fastify from 'fastify';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { timingSafeEqual } from 'crypto';
import { installSkillDeps } from './install';
import { runPython } from './runners/python.runner';
import { runJs }     from './runners/js.runner';
import { runNode }   from './runners/node.runner';
import { brokerEnabled, runViaBroker } from './runners/broker.runner';
import { evalInlineJs } from './runners/eval.runner';
import { runSandbox, runSandboxViaBroker, sandboxBrokerEnabled, gcSessions, readSessionFile, SandboxRequest } from './runners/sandbox.runner';
import { InstallRequest, ExecuteRequest, DaemonStartRequest } from './types';
import { startDaemon, stopDaemon, listDaemons, getDaemon } from './daemon-manager';

const execFileAsync = promisify(execFile);

const PORT         = parseInt(process.env.PORT          ?? '4000', 10);
const HOST         = process.env.HOST                   ?? '0.0.0.0';
const IS_DEV       = process.env.NODE_ENV !== 'production';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT ?? '5', 10);

let activeConcurrent = 0;

// ─── Logger ───────────────────────────────────────────────────────────────────
// In dev: colorized, readable output (pino-pretty).
// In production: structured JSON (compatible with log aggregators).

const app = Fastify({
  logger: IS_DEV
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize:        true,
            translateTime:   'HH:MM:ss',
            ignore:          'pid,hostname',
            messageFormat:   '{msg}',
            singleLine:      false,
          },
        },
        level: 'debug',
      }
    : { level: 'info' },
});

// ─── Inbound auth (service-to-service mesh) ────────────────────────────────────
// The backend calls the executor with the `x-service-key` header. Fail-closed: without
// SERVICE_API_KEY configured or with a wrong key, all routes (except /health)
// respond 401/503. The executor stays on the internal network anyway (no host port).
const SERVICE_API_KEY = process.env.SERVICE_API_KEY ?? '';

/** Constant-time string compare (avoids a timing side-channel on the service key). */
function safeEqual(a: unknown, b: string): boolean {
  if (typeof a !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'GET' && req.url.startsWith('/health')) return;   // health is free
  if (!SERVICE_API_KEY) {
    reply.code(503).send({ error: 'SERVICE_API_KEY not configured on the executor' });
    return reply;
  }
  if (!safeEqual(req.headers['x-service-key'], SERVICE_API_KEY)) {
    reply.code(401).send({ error: 'unauthorized' });
    return reply;
  }
});

// ─── Startup diagnostics ──────────────────────────────────────────────────────
async function logStartupDiagnostics() {
  // Python version and path
  try {
    const { stdout } = await execFileAsync('python3', ['--version']);
    const version = stdout.trim() || 'unknown';
    app.log.info(`Python: ${version} ($(which python3))`);
  } catch {
    try {
      const { stdout } = await execFileAsync('python3', ['--version'], {
        env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
      });
      app.log.info(`Python: ${stdout.trim()}`);
    } catch (e: any) {
      app.log.warn(`Python not found in PATH: ${e.message}`);
    }
  }

  // Which python3 the current PATH resolves
  try {
    const { stdout } = await execFileAsync('which', ['python3']);
    app.log.info(`python3 path: ${stdout.trim()}`);
  } catch { /* which not available */ }

  // pip3
  try {
    const { stdout } = await execFileAsync('pip3', ['--version']);
    app.log.info(`pip3: ${stdout.trim()}`);
  } catch (e: any) {
    app.log.warn(`pip3 not found: ${e.message}`);
  }

  app.log.info(`SKILLS_BASE_PATH: ${process.env.SKILLS_BASE_PATH ?? '/app/skills'}`);
  app.log.info(`MAX_CONCURRENT: ${MAX_CONCURRENT} | MAX_TIMEOUT: ${process.env.MAX_TIMEOUT_MS ?? '30000'}ms`);
  app.log.info(`NODE_ENV: ${process.env.NODE_ENV ?? 'development'}`);
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async () => ({
  status: 'ok',
  active: activeConcurrent,
  max:    MAX_CONCURRENT,
  // Sandbox runtime mode: 'broker' (isolated container-job), 'in-process'
  // (dev-only, NOT isolated), 'unavailable' (fail-closed, no broker/opt-in).
  sandbox: sandboxBrokerEnabled() ? 'broker'
         : process.env.SANDBOX_ALLOW_INPROCESS === '1' ? 'in-process'
         : 'unavailable',
}));

// ─── POST /install ────────────────────────────────────────────────────────────
app.post<{ Body: InstallRequest }>('/install', {
  schema: {
    body: {
      type: 'object',
      required: ['skill_id'],
      properties: {
        skill_id:    { type: 'string' },
        python_deps: { type: 'array', items: { type: 'string' }, default: [] },
        js_deps:     { type: 'array', items: { type: 'string' }, default: [] },
        nix_deps:    { type: 'array', items: { type: 'string' }, default: [] },
      },
    },
  },
}, async (req, reply) => {
  const { skill_id, python_deps = [], js_deps = [], nix_deps = [] } = req.body;

  app.log.info(`─── INSTALL skill=${skill_id} ───`);
  if (python_deps.length) app.log.info(`  Python deps: ${python_deps.join(', ')}`);
  if (js_deps.length)     app.log.info(`  JS deps:     ${js_deps.join(', ')}`);
  if (nix_deps.length)    app.log.info(`  Nix deps:    ${nix_deps.join(', ')}`);

  try {
    const result = await installSkillDeps(req.body);

    if (result.ok) {
      app.log.info(`  ✓ Installation completed in ${result.duration_ms}ms`);
    } else {
      app.log.error(`  ✗ Installation failed in ${result.duration_ms}ms`);
      if (result.log) app.log.error(`  Log:\n${result.log}`);
    }

    return reply.status(result.ok ? 200 : 500).send(result);

  } catch (err: any) {
    app.log.error(`  ✗ Installation error: ${err.message}`);
    return reply.status(500).send({ ok: false, log: err.message, duration_ms: 0 });
  }
});

// ─── POST /execute ────────────────────────────────────────────────────────────
app.post<{ Body: ExecuteRequest }>('/execute', {
  schema: {
    body: {
      type: 'object',
      required: ['skill_id', 'filename', 'language', 'input'],
      properties: {
        skill_id:   { type: 'string' },
        filename:   { type: 'string' },
        language:   { type: 'string', enum: ['python', 'javascript', 'node'] },
        input:      { type: 'object' },
        timeout_ms: { type: 'number' },
        config:     { type: 'object' },
      },
    },
  },
}, async (req, reply) => {
  if (activeConcurrent >= MAX_CONCURRENT) {
    app.log.warn(`  ⚠ Max concurrency reached (${activeConcurrent}/${MAX_CONCURRENT})`);
    return reply.status(429).send({
      error: 'Too many concurrent executions',
      active: activeConcurrent,
      max:    MAX_CONCURRENT,
    });
  }

  activeConcurrent++;
  const { skill_id, filename, language, input, config } = req.body;

  // Log request — never log config values (they may be secrets)
  const configKeys   = config ? Object.keys(config) : [];
  const inputKeys    = Object.keys(input ?? {});
  const configInfo   = configKeys.length
    ? `config=[${configKeys.join(',')}]`
    : 'config=[]';

  app.log.info(`─── EXECUTE skill=${skill_id} ───`);
  app.log.info(`  script:   ${filename} (${language})`);
  app.log.info(`  input:    [${inputKeys.join(', ')}]`);
  app.log.info(`  ${configInfo}`);
  app.log.info(`  slot:     ${activeConcurrent}/${MAX_CONCURRENT}`);

  try {
    let result;

    // D2: if the broker is configured, python/node run as a hardened container-job
    // (per-job isolation). JS stays in-process (already sandboxed via isolated-vm).
    if (brokerEnabled() && (language === 'python' || language === 'node')) {
      app.log.info('  via broker (container-job)');
      result = await runViaBroker(req.body);
    } else if (language === 'python') {
      result = await runPython(req.body);
    } else if (language === 'node') {
      result = await runNode(req.body);
    } else if (language === 'javascript') {
      result = await runJs(req.body);
    } else {
      activeConcurrent--;
      return reply.status(400).send({ error: `Unsupported language: ${language}` });
    }

    const ok = result.exit_code === 0;

    if (ok) {
      app.log.info(`  ✓ exit=0  duration=${result.duration_ms}ms`);
      // In dev, show a preview of stdout
      if (IS_DEV && result.stdout.trim()) {
        const preview = result.stdout.trim().slice(0, 300);
        app.log.debug(`  stdout preview: ${preview}${result.stdout.length > 300 ? '…' : ''}`);
      }
    } else {
      app.log.error(`  ✗ exit=${result.exit_code}  duration=${result.duration_ms}ms`);
      if (result.stderr.trim()) {
        app.log.error(`  stderr:\n${result.stderr.trim().slice(0, 1000)}`);
      }
      if (result.stdout.trim()) {
        // stdout may contain the script's error JSON
        app.log.error(`  stdout:\n${result.stdout.trim().slice(0, 500)}`);
      }
    }

    return reply.status(ok ? 200 : 422).send(result);

  } catch (err: any) {
    app.log.error(`  ✗ Internal error: ${err.message}`);
    app.log.error(`  stack: ${err.stack ?? ''}`);
    return reply.status(500).send({
      stdout: '',
      stderr: `[INTERNAL ERROR]: ${err.message}`,
      exit_code: 1,
      duration_ms: 0,
    });
  } finally {
    activeConcurrent--;
  }
});

// ─── POST /eval ───────────────────────────────────────────────────────────────
// Evaluates inline JS in the isolated-vm sandbox (Flow `transform` node).
app.post<{ Body: { code: string; input?: Record<string, unknown>; timeout_ms?: number } }>('/eval', {
  schema: {
    body: {
      type: 'object',
      required: ['code'],
      properties: {
        code:       { type: 'string' },
        input:      { type: 'object' },
        timeout_ms: { type: 'number' },
      },
    },
  },
}, async (req, reply) => {
  const { code, input, timeout_ms } = req.body;
  const res = await evalInlineJs(code, input ?? {}, timeout_ms ?? 5000);
  return reply.send(res);
});

// ─── POST /sandbox ──────────────────────────────────────────────────────────
// Runs arbitrary code/shell (run_in_sandbox tool) in a persistent per-session
// (chat) workspace. In dev it runs in-process; in production it goes via the broker.
app.post<{ Body: SandboxRequest }>('/sandbox', {
  schema: {
    body: {
      type: 'object',
      required: ['session_id', 'language', 'code'],
      properties: {
        session_id: { type: 'string' },
        language:   { type: 'string', enum: ['python', 'node', 'shell'] },
        code:       { type: 'string' },
        user_id:    { type: 'string' },
        run_token:  { type: 'string' },
        timeout_ms: { type: 'number' },
        network:    { type: 'string', enum: ['none', 'internal', 'internet', 'open'] },
      },
    },
  },
}, async (req, reply) => {
  if (activeConcurrent >= MAX_CONCURRENT) {
    return reply.status(429).send({ error: 'Too many concurrent executions', active: activeConcurrent, max: MAX_CONCURRENT });
  }
  activeConcurrent++;
  const { session_id, language, code } = req.body;
  const skillNames = (req.body.skills ?? []).map((s) => s.name);
  app.log.info(
    `─── SANDBOX session=${session_id} (${language}) net=${req.body.network ?? 'none'}` +
    `${skillNames.length ? ` skills=[${skillNames.join(', ')}]` : ''} ───`,
  );
  // Log the COMMAND/code actually executed (indented preview, capped at 2000 chars).
  const preview = code.length > 300 ? `${code.slice(0, 300)}\n… [+${code.length - 300} char]` : code;
  app.log.info(`  command:\n${preview.split('\n').map((l) => `    ${l}`).join('\n')}`);
  try {
    let result;
    if (sandboxBrokerEnabled()) {
      // Production path: hardened container-job.
      app.log.info('  via broker (isolated container-job)');
      result = { ...(await runSandboxViaBroker(req.body)), isolated: true };
    } else if (process.env.SANDBOX_ALLOW_INPROCESS === '1') {
      // Dev-ONLY escape hatch: arbitrary code NOT isolated inside the executor.
      app.log.warn('  ⚠ in-process (NOT isolated) — SANDBOX_ALLOW_INPROCESS=1, development only');
      result = { ...(await runSandbox(req.body)), isolated: false };
    } else {
      // Fail-closed: no broker and no dev opt-in → we don't run arbitrary code.
      // (the activeConcurrent decrement is handled by the finally)
      return reply.status(200).send({
        stdout: '',
        stderr: '[sandbox not available: requires the broker (BROKER_URL not configured). ' +
                'In development set SANDBOX_ALLOW_INPROCESS=1 to run without isolation.]',
        exit_code: 1,
        duration_ms: 0,
      });
    }
    app.log.info(
      `  ${result.exit_code === 0 ? '✓' : '✗'} exit=${result.exit_code} duration=${result.duration_ms}ms` +
      `${result.files?.length ? ` files=[${result.files.join(', ')}]` : ''}`,
    );
    return reply.status(200).send(result);
  } catch (err: any) {
    app.log.error(`  ✗ Sandbox error: ${err.message}`);
    return reply.status(500).send({ stdout: '', stderr: `[INTERNAL ERROR]: ${err.message}`, exit_code: 1, duration_ms: 0 });
  } finally {
    activeConcurrent--;
  }
});

// ─── POST /sandbox/file ───────────────────────────────────────────────────────
// Reads a file from the session workspace (for download from chat). Returns
// the base64 content; the backend verifies chat access before calling.
app.post<{ Body: { session_id: string; path: string } }>('/sandbox/file', {
  schema: {
    body: {
      type: 'object',
      required: ['session_id', 'path'],
      properties: { session_id: { type: 'string' }, path: { type: 'string' } },
    },
  },
}, async (req, reply) => {
  const file = readSessionFile(req.body.session_id, req.body.path);
  if (!file) return reply.status(404).send({ error: 'file not found' });
  return reply.send({ ok: true, ...file });
});

// ─── POST /daemon/start ───────────────────────────────────────────────────────
app.post<{ Body: DaemonStartRequest }>('/daemon/start', {
  schema: {
    body: {
      type: 'object',
      required: ['skill_id', 'daemon_id', 'filename', 'language', 'user_id', 'push_url'],
      properties: {
        skill_id:  { type: 'string' },
        daemon_id: { type: 'string' },
        filename:  { type: 'string' },
        language:  { type: 'string', enum: ['python', 'node'] },
        config:    { type: 'object' },
        user_id:   { type: 'string' },
        push_url:  { type: 'string' },
      },
    },
  },
}, async (req, reply) => {
  const { skill_id, daemon_id, filename, language } = req.body;
  app.log.info(`─── DAEMON START skill=${skill_id} daemon=${daemon_id.slice(0, 8)} script=${filename} ───`);
  try {
    const result = startDaemon(req.body);
    app.log.info(`  ✓ PID=${result.pid}`);
    return reply.status(201).send(result);
  } catch (err: any) {
    app.log.error(`  ✗ ${err.message}`);
    return reply.status(400).send({ error: err.message });
  }
});

// ─── POST /daemon/stop ────────────────────────────────────────────────────────
app.post<{ Body: { daemon_id: string } }>('/daemon/stop', {
  schema: {
    body: {
      type: 'object',
      required: ['daemon_id'],
      properties: { daemon_id: { type: 'string' } },
    },
  },
}, async (req, reply) => {
  const { daemon_id } = req.body;
  app.log.info(`─── DAEMON STOP daemon=${daemon_id.slice(0, 8)} ───`);
  const stopped = stopDaemon(daemon_id);
  if (!stopped) {
    app.log.warn(`  Daemon ${daemon_id.slice(0, 8)} not found`);
    return reply.status(404).send({ error: 'Daemon not found or already terminated' });
  }
  app.log.info(`  ✓ stopped`);
  return reply.send({ daemon_id, stopped: true });
});

// ─── GET /daemon/list ─────────────────────────────────────────────────────────
app.get('/daemon/list', async (_req, reply) => {
  return reply.send(listDaemons());
});

// ─── GET /daemon/:id ──────────────────────────────────────────────────────────
app.get<{ Params: { id: string } }>('/daemon/:id', async (req, reply) => {
  const entry = getDaemon(req.params.id);
  if (!entry) return reply.status(404).send({ error: 'Daemon not found' });
  return reply.send(entry);
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
app.listen({ port: PORT, host: HOST }, async (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`skill-executor ready on ${HOST}:${PORT}`);
  await logStartupDiagnostics();

  // Periodic GC of sandbox workspaces (removes sessions inactive for > TTL).
  const GC_INTERVAL = parseInt(process.env.SANDBOX_GC_INTERVAL_MS ?? '3600000', 10); // 1h
  const runGc = () => {
    try { const { removed } = gcSessions(); if (removed) app.log.info(`sandbox GC: ${removed} workspaces removed`); }
    catch (e: any) { app.log.warn(`sandbox GC failed: ${e.message}`); }
  };
  runGc();
  setInterval(runGc, GC_INTERVAL).unref();
});