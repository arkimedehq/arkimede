// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * A plugin page's files (specs/PLUGINS.md §7.2): served only under the folders of the declared page entries, after
 * normalizing the path — `ui/../plugin.yaml` is not under `ui/` — only with a valid page token, for a user who sees an
 * active plugin, and always with the CSP that forbids any network call.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PluginUiController, pagePath } from '../../src/plugins/plugins.controller';
import { mintPageToken } from '../../src/plugins/plugin-trust';

const previous = process.env.RUN_TOKEN_SECRET;
beforeAll(() => { process.env.RUN_TOKEN_SECRET = 'test-secret-for-pages'; });
afterAll(() => { process.env.RUN_TOKEN_SECRET = previous; });

describe('pagePath', () => {
  it('normalizes, and refuses what is absolute, climbs out or is empty', () => {
    expect(pagePath('ui/app.js')).toBe('ui/app.js');
    expect(pagePath('ui/./a/../app.js')).toBe('ui/app.js');
    expect(pagePath('ui/../plugin.yaml')).toBe('plugin.yaml');
    expect(pagePath('../x')).toBeNull();
    expect(pagePath('ui/../../x')).toBeNull();
    expect(pagePath('/etc/passwd')).toBeNull();
    expect(pagePath('ui\\..\\x')).toBeNull();
    expect(pagePath('')).toBeNull();
  });
});

describe('PluginUiController', () => {
  const plugin = {
    id: 'p1', name: 'notes', status: 'active', scope: 'org', ownerId: 'o', teamId: null,
    manifest: { contributes: { ui: { pages: [{ id: 'main', title: 'Main', entry: 'ui/index.html' }] } } },
  };

  function serve(rel: string, opts: { token?: string; visible?: boolean; status?: string } = {}) {
    const plugins = {
      findOne: vi.fn(async () => ({ ...plugin, status: opts.status ?? 'active' })),
      visibleTo: vi.fn(async () => opts.visible ?? true),
      packageFile: vi.fn((_n: string, r: string) => `/pkg/${r}`),
    };
    const headers: Record<string, string> = {};
    const res: any = {
      code: 200, sent: null as string | null,
      status(c: number) { this.code = c; return this; },
      type() { return this; },
      send(x: string) { this.sent = x; return this; },
      setHeader(k: string, v: string) { headers[k] = v; },
      sendFile(f: string) { this.sent = f; },
    };
    const ctrl = new PluginUiController(plugins as any);
    return ctrl.file(opts.token ?? mintPageToken('p1', 'u1'), { params: { 0: rel } } as any, res).then(() => ({ res, headers, plugins }));
  }

  it('serves a file under a page folder, with the CSP that forbids any network call', async () => {
    const { res, headers } = await serve('ui/app.js');
    expect(res.sent).toBe('/pkg/ui/app.js');
    expect(headers['Content-Security-Policy']).toContain("connect-src 'none'");
    expect(headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('never serves files outside the pages\' folders, even through ../', async () => {
    for (const rel of ['plugin.yaml', 'ui/../plugin.yaml', 'skills/notes/scripts/add.py', '../../etc/passwd']) {
      const { res, plugins } = await serve(rel);
      expect(res.code, rel).toBe(404);
      expect(plugins.packageFile).not.toHaveBeenCalled();
    }
  });

  it('refuses a bad token, a user who does not see the plugin, or a plugin that is not active', async () => {
    expect((await serve('ui/index.html', { token: 'x.y' })).res.code).toBe(404);
    expect((await serve('ui/index.html', { visible: false })).res.code).toBe(404);
    expect((await serve('ui/index.html', { status: 'disabled' })).res.code).toBe(404);
  });
});
