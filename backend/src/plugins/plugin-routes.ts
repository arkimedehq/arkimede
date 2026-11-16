// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugin-routes.ts
 *
 * A plugin's routes (specs/PLUGINS.md §6.1), as plain data: which declared route a request is for (`:param` segments
 * captured, a literal segment beating a parameter), and how a script's output becomes the HTTP answer.
 */
import type { PluginManifest } from './plugin-manifest';

export type PluginRoute = PluginManifest['contributes']['routes'][number];

/** The route for `method` + `path` (no leading slash) and its parameters; null when none. */
export function matchRoute(routes: PluginRoute[], method: string, path: string): { route: PluginRoute; params: Record<string, string> } | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  let best: { route: PluginRoute; params: Record<string, string>; literals: number } | null = null;
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const pattern = route.path.split('/');
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    let ok = true;
    for (let i = 0; i < pattern.length && ok; i++) {
      if (pattern[i].startsWith(':')) params[pattern[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (pattern[i] === parts[i]) literals++;
      else ok = false;
    }
    if (ok && (!best || literals > best.literals)) best = { route, params, literals };
  }
  return best ? { route: best.route, params: best.params } : null;
}

/**
 * The HTTP answer of a route script: `{ status, body }` from its output when it gives a status (100–599), else the
 * output itself with 200. A failed script is a 502 with its error, never the stack or stderr of the container.
 */
export function routeAnswer(result: { success: boolean; output: unknown; raw: string }): { status: number; body: unknown } {
  if (!result.success) return { status: 502, body: { error: 'The plugin could not answer this request.' } };
  const out = result.output as any;
  if (out && typeof out === 'object' && !Array.isArray(out) && Number.isInteger(out.status) && out.status >= 100 && out.status <= 599) {
    return { status: out.status, body: out.body ?? null };
  }
  return { status: 200, body: result.output ?? (result.raw ? { text: result.raw } : null) };
}
