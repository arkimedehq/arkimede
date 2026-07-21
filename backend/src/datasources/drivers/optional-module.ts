/**
 * @file optional-module.ts
 *
 * Loads an "optional" driver package (mssql, oracledb, better-sqlite3) at runtime,
 * WITHOUT TypeScript requiring its types at build time and without making it depend
 * on app startup. If the package (or its native module) is not installed, it throws
 * a clear error instead of crashing the process.
 *
 * Uses `eval('require')` on purpose: it avoids static module resolution by the
 * compiler (heavy packages may not be present in every environment) — they are
 * loaded only when that engine is actually used.
 */
const dynamicRequire = eval('require') as NodeRequire;

const moduleCache = new Map<string, any>();

export function loadOptional(moduleName: string, engine: string): any {
  if (moduleCache.has(moduleName)) return moduleCache.get(moduleName);
  try {
    const mod = dynamicRequire(moduleName);
    moduleCache.set(moduleName, mod);
    return mod;
  } catch (err: any) {
    if (err?.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Driver "${engine}" unavailable: package "${moduleName}" is not installed on the server.`,
      );
    }
    throw err;
  }
}
