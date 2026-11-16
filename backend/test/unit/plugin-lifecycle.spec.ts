// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The plugins' life cycle (specs/PLUGINS.md §10–11): an unsigned package is refused unless the instance allows it;
 * an installed package waits for approval and creates nothing; approval creates its skills, MCP servers and flows
 * through the existing installers with the plugin's scope; an update that asks nothing new applies at once, one that
 * asks more stops the plugin until approved again; disabling revokes its token; settings reach its scripts and MCP
 * servers (secrets encrypted at rest, MCP secrets as placeholders); people link only to users who see the plugin;
 * uninstalling removes everything; a page's files never leave the package.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import { generateKeyPairSync, sign } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginsService } from '../../src/plugins/plugins.service';
import { PluginTokenGuard } from '../../src/plugins/plugin-token.guard';
import { readPluginToken, sha256Hex } from '../../src/plugins/plugin-trust';
import { fakeRepo } from './helpers/fake-repo';

const SKILL_MD = `---
name: records
description: Records.
runtime:
  scripts:
    - { filename: scripts/list.py, language: python, description: Lists }
    - { filename: scripts/sync.py, language: python, description: Syncs, mode: daemon }
---
`;

function manifestYaml(services: string, audience = '') {
  return `contract: 1
name: test-plugin
version: VERSION
description: A neutral plugin for the tests.${audience ? `\naudience: ${audience}` : ''}
settings:
  - { key: API_URL }
  - { key: API_TOKEN, secret: true }
contributes:
  skills: [skills/records]
  mcp:
    - { name: records, transport: http, url: "\${API_URL}/mcp", headers: { Authorization: "Bearer \${API_TOKEN}" } }
  daemons:
    - { skill: records, script: scripts/sync.py }
  flows: [flows/f.json]
  ui:
    pages:
      - { id: main, title: Records, entry: ui/index.html }
people: { skill: records, script: scripts/list.py }
services: [${services}]
`;
}

function pkg(version = '1.0.0', extraService = '', audience = ''): Buffer {
  const zip = new AdmZip();
  zip.addFile('plugin.yaml', Buffer.from(manifestYaml(extraService ? `notify, ${extraService}` : 'notify', audience).replace('VERSION', version)));
  zip.addFile('skills/records/SKILL.md', Buffer.from(SKILL_MD));
  zip.addFile('skills/records/scripts/list.py', Buffer.from('print(1)'));
  zip.addFile('skills/records/scripts/sync.py', Buffer.from('pass'));
  zip.addFile('flows/f.json', Buffer.from(JSON.stringify({ name: 'Plugin flow', trigger: { type: 'manual' } })));
  zip.addFile('ui/index.html', Buffer.from('<html>page</html>'));
  zip.addFile('ui/app.js', Buffer.from('1'));
  return zip.toBuffer();
}

/** A plugin that needs nothing of the admin: a skill without network, a flow and a page. */
function plainPkg(audience = 'personal'): Buffer {
  const zip = new AdmZip();
  zip.addFile('plugin.yaml', Buffer.from(`contract: 1
name: plain-plugin
version: 1.0.0
description: Nothing that needs the admin.
audience: ${audience}
contributes:
  skills: [skills/records]
  flows: [flows/f.json]
  ui:
    pages:
      - { id: main, title: Records, entry: ui/index.html }
`));
  zip.addFile('skills/records/SKILL.md', Buffer.from(SKILL_MD));
  zip.addFile('skills/records/scripts/list.py', Buffer.from('print(1)'));
  zip.addFile('skills/records/scripts/sync.py', Buffer.from('pass'));
  zip.addFile('flows/f.json', Buffer.from(JSON.stringify({ name: 'Plain flow' })));
  zip.addFile('ui/index.html', Buffer.from('<html></html>'));
  return zip.toBuffer();
}

const ADMIN = { isAdmin: true };

let base: string;
const env = { ...process.env };

function skillName(buf: Buffer): string {
  const md = new AdmZip(buf).getEntries().find((e) => e.entryName.endsWith('SKILL.md'))!;
  return md.getData().toString().match(/name: (\S+)/)![1];
}

function setup(opts: { allowUnsigned?: boolean; teams?: Record<string, string[]> } = {}) {
  const repos = {
    plugin: fakeRepo<any>(), setting: fakeRepo<any>(), event: fakeRepo<any>(), kv: fakeRepo<any>(), identity: fakeRepo<any>(),
    key: fakeRepo<any>(), skill: fakeRepo<any>(), mcp: fakeRepo<any>(), flow: fakeRepo<any>(),
    config: fakeRepo<any>([{ id: 1, pluginsAllowUnsigned: opts.allowUnsigned ?? true }]),
    agent: fakeRepo<any>([{ id: 'agent-1' }]),
    user: fakeRepo<any>([{ id: 'admin' }, { id: 'u-team', haPerson: 'person.team' }, { id: 'u-other' }]),
  };
  const skills = {
    setPluginConfigProvider: vi.fn(),
    setPluginEgressProvider: vi.fn(),
    syncEgress: vi.fn(async () => undefined),
    uploadAndCreate: vi.fn(async (ownerId: string, buf: Buffer) =>
      repos.skill.save({ ownerId, name: skillName(buf), status: 'ready', enabled: true, scope: 'personal', scripts: [{ filename: 'scripts/sync.py' }] })),
    setEnabled: vi.fn(async (id: string, _o: string, enabled: boolean) => repos.skill.update(id, { enabled })),
    remove: vi.fn(async (id: string) => repos.skill.delete(id)),
    approve: vi.fn(async (id: string) => repos.skill.update(id, { isApproved: true })),
    invoke: vi.fn(async (): Promise<any> => ({ success: true, output: { people: [] }, raw: '' })),
  };
  const mcp = {
    create: vi.fn(async (userId: string, dto: any) => repos.mcp.save({ userId, ...dto, enabled: true })),
    upsertSecrets: vi.fn(async () => undefined),
    remove: vi.fn(async (id: string) => repos.mcp.delete(id)),
  };
  const flows = {
    create: vi.fn(async (userId: string, data: any) => repos.flow.save({ userId, ...data })),
    remove: vi.fn(async (id: string) => repos.flow.delete(id)),
  };
  const started: string[] = [];
  const daemons = {
    start: vi.fn(async (_u: string, skillId: string, script: string) => { started.push(`${skillId}:${script}`); return {}; }),
    findAll: vi.fn(async () => started.map((s, i) => ({ id: `d${i}`, skillId: s.split(':')[0], status: 'running' }))),
    stop: vi.fn(async () => { started.length = 0; }),
  };
  const teams = { teamIdsForUser: vi.fn(async (u: string) => opts.teams?.[u] ?? []) };
  const cfg = { get: (k: string, d?: string) => (k === 'PLUGINS_BASE_PATH' ? base : d) };
  const audit = { record: vi.fn(async () => undefined) };
  const svc = new PluginsService(
    repos.plugin as any, repos.setting as any, repos.event as any, repos.kv as any, repos.identity as any, repos.key as any,
    repos.skill as any, repos.mcp as any, repos.flow as any, repos.config as any, repos.agent as any, repos.user as any,
    skills as any, mcp as any, flows as any, daemons as any, teams as any, cfg as any, audit as any,
  );
  return { svc, repos, skills, mcp, flows, daemons, started };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'plugins-'));
  process.env.RUN_TOKEN_SECRET = 'test-secret';
  process.env.TOOL_SECRETS_KEY = 'a'.repeat(64);
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
  process.env = { ...env };
});

describe('PluginsService: install and approve', () => {
  it('refuses an unsigned package when the instance does not allow it', async () => {
    const { svc, repos } = setup({ allowUnsigned: false });
    await expect(svc.install(pkg(), 'admin', ADMIN)).rejects.toThrow(/no valid signature/);
    expect(repos.plugin.rows).toHaveLength(0);
  });

  it('accepts a package signed by a trusted key even when unsigned ones are not allowed', async () => {
    const { svc, repos } = setup({ allowUnsigned: false });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    await repos.key.save({ keyId: 'k1', level: 'verified', publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString() });
    const buf = pkg();
    const signature = sign(null, Buffer.from(sha256Hex(buf), 'hex'), privateKey).toString('base64');
    const review = await svc.install(buf, 'admin', { signature, isAdmin: true });
    expect(review.plugin).toMatchObject({ trust: 'verified', signedBy: 'k1', status: 'pending_approval' });
  });

  it('an installed package waits for approval and creates nothing', async () => {
    const { svc, skills, mcp, flows } = setup();
    const review = await svc.install(pkg(), 'admin', ADMIN);
    expect(review.plugin.status).toBe('pending_approval');
    expect(review.newPermissions).toEqual(['(first approval)']);
    expect(review.permissions.services).toEqual(['notify']);
    expect(skills.uploadAndCreate).not.toHaveBeenCalled();
    expect(mcp.create).not.toHaveBeenCalled();
    expect(flows.create).not.toHaveBeenCalled();
  });

  it('approval creates the contributions with the plugin\'s scope; flows come switched off; daemons start', async () => {
    const { svc, repos, started } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    const approved = await svc.approve(plugin.id, 'admin', { scope: 'team', teamId: 'team-1', agentId: 'agent-1' });
    await settle();
    expect(approved).toMatchObject({ status: 'active', scope: 'team', teamId: 'team-1', agentId: 'agent-1' });
    expect(repos.skill.rows).toEqual([expect.objectContaining({ name: 'records', pluginId: plugin.id, scope: 'team', teamId: 'team-1', isApproved: false })]);
    expect(repos.mcp.rows).toEqual([expect.objectContaining({ name: 'test-plugin-records', pluginId: plugin.id, scope: 'team', enabled: false })]);
    expect(repos.flow.rows).toEqual([expect.objectContaining({ name: 'Plugin flow', pluginId: plugin.id, enabled: false, scope: 'team' })]);
    expect(started).toEqual([`${repos.skill.rows[0].id}:scripts/sync.py`]);
    expect(approved.grants?.services).toEqual(['notify']);
  });

  it('org-wide, its skills go through the skills\' approval (which opens their network domains)', async () => {
    const { svc, repos, skills } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin', { scope: 'org' });
    expect(skills.approve).toHaveBeenCalledWith(repos.skill.rows[0].id);
    expect(repos.skill.rows[0]).toMatchObject({ scope: 'org', isApproved: true });
  });

  it('an unknown agent or a team scope without a team is refused', async () => {
    const { svc } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await expect(svc.approve(plugin.id, 'admin', { agentId: 'nope' })).rejects.toThrow(/Agent not found/);
    await expect(svc.approve(plugin.id, 'admin', { scope: 'team' })).rejects.toThrow(/teamId/);
  });
});

describe('PluginsService: updates', () => {
  async function active() {
    const s = setup();
    const { plugin } = await s.svc.install(pkg('1.0.0'), 'admin', ADMIN);
    await s.svc.approve(plugin.id, 'admin');
    await settle();
    return { ...s, id: plugin.id };
  }

  it('an update that asks nothing new replaces the version at once; flows keep whether they were on', async () => {
    const { svc, repos, id } = await active();
    await repos.flow.update({ pluginId: id }, { enabled: true });
    const review = await svc.install(pkg('1.1.0'), 'admin', ADMIN);
    expect(review.plugin).toMatchObject({ status: 'active', version: '1.1.0' });
    expect(repos.flow.rows).toEqual([expect.objectContaining({ name: 'Plugin flow', enabled: true })]);
  });

  it('an update keeps the network the admin gave its skills', async () => {
    const { svc, repos, id } = await active();
    await repos.skill.update({ pluginId: id }, { networkMode: 'open', grantedNetworks: ['lan'] });
    await svc.install(pkg('1.1.0'), 'admin', ADMIN);
    expect(repos.skill.rows).toEqual([expect.objectContaining({ name: 'records', networkMode: 'open', grantedNetworks: ['lan'] })]);
  });

  it('an update that asks a new service stops the plugin until approved again, and revokes its token', async () => {
    const { svc, repos, id } = await active();
    const before = (await svc.findOne(id)).tokenVersion;
    const review = await svc.install(pkg('2.0.0', 'agent.ask'), 'admin', ADMIN);
    expect(review.plugin.status).toBe('pending_approval');
    expect(review.newPermissions).toEqual(['service: agent.ask']);
    expect((await svc.findOne(id)).tokenVersion).toBeGreaterThan(before);
    expect(repos.skill.rows.every((s) => s.enabled === false)).toBe(true);
    await svc.approve(id, 'admin');
    expect(await svc.findOne(id)).toMatchObject({ status: 'active', version: '2.0.0' });
  });

  it("an update of a chosen copy (another user's too) keeps its owner, settings and people; the same version reinstalls; another plugin is refused", async () => {
    const { svc, repos } = setup();
    const { plugin } = await svc.install(pkg('1.0.0'), 'admin', { ...ADMIN, forUserId: 'u-team' });
    await svc.approve(plugin.id, 'admin');
    await settle();
    await svc.setSettings(plugin.id, { API_URL: 'https://records.example' }, 'admin');
    await svc.setIdentity(plugin.id, 'kid', { haPerson: 'person.kid' }, 'admin');
    const review = await svc.install(pkg('1.1.0'), 'admin', { ...ADMIN, targetId: plugin.id });
    expect(review.plugin).toMatchObject({ id: plugin.id, ownerId: 'u-team', status: 'active', version: '1.1.0' });
    expect(repos.plugin.rows).toHaveLength(1);
    expect((await svc.configFor(plugin.id)).API_URL).toBe('https://records.example');
    expect(repos.identity.rows).toEqual([expect.objectContaining({ externalId: 'kid', haPerson: 'person.kid' })]);
    expect((await svc.install(pkg('1.1.0'), 'admin', { ...ADMIN, targetId: plugin.id })).plugin).toMatchObject({ id: plugin.id, status: 'active' });
    await expect(svc.install(plainPkg(), 'admin', { ...ADMIN, targetId: plugin.id })).rejects.toThrow(/not test-plugin/);
    expect(repos.plugin.rows).toHaveLength(1);
  });

  it('rejecting an update leaves the plugin disabled on the version it had', async () => {
    const { svc, id } = await active();
    await svc.install(pkg('2.0.0', 'agent.ask'), 'admin', ADMIN);
    await svc.reject(id, 'admin');
    expect(await svc.findOne(id)).toMatchObject({ status: 'disabled', version: '1.0.0', pendingManifest: null });
  });
});

describe('PluginsService: running', () => {
  it('disabling revokes the token: the guard refuses it; enabling gives a new one', async () => {
    const { svc, repos } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin');
    const guard = new PluginTokenGuard(repos.plugin as any);
    const ctx = (token: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { 'x-plugin-token': token } }) }) }) as any;
    const token = (await svc.configFor(plugin.id)).PLUGIN_TOKEN;
    await expect(guard.canActivate(ctx(token))).resolves.toBe(true);
    await svc.disable(plugin.id, 'admin');
    await expect(guard.canActivate(ctx(token))).rejects.toThrow(/revoked/);
    expect(await svc.configFor(plugin.id)).toEqual({});
    await svc.enable(plugin.id, 'admin');
    const fresh = (await svc.configFor(plugin.id)).PLUGIN_TOKEN;
    expect(readPluginToken(fresh)!.v).toBeGreaterThan(readPluginToken(token)!.v);
    await expect(guard.canActivate(ctx(fresh))).resolves.toBe(true);
  });

  it('settings: secrets encrypted at rest, in clear for the scripts, as placeholders for MCP; unknown keys refused', async () => {
    const { svc, repos, mcp } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin');
    await svc.setSettings(plugin.id, { API_URL: 'https://records.example', API_TOKEN: 'tok-123' }, 'admin');
    const stored = repos.setting.rows.find((r) => r.key === 'API_TOKEN')!;
    expect(stored.value).not.toContain('tok-123');
    expect((await svc.settings(plugin.id)).find((s) => s.key === 'API_TOKEN')).toMatchObject({ value: null, set: true, secret: true });
    const cfg = await svc.configFor(plugin.id);
    expect(cfg).toMatchObject({ API_URL: 'https://records.example', API_TOKEN: 'tok-123', PLUGIN_NAME: 'test-plugin' });
    expect(repos.mcp.rows[0]).toMatchObject({ url: 'https://records.example/mcp', headers: { Authorization: 'Bearer {{secret.API_TOKEN}}' }, enabled: true });
    expect(mcp.upsertSecrets).toHaveBeenCalledWith(repos.mcp.rows[0].id, { API_TOKEN: 'tok-123' });
    await expect(svc.setSettings(plugin.id, { OTHER: 'x' }, 'admin')).rejects.toThrow(/Unknown setting/);
  });

  it("egress: an active plugin's MCP hosts (settings filled in) reach the proxy; disabled or uninstalled, they do not", async () => {
    const { svc, skills } = setup();
    svc.onModuleInit(); // registers the provider and syncs again: the skills synced before it existed
    expect(skills.setPluginEgressProvider).toHaveBeenCalled();
    expect(skills.syncEgress).toHaveBeenCalled();
    svc.onModuleDestroy();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin');
    expect(await svc.egressHosts()).toEqual([]); // the URL still misses its setting
    skills.syncEgress.mockClear();
    await svc.setSettings(plugin.id, { API_URL: 'http://192.168.1.50:8090', API_TOKEN: 't' }, 'admin');
    expect(skills.syncEgress).toHaveBeenCalled();
    expect(await svc.egressHosts()).toEqual(['192.168.1.50/32']);
    await svc.setSettings(plugin.id, { API_URL: 'https://Records.Example' }, 'admin');
    expect(await svc.egressHosts()).toEqual(['records.example']);
    skills.syncEgress.mockClear();
    await svc.disable(plugin.id, 'admin');
    expect(skills.syncEgress).toHaveBeenCalled();
    expect(await svc.egressHosts()).toEqual([]);
    await svc.enable(plugin.id, 'admin');
    expect(await svc.egressHosts()).toEqual(['records.example']);
    skills.syncEgress.mockClear();
    await svc.uninstall(plugin.id, 'admin');
    expect(skills.syncEgress).toHaveBeenCalled();
    expect(await svc.egressHosts()).toEqual([]);
  });

  it('the people the plugin knows: from its people script, as its owner, checked, recent first, kept a minute; a failure gives none', async () => {
    const { svc, skills } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    expect(await svc.knownPeople(plugin.id)).toEqual({ available: false, people: [] });   // not active yet
    await svc.approve(plugin.id, 'admin');
    skills.invoke.mockResolvedValueOnce({ success: true, raw: '', output: { people: [
      { id: 'Sam_Doe', name: 'Sam', lastSeen: '2026-11-01T10:00:00Z' },
      { id: ' Alex ', name: 'Alex', lastSeen: '2026-11-10T10:00:00Z' },
      { id: 'Sam_Doe', name: 'dup' }, { id: '' }, { name: 'no id' }, { id: 'Kim' },
    ] } });
    const first = await svc.knownPeople(plugin.id);
    expect(first).toEqual({ available: true, people: [
      { id: 'Alex', name: 'Alex', lastSeen: '2026-11-10T10:00:00.000Z' },
      { id: 'Sam_Doe', name: 'Sam', lastSeen: '2026-11-01T10:00:00.000Z' },
      { id: 'Kim', name: null, lastSeen: null },
    ] });
    expect(skills.invoke).toHaveBeenCalledWith(expect.any(String), 'scripts/list.py', {}, expect.any(Number), 'admin');
    expect(await svc.knownPeople(plugin.id)).toEqual(first);   // cached
    expect(skills.invoke).toHaveBeenCalledTimes(1);
    skills.invoke.mockResolvedValueOnce({ success: false, output: null, raw: 'boom' });
    expect(await svc.knownPeople(plugin.id, true)).toEqual({ available: false, people: [] });
  });

  it('a person linked to a Home Assistant person: only an admin links it; the account\'s own wins, else the id\'s', async () => {
    const { svc } = setup({ teams: { 'u-team': ['team-1'] } });
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin', { scope: 'team', teamId: 'team-1' });
    const p = await svc.findOne(plugin.id);
    await expect(svc.setIdentity(plugin.id, 'kid', { haPerson: 'person.kid' }, 'u-team', false)).rejects.toThrow(/Only an admin/);
    await expect(svc.setIdentity(plugin.id, 'kid', { haPerson: 'sensor.kid' }, 'admin')).rejects.toThrow(/Invalid Home Assistant person/);
    await svc.setIdentity(plugin.id, 'kid', { haPerson: 'person.kid' }, 'admin');
    expect(await svc.haPersonOf(p, 'kid')).toBe('person.kid');
    await svc.setIdentity(plugin.id, 'boss', { userId: 'u-team', haPerson: 'person.other' }, 'admin');
    expect(await svc.haPersonOf(p, 'boss')).toBe('person.team');
    await svc.setIdentity(plugin.id, 'kid', { haPerson: null }, 'admin');
    expect(await svc.haPersonOf(p, 'kid')).toBeNull();
    expect(await svc.haPersonOf(p, 'nobody')).toBeNull();
  });

  it('people link only to users who see the plugin; a scope change unlinks those who no longer do', async () => {
    const { svc } = setup({ teams: { 'u-team': ['team-1'] } });
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin', { scope: 'team', teamId: 'team-1' });
    await expect(svc.setIdentity(plugin.id, '@other', { userId: 'u-other' }, 'admin')).rejects.toThrow(/does not see/);
    await svc.setIdentity(plugin.id, '@member', { userId: 'u-team' }, 'admin');
    expect(await svc.linkedUser(await svc.findOne(plugin.id), '@member')).toMatchObject({ userId: 'u-team' });
    await svc.setAccess(plugin.id, 'admin', { scope: 'personal' });
    expect(await svc.linkedUser(await svc.findOne(plugin.id), '@member')).toMatchObject({ userId: null });
  });

  it('visibility follows the scope, as for skills and tools', async () => {
    const { svc } = setup({ teams: { 'u-team': ['team-1'] } });
    expect(await svc.visibleTo({ scope: 'org', ownerId: 'admin', teamId: null }, 'u-other')).toBe(true);
    expect(await svc.visibleTo({ scope: 'team', ownerId: 'admin', teamId: 'team-1' }, 'u-team')).toBe(true);
    expect(await svc.visibleTo({ scope: 'team', ownerId: 'admin', teamId: 'team-1' }, 'u-other')).toBe(false);
    expect(await svc.visibleTo({ scope: 'personal', ownerId: 'admin', teamId: null }, 'u-other')).toBe(false);
  });

  it('uninstalling removes contributions, files and the plugin', async () => {
    const { svc, repos } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin');
    await svc.uninstall(plugin.id, 'admin');
    expect([repos.plugin.rows, repos.skill.rows, repos.mcp.rows, repos.flow.rows]).toEqual([[], [], [], []]);
    expect(fs.existsSync(path.join(base, plugin.id))).toBe(false);
  });

  it('a page file never leaves the package (traversal, absolute paths, symlinks)', async () => {
    const { svc } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    await svc.approve(plugin.id, 'admin');
    expect(svc.packageFile(plugin.id, 'ui/index.html')).toMatch(/ui\/index.html$/);
    expect(svc.packageFile(plugin.id, '../../etc/passwd')).toBeNull();
    expect(svc.packageFile(plugin.id, '/etc/passwd')).toBeNull();
    fs.symlinkSync('/etc/hosts', path.join(base, plugin.id, 'current', 'ui', 'link'));
    expect(svc.packageFile(plugin.id, 'ui/link')).toBeNull();
  });

  it('the menu lists the pages of active plugins the user sees', async () => {
    const { svc } = setup();
    const { plugin } = await svc.install(pkg(), 'admin', ADMIN);
    expect(await svc.pagesFor('u-other')).toEqual([]);
    await svc.approve(plugin.id, 'admin', { scope: 'personal' });
    expect(await svc.pagesFor('u-other')).toEqual([]);
    expect(await svc.pagesFor('admin')).toEqual([{ name: 'test-plugin', label: 'test-plugin', pages: [{ id: 'main', title: 'Records' }] }]);
  });
});

describe('PluginsService: personal and shared (specs/EXTENSION_AUDIENCE.md)', () => {
  it('a user installs from a trusted source only: an unsigned ZIP is refused, the registry is accepted', async () => {
    const { svc } = setup({ allowUnsigned: true });
    await expect(svc.install(plainPkg(), 'u-other')).rejects.toThrow(/registry or signed/);
    const review = await svc.install(plainPkg(), 'u-other', { fromRegistry: true });
    expect(review.plugin).toMatchObject({ ownerId: 'u-other', scope: 'personal', audience: 'personal' });
  });

  it('a user\'s copy that needs nothing of the admin runs at once; one that reaches network, core or resources waits', async () => {
    const { svc, repos } = setup();
    const plain = await svc.install(plainPkg(), 'u-other', { fromRegistry: true });
    expect(await svc.findOne(plain.plugin.id)).toMatchObject({ status: 'active', approvedBy: null });
    expect(repos.skill.rows.find((r) => r.pluginId === plain.plugin.id)).toMatchObject({ ownerId: 'u-other', scope: 'personal' });
    const heavy = await svc.install(pkg(), 'u-other', { fromRegistry: true });
    expect(heavy.plugin.status).toBe('pending_approval');
  });

  it('every user has their own copy; an admin installs one on a user\'s behalf; each reaches their own', async () => {
    const { svc } = setup();
    const mine = await svc.install(plainPkg(), 'u-other', { fromRegistry: true });
    const theirs = await svc.install(plainPkg(), 'admin', { ...ADMIN, forUserId: 'u-team' });
    expect(theirs.plugin).toMatchObject({ ownerId: 'u-team', status: 'pending_approval' });
    await svc.approve(theirs.plugin.id, 'admin');
    expect((await svc.activeFor('plain-plugin', 'u-other')).id).toBe(mine.plugin.id);
    expect((await svc.activeFor('plain-plugin', 'u-team')).id).toBe(theirs.plugin.id);
    await expect(svc.activeFor('plain-plugin', 'admin')).rejects.toThrow(/not found/);
    await expect(svc.install(plainPkg(), 'u-other', { fromRegistry: true, forUserId: 'u-team' })).rejects.toThrow(/admin/);
    expect(svc.canManage(await svc.findOne(mine.plugin.id), { id: 'u-team' })).toBe(false);
    expect(svc.canManage(await svc.findOne(mine.plugin.id), { id: 'x', role: 'admin' })).toBe(true);
  });

  it('a personal plugin is never shared; a shared one only by an admin; a user may pick the agent of their own copy', async () => {
    const { svc, repos } = setup();
    const { plugin } = await svc.install(pkg('1.0.0', '', 'personal'), 'admin', ADMIN);
    await expect(svc.approve(plugin.id, 'admin', { scope: 'org' })).rejects.toThrow(/personal/);
    const shared = await svc.install(plainPkg('shared'), 'u-other', { fromRegistry: true });
    await expect(svc.setAccess(shared.plugin.id, 'u-other', { scope: 'org' }, false)).rejects.toThrow(/Only an admin/);
    expect(await svc.setAccess(shared.plugin.id, 'admin', { scope: 'org' }, true)).toMatchObject({ scope: 'org' });
    await repos.agent.save({ id: 'agent-mine', userId: 'u-team' });
    const own = await svc.install(plainPkg(), 'u-team', { fromRegistry: true });
    expect(await svc.setAccess(own.plugin.id, 'u-team', { agentId: 'agent-mine' }, false)).toMatchObject({ agentId: 'agent-mine' });
    await expect(svc.setAccess(own.plugin.id, 'u-team', { agentId: 'agent-1' }, false)).rejects.toThrow(/Agent not found/);
  });
});
