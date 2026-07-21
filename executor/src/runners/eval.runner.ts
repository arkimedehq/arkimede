import ivm from 'isolated-vm';

const MEMORY_LIMIT = parseInt(process.env.JS_MEMORY_LIMIT_MB ?? '128', 10); // MB per isolate

export interface EvalResult {
  ok:      boolean;
  output?: unknown;
  error?:  string;
}

/**
 * Evaluates inline JS code in a sandboxed V8 Isolate (isolated-vm), used by the
 * Flow `transform` node.
 *
 * Contract:
 * - `input` is available as a global variable (immutable object).
 * - The script MUST `return <value>` to produce output (it runs inside an
 *   async function: a plain final expression returns undefined).
 * - The result is copied out of the isolate (`copy: true`) → plain JS object.
 *
 * Guaranteed isolation: no require/import, no fetch, no fs, no process,
 * limited heap, hard timeout. Same guarantees as the skills' JS runner, but
 * without filesystem access or npm module injection (pure data transformation).
 */
export async function evalInlineJs(
  code: string,
  input: Record<string, unknown>,
  timeoutMs = 5000,
): Promise<EvalResult> {
  const isolate = new ivm.Isolate({ memoryLimit: MEMORY_LIMIT });
  try {
    const context = await isolate.createContext();
    const jail = context.global;

    await jail.set('input', new ivm.ExternalCopy(input ?? {}).copyInto());

    // console.log no-op (to avoid breaking scripts that use it)
    await context.eval(`const console = { log: () => {}, error: () => {}, warn: () => {} };`);

    const wrapped = `(async () => { ${code} })()`;
    const script = await isolate.compileScript(wrapped);
    const result = await script.run(context, { timeout: timeoutMs, promise: true, copy: true });

    return { ok: true, output: result };
  } catch (err: any) {
    const isTimeout = /timed out/i.test(err?.message ?? '');
    return { ok: false, error: isTimeout ? `Timeout ${timeoutMs}ms` : (err?.message ?? String(err)) };
  } finally {
    isolate.dispose();
  }
}
