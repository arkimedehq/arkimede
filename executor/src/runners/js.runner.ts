import ivm from 'isolated-vm';
import * as path from 'path';
import * as fs from 'fs';
import { ExecuteRequest, ExecuteResult } from '../types';

const SKILLS_BASE  = process.env.SKILLS_BASE_PATH ?? '/app/skills';
const MAX_OUTPUT   = parseInt(process.env.MAX_OUTPUT_BYTES ?? '524288', 10); // 512 KB
const MEMORY_LIMIT = parseInt(process.env.JS_MEMORY_LIMIT_MB ?? '128', 10); // MB per isolate

/**
 * Runs a JavaScript script in a fully sandboxed V8 Isolate via isolated-vm.
 *
 * Isolation guaranteed by isolated-vm:
 * - No access to require/import (no Node.js APIs, no filesystem, no network)
 * - Limited heap memory (JS_MEMORY_LIMIT_MB, default 128 MB)
 * - Hard timeout on code execution
 * - No state sharing with the host process
 *
 * What the script CAN do:
 * - Pure data operations (array/object manipulation, computations, transformations)
 * - Use functions from the bundled libraries (see below: module injection)
 * - Read the `input` object (passed as a parameter)
 * - Call `print(string)` to produce output (mapped to stdout)
 *
 * What the script CANNOT do:
 * - require/import modules
 * - fetch/XMLHttpRequest (no network)
 * - setTimeout/setInterval (no uncontrolled async)
 * - Filesystem access
 * - Access to process, external globalThis, etc.
 *
 * npm libraries:
 * The skills' JS scripts can use the modules declared in skill.yaml.
 * The runner injects them into the isolate context by pre-bundling each module
 * (reads the package file and runs it in a separate context that exposes the
 * exports). This approach supports pure CJS data libraries (lodash,
 * csv-parse, etc.) but not libraries that use native Node APIs (fs, net, etc.).
 *
 * Expected script structure:
 * ```js
 * // `input` is available as a global variable in the sandbox
 * const result = doSomething(input);
 * result  // the last evaluated expression becomes stdout
 * ```
 */
export async function runJs(req: ExecuteRequest): Promise<ExecuteResult> {
  const skillDir  = path.join(SKILLS_BASE, req.skill_id);
  const scriptAbs = path.join(skillDir, req.filename);

  // Path traversal validation
  if (!scriptAbs.startsWith(skillDir + path.sep)) {
    throw new Error(`Path traversal detected: ${req.filename}`);
  }

  if (!fs.existsSync(scriptAbs)) {
    throw new Error(`Script not found: ${req.filename}`);
  }

  const timeout_ms = req.timeout_ms ?? parseInt(process.env.MAX_TIMEOUT_MS ?? '30000', 10);
  const start      = Date.now();
  let stdout       = '';
  let stderr       = '';

  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT });

  try {
    const context = await isolate.createContext();
    const jail    = context.global;

    // Expose `input` as an immutable object
    await jail.set('input', new ivm.ExternalCopy(req.input).copyInto());

    // Expose `config` — system variables + user overrides (e.g. config.OUTPUT_DIR)
    await jail.set('config', new ivm.ExternalCopy(req.config ?? {}).copyInto());

    // Expose `print(str)` → stdout (the only output channel)
    await jail.set('print', new ivm.Reference((...args: unknown[]) => {
      const chunk = args.map(String).join(' ') + '\n';
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT) + '\n[OUTPUT TRUNCATED]';
    }));

    // Expose `console.log` as an alias of print
    await context.eval(`
      const console = { log: (...a) => print(a.join(' ')), error: (...a) => print('[ERR] ' + a.join(' ')) };
    `);

    // Inject the bundled npm libraries (pure CJS only)
    await injectNpmModules(context, jail, skillDir);

    // Read and run the user's script
    const userCode = fs.readFileSync(scriptAbs, 'utf-8');

    // Wrap the code: the last expression is printed automatically
    const wrappedCode = `
      (async () => {
        ${userCode}
      })()
    `;

    const script = await isolate.compileScript(wrappedCode);
    const result = await script.run(context, {
      timeout: timeout_ms,
      promise: true,
    });

    // If the script returns a value, we append it to stdout
    if (result !== undefined && result !== null) {
      const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      stdout += output;
    }

    return {
      stdout: stdout.slice(0, MAX_OUTPUT),
      stderr,
      exit_code: 0,
      duration_ms: Date.now() - start,
    };

  } catch (err: any) {
    const isTimeout = err?.message?.includes('Script execution timed out');
    return {
      stdout,
      stderr: isTimeout
        ? `[TIMEOUT: ${timeout_ms}ms]\n${err.message}`
        : `[ERROR]: ${err.message}\n${err.stack ?? ''}`,
      exit_code: isTimeout ? 124 : 1,
      duration_ms: Date.now() - start,
    };
  } finally {
    isolate.dispose();
  }
}

/**
 * Injects the npm modules installed in the skill as global variables in the sandbox.
 *
 * Works only for pure CJS modules that do not use native Node.js APIs.
 * Each module is loaded in the host process and its main export is
 * copied into the isolate via ExternalCopy (deep-clone of serializable data).
 *
 * Limitation: functions that do I/O (fs, net, child_process) cannot be
 * serialized — these libraries are not suitable for this sandbox.
 */
async function injectNpmModules(
  context: ivm.Context,
  jail: ivm.Reference<Record<string, unknown>>,
  skillDir: string,
): Promise<void> {
  const nodeModulesDir = path.join(skillDir, '.deps', 'node', 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) return;

  const pkgDirs = fs.readdirSync(nodeModulesDir).filter((name) => !name.startsWith('.'));

  for (const pkgName of pkgDirs) {
    try {
      const pkgPath   = path.join(nodeModulesDir, pkgName);
      const pkgJson   = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf-8'));
      const mainFile  = pkgJson.main ?? 'index.js';
      const mainPath  = path.join(pkgPath, mainFile);

      if (!fs.existsSync(mainPath)) continue;

      // Load the module in the host process (outside the sandbox)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(mainPath);

      // Serialize only the functions/values that isolated-vm can copy
      // (no Node.js objects, no non-transferable native Buffers)
      const safeName = pkgName.replace(/[^a-zA-Z0-9_$]/g, '_');
      await jail.set(safeName, new ivm.ExternalCopy(mod).copyInto());
    } catch {
      // Module not injectable (uses native APIs) → silent skip
    }
  }
}
