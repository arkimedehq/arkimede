// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * A running plugin (specs/PLUGINS.md §6, §8, §9): events are validated, deduplicated and rate-limited, start only the
 * flows of owners who see the plugin (filter and cooldown honoured) and reach only the other plugins that subscribed;
 * a service not approved is denied, a reserved one is unavailable; storage keeps to the quota and to the plugin;
 * notify reaches only the owner or a linked user; agent.ask runs as the linked user or as a guest of the owner; a
 * route runs as the user, only for a user who sees the plugin.
 */
import { describe, it, expect, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PluginRuntimeService, eventMatches } from '../../src/plugins/plugin-runtime.service';
import { fakeRepo } from './helpers/fake-repo';

function plugin(over: Record<string, any> = {}): any {
  return {
    id: 'p1', name: 'test-plugin', ownerId: 'owner', scope: 'org', teamId: null, agentId: null, audience: 'shared', status: 'active', tokenVersion: 1,
    grants: { services: ['notify', 'storage', 'agent.ask', 'perceive', 'presence.report', 'say', 'memory.search'], subscribes: [], network: [], daemons: [], routes: [], pages: [], storageKb: 1 },
    manifest: {
      name: 'test-plugin', label: 'Test', settings: [], subscribes: [], handlers: {},
      events: [{ name: 'record.created', schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }],
      contributes: { routes: [{ method: 'GET', path: 'records/:id', skill: 'records', script: 'scripts/get.py' }], ui: { pages: [] } },
    },
    ...over,
  };
}

function setup(opts: { visible?: (p: any, u: string) => boolean; flows?: any[]; subscribers?: any[]; linked?: Record<string, any>; memory?: boolean; voice?: boolean } = {}) {
  const events = fakeRepo<any>([], { unique: ['pluginId', 'eventId'] });
  const kv = fakeRepo<any>([], { unique: ['pluginId', 'key'] });
  const agents = fakeRepo<any>([{ id: 'agent-1', systemPrompt: 'You are the records agent.' }]);
  const users = fakeRepo<any>([{ id: 'u1', name: 'Alex', role: 'user', haPerson: 'person.alex' }, { id: 'u2', name: 'Sam', role: 'user', haPerson: null }]);
  const plugins = {
    visibleTo: vi.fn(async (p: any, u: string) => (opts.visible ? opts.visible(p, u) : true)),
    subscribers: vi.fn(async () => opts.subscribers ?? []),
    skillId: vi.fn(async (_p: any, name: string) => `skill:${name}`),
    linkedUser: vi.fn(async (_p: any, ext: string) => opts.linked?.[ext] ?? { userId: null, authorized: false, displayName: null }),
    haPersonOf: vi.fn(async (_p: any, ext: string) => {
      const l = opts.linked?.[ext];
      return (l?.userId ? users.rows.find((u: any) => u.id === l.userId)?.haPerson : null) ?? l?.haPerson ?? null;
    }),
    storageUsed: vi.fn(async (id: string) => kv.rows.filter((r) => r.pluginId === id).reduce((n, r) => n + r.bytes, 0)),
    activeFor: vi.fn(async (_name: string, u: string) => {
      if (opts.visible && !opts.visible(plugin(), u)) throw new NotFoundException('Plugin not found');
      return plugin();
    }),
  };
  const flowsRun: Array<{ id: string; input: any }> = [];
  const flows = {
    pluginEventFlows: vi.fn(async () => opts.flows ?? []),
    runByPluginEvent: vi.fn(async (f: any, input: any) => { flowsRun.push({ id: f.id, input }); return {}; }),
  };
  const invoked: any[] = [];
  const skills = { invoke: vi.fn(async (...args: any[]) => { invoked.push(args); return { success: true, output: { status: 200, body: { ok: true } }, raw: '' }; }) };
  const notifications = { create: vi.fn(async (x: any) => ({ id: 'n1', ...x })) };
  const gateway = { emitToUser: vi.fn() };
  const guests = { ask: vi.fn(async (userId: string, _m: any, o: any) => ({ answer: `as ${userId} (${o.asUser ? 'user' : 'guest'})`, chatId: 'c1' })) };
  const memory = {
    capabilities: vi.fn(() => ({ memory: opts.memory ?? true, voice: opts.voice ?? true })),
    perceive: vi.fn(async (): Promise<any> => ({ episodeId: 'e1', duplicate: false, people: [{ personId: 'p', name: 'Secret Name' }], expiresAt: '2026-11-23T00:00:00Z' })),
    placePresence: vi.fn(async () => undefined),
    announce: vi.fn(async (): Promise<string | null> => 'assist_satellite.living'),
  };
  const svc = new PluginRuntimeService(events as any, kv as any, agents as any, users as any, plugins as any, flows as any, skills as any, notifications as any, gateway as any, guests as any, memory as any);
  return { svc, events, kv, plugins, flowsRun, invoked, notifications, gateway, guests, memory };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('plugin events', () => {
  it('accepts declared, valid events once; refuses undeclared or invalid ones', async () => {
    const { svc, events } = setup();
    const res = await svc.emit(plugin(), [
      { id: 'e1', type: 'record.created', data: { id: 'r1' } },
      { id: 'e1', type: 'record.created', data: { id: 'r1' } },
      { id: 'e2', type: 'record.deleted', data: {} },
      { id: 'e3', type: 'record.created', data: { id: 3 } },
      { type: 'record.created', data: { id: 'r4' } },
    ]);
    expect(res.map((r) => r.outcome)).toEqual(['accepted', 'duplicate', 'invalid', 'invalid', 'invalid']);
    expect(events.rows.filter((r) => r.outcome === 'accepted')).toHaveLength(1);
  });

  it('refuses a batch that is not an array or too large', async () => {
    const { svc } = setup();
    await expect(svc.emit(plugin(), 'x' as any)).rejects.toThrow();
    await expect(svc.emit(plugin(), Array.from({ length: 101 }, (_, i) => ({ id: `e${i}` })))).rejects.toThrow();
  });

  it('starts only the flows whose owner sees the plugin, matching the filter, within the cooldown', async () => {
    const flows = [
      { id: 'f-match', userId: 'u-sees', trigger: { plugin: { event: 'test-plugin/record.created', match: { id: 'r1' }, cooldownSeconds: 60 } } },
      { id: 'f-other-value', userId: 'u-sees', trigger: { plugin: { event: 'test-plugin/record.created', match: { id: 'r2' } } } },
      { id: 'f-blind', userId: 'u-blind', trigger: { plugin: { event: 'test-plugin/record.created' } } },
    ];
    const { svc, flowsRun } = setup({ flows, visible: (_p, u) => u !== 'u-blind' });
    await svc.emit(plugin(), [{ id: 'e1', type: 'record.created', data: { id: 'r1' }, subject: { id: 'r1' } }]);
    await svc.emit(plugin(), [{ id: 'e2', type: 'record.created', data: { id: 'r1' } }]);
    await settle();
    expect(flowsRun.map((f) => f.id)).toEqual(['f-match']);
    expect(flowsRun[0].input).toMatchObject({ plugin: 'test-plugin', type: 'test-plugin/record.created', id: 'e1', subject: { id: 'r1' }, data: { id: 'r1' } });
  });

  it('hands the event to subscribed plugins (not to itself, not to an owner who does not see the source)', async () => {
    const sub = (id: string, ownerId: string) => plugin({ id, name: id, ownerId, manifest: { ...plugin().manifest, handlers: { events: { skill: 'h', script: 'scripts/on.py' } } } });
    const { svc, invoked } = setup({ subscribers: [plugin(), sub('sub-ok', 'u-sees'), sub('sub-blind', 'u-blind')], visible: (_p, u) => u !== 'u-blind' });
    await svc.emit(plugin(), [{ id: 'e1', type: 'record.created', data: { id: 'r1' } }]);
    await settle();
    expect(invoked).toHaveLength(1);
    expect(invoked[0].slice(0, 2)).toEqual(['skill:h', 'scripts/on.py']);
    expect(invoked[0][2].event.type).toBe('test-plugin/record.created');
    expect(invoked[0][4]).toBe('u-sees');
  });

  it('matches a trigger filter by equality on top-level fields', () => {
    expect(eventMatches(undefined, { a: 1 })).toBe(true);
    expect(eventMatches({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(eventMatches({ a: '1' }, { a: 1 })).toBe(false);
  });
});

describe('plugin services', () => {
  it('a service not approved is denied; a reserved one is unavailable; an unknown one is not found', async () => {
    const { svc } = setup();
    const p = plugin({ grants: { ...plugin().grants, services: ['notify'] } });
    await expect(svc.call(p, 'storage.get', { key: 'a' })).rejects.toMatchObject({ response: { error: 'denied' } });
    await expect(svc.call(plugin(), 'memory.search', {})).rejects.toMatchObject({ response: { error: 'unavailable' } });
    await expect(svc.call(plugin(), 'shell.exec', {})).rejects.toMatchObject({ response: { error: 'unknown' } });
    expect(await svc.call(p, 'services', {})).toEqual({ services: [{ name: 'notify', available: true }] });
  });

  it('storage keeps within the quota and within the plugin', async () => {
    const { svc } = setup();
    await svc.call(plugin(), 'storage.set', { key: 'a/1', value: { n: 1 } });
    await svc.call(plugin(), 'storage.set', { key: 'b', value: 'x' });
    expect(await svc.call(plugin(), 'storage.get', { key: 'a/1' })).toEqual({ value: { n: 1 } });
    expect(await svc.call(plugin(), 'storage.list', { prefix: 'a/' })).toEqual({ keys: ['a/1'] });
    expect(await svc.call(plugin({ id: 'p2' }), 'storage.get', { key: 'a/1' })).toEqual({ value: null });
    await expect(svc.call(plugin(), 'storage.set', { key: 'big', value: 'x'.repeat(2000) })).rejects.toMatchObject({ response: { error: 'quota' } });
    await svc.call(plugin(), 'storage.delete', { key: 'a/1' });
    expect(await svc.call(plugin(), 'storage.get', { key: 'a/1' })).toEqual({ value: null });
    await expect(svc.call(plugin(), 'storage.get', { key: '' })).rejects.toMatchObject({ response: { error: 'invalid' } });
  });

  it('a LIKE wildcard in the prefix is literal', async () => {
    const { svc } = setup();
    await svc.call(plugin({ grants: { ...plugin().grants, storageKb: 10 } }), 'storage.set', { key: 'a_b', value: 1 });
    await svc.call(plugin({ grants: { ...plugin().grants, storageKb: 10 } }), 'storage.set', { key: 'axb', value: 1 });
    expect(await svc.call(plugin(), 'storage.list', { prefix: 'a_' })).toEqual({ keys: ['a_b'] });
  });

  it('notify reaches the owner, or a linked user — never an unlinked id', async () => {
    const { svc, notifications, gateway } = setup({ linked: { '@alex': { userId: 'u1', authorized: false, displayName: null } } });
    await svc.call(plugin(), 'notify', { title: 'Hi', body: 'There' });
    await svc.call(plugin(), 'notify', { to: { id: '@alex' }, title: 'Hi' });
    await expect(svc.call(plugin(), 'notify', { to: { id: '@stranger' }, title: 'Hi' })).rejects.toMatchObject({ response: { error: 'unknown_recipient' } });
    expect(notifications.create.mock.calls.map((c: any[]) => c[0].userId)).toEqual(['owner', 'u1']);
    expect(gateway.emitToUser).toHaveBeenCalledWith('owner', 'skill_event', expect.objectContaining({ event_type: 'plugin_notify' }));
  });

  it('agent.ask runs as the linked user, else as a guest of the owner, with the agent the admin chose', async () => {
    const { svc, guests } = setup({ linked: { '@alex': { userId: 'u1', authorized: false, displayName: 'Alex' } } });
    const p = plugin({ agentId: 'agent-1' });
    expect(await svc.call(p, 'agent.ask', { from: { id: '@alex' }, conversation: 'room', text: 'hello' })).toEqual({ reply: 'as u1 (user)', chatId: 'c1' });
    expect(await svc.call(p, 'agent.ask', { from: { id: '@guest', name: 'Sam' }, conversation: 'room', text: 'hello' })).toEqual({ reply: 'as owner (guest)', chatId: 'c1' });
    const [, msg, opts] = guests.ask.mock.calls[1] as any[];
    expect(msg).toMatchObject({ externalId: '@guest', displayName: 'Sam', conversation: 'room', authorized: false });
    expect(opts).toMatchObject({ source: 'plugin:test-plugin', agent: { id: 'agent-1' }, asUser: false });
    await expect(svc.call(p, 'agent.ask', { from: { id: '@alex' }, conversation: 'room', text: '' })).rejects.toMatchObject({ response: { error: 'invalid' } });
  });
});

describe('plugin routes', () => {
  it('runs the route script as the user, with the route and the user as input', async () => {
    const { svc, invoked } = setup();
    const res = await svc.route('test-plugin', 'GET', 'records/r1', { q: '1' }, null, { id: 'u1' });
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(invoked[0][0]).toBe('skill:records');
    expect(invoked[0][2]).toEqual({ route: { method: 'GET', path: 'records/r1', params: { id: 'r1' }, query: { q: '1' }, body: null }, user: { id: 'u1', name: 'Alex', isAdmin: false } });
    expect(invoked[0][4]).toBe('u1');
  });

  it('a user who does not see the plugin gets not found; an unknown route is 404', async () => {
    const { svc } = setup({ visible: (_p, u) => u !== 'u-blind' });
    await expect(svc.route('test-plugin', 'GET', 'records/r1', {}, null, { id: 'u-blind' })).rejects.toThrow(NotFoundException);
    expect((await svc.route('test-plugin', 'POST', 'records/r1', {}, null, { id: 'u1' })).status).toBe(404);
  });

  it('a body over 1 MB is refused before any script runs', async () => {
    const { svc, invoked } = setup();
    expect((await svc.route('test-plugin', 'GET', 'records/r1', {}, { x: 'y'.repeat(1024 * 1024) }, { id: 'u1' })).status).toBe(413);
    expect(invoked).toHaveLength(0);
  });
});

describe('plugin services: memory and voice', () => {
  const mine = (over: Record<string, any> = {}) => plugin({ audience: 'personal', scope: 'personal', ...over });

  it('perceive: to the memory the admin chose (org plugin), people as the memory knows them, nothing of the memory back', async () => {
    const t = setup({ linked: { 'face-1': { userId: 'u1', authorized: false, displayName: null }, 'face-2': { userId: 'u2', authorized: false, displayName: null } } });
    const res = await t.svc.call(mine(), 'perceive', {
      text: 'Alex came in through the front door', sensor: 'camera', place: 'Entrance', keepDays: 30,
      people: [{ id: 'face-1', confidence: 0.9 }, { id: 'face-2', confidence: 0.7 }, { id: 'face-9' }],
    });
    expect(res).toEqual({ ok: true, duplicate: false, expiresAt: '2026-11-23T00:00:00Z' });
    expect(t.memory.perceive).toHaveBeenCalledWith('owner', {
      text: 'Alex came in through the front door', sensor: 'camera', place: 'Entrance', keepDays: 30,
      people: [
        { identity: { channel: 'homeassistant', externalId: 'person.alex' }, confidence: 0.9 },   // linked, with a Home Assistant person
        { identity: { channel: 'test-plugin', externalId: 'face-2' }, confidence: 0.7 },           // linked, no Home Assistant person
        { identity: { channel: 'test-plugin', externalId: 'face-9' } },                             // not linked
      ],
    });
  });

  it('only a personal plugin writes to a memory — its owner\'s; a shared one is denied, say speaks for its owner', async () => {
    const t = setup();
    await t.svc.call(mine(), 'perceive', { text: 'x', sensor: 'sensor' });
    expect(t.memory.perceive).toHaveBeenCalledWith('owner', expect.anything());
    await expect(t.svc.call(plugin(), 'perceive', { text: 'x', sensor: 'sensor' })).rejects.toMatchObject({ response: { error: 'denied' } });
    await expect(t.svc.call(plugin(), 'presence.report', { someone: 1 })).rejects.toMatchObject({ response: { error: 'denied' } });
    await t.svc.call(plugin(), 'say', { text: 'x', place: 'Kitchen' });
    expect(t.memory.announce).toHaveBeenCalledWith('owner', 'x', { place: 'Kitchen' });
  });

  it('a personal plugin\'s memory is its owner\'s; no memory chosen or no memory service: unavailable; bad input refused', async () => {
    const t = setup();
    await expect(setup({ memory: false }).svc.call(mine(), 'perceive', { text: 'x', sensor: 'sensor' })).rejects.toMatchObject({ response: { error: 'unavailable' } });
    await expect(t.svc.call(mine(), 'perceive', { text: 'x', sensor: 'radar' })).rejects.toMatchObject({ response: { error: 'invalid' } });
    await expect(t.svc.call(mine(), 'perceive', { text: '', sensor: 'camera' })).rejects.toMatchObject({ response: { error: 'invalid' } });
    await expect(t.svc.call(mine(), 'perceive', { text: 'x', sensor: 'camera', people: [{ id: 'a', confidence: 2 }] })).rejects.toMatchObject({ response: { error: 'invalid' } });
  });

  it('presence.report: a presence at the place (camera) or at home, someone counted', async () => {
    const t = setup();
    await t.svc.call(mine(), 'presence.report', { place: 'Living room', people: [{ id: 'face-9', confidence: 0.8 }], someone: 1 });
    expect(t.memory.placePresence).toHaveBeenCalledWith('owner', {
      channel: 'camera', place: 'Living room', people: [{ identity: { channel: 'test-plugin', externalId: 'face-9' }, confidence: 0.8 }], someone: 1, ttlSeconds: 600,
    });
    await t.svc.call(mine(), 'presence.report', { someone: 2, left: true });
    expect(t.memory.placePresence).toHaveBeenLastCalledWith('owner', { channel: 'home', people: [], someone: 2, ttlSeconds: 600, left: true });
    await expect(t.svc.call(mine(), 'presence.report', { place: 'Living room' })).rejects.toMatchObject({ response: { error: 'invalid' } });
  });

  it('say: at a place or to a linked person\'s room, once a minute per place; no voice: unavailable', async () => {
    const t = setup({ linked: { 'face-1': { userId: 'u1', authorized: false, displayName: null } } });
    expect(await t.svc.call(mine(), 'say', { text: 'Someone is at the door', place: 'Living room' })).toEqual({ ok: true, point: 'assist_satellite.living' });
    expect(t.memory.announce).toHaveBeenCalledWith('owner', 'Someone is at the door', { place: 'Living room' });
    await expect(t.svc.call(mine(), 'say', { text: 'Again', place: 'Living room' })).rejects.toMatchObject({ response: { error: 'rate_limited' } });
    await t.svc.call(mine(), 'say', { text: 'For you', to: { id: 'face-1' } });
    expect(t.memory.announce).toHaveBeenLastCalledWith('owner', 'For you', { person: 'person.alex' });
    await expect(t.svc.call(mine(), 'say', { text: 'x', to: { id: 'face-9' } })).rejects.toMatchObject({ response: { error: 'invalid' } });
    await expect(t.svc.call(mine(), 'say', { text: 'x'.repeat(301), place: 'Kitchen' })).rejects.toMatchObject({ response: { error: 'invalid' } });
    await expect(setup({ voice: false }).svc.call(mine(), 'say', { text: 'x', place: 'Kitchen' })).rejects.toMatchObject({ response: { error: 'unavailable' } });
  });

  it('a person linked to a Home Assistant person without an account: the memory, the presence and say know them as it', async () => {
    const t = setup({ linked: {
      'face-3': { userId: null, authorized: false, displayName: null, haPerson: 'person.kid' },
      'face-2': { userId: 'u2', authorized: false, displayName: null, haPerson: 'person.sam' },   // account without one: the id's
    } });
    await t.svc.call(mine(), 'perceive', { text: 'x', sensor: 'camera', people: [{ id: 'face-3' }, { id: 'face-2' }] });
    expect(t.memory.perceive).toHaveBeenCalledWith('owner', expect.objectContaining({ people: [
      { identity: { channel: 'homeassistant', externalId: 'person.kid' } },
      { identity: { channel: 'homeassistant', externalId: 'person.sam' } },
    ] }));
    await t.svc.call(mine(), 'presence.report', { place: 'Bedroom', people: [{ id: 'face-3' }] });
    expect(t.memory.placePresence).toHaveBeenCalledWith('owner', expect.objectContaining({ people: [{ identity: { channel: 'homeassistant', externalId: 'person.kid' } }] }));
    await t.svc.call(mine(), 'say', { text: 'Dinner', to: { id: 'face-3' } });
    expect(t.memory.announce).toHaveBeenLastCalledWith('owner', 'Dinner', { person: 'person.kid' });
  });

  it('services: perceive and presence need the memory, say the voice; memory.search stays reserved', () => {
    expect(setup({ memory: false, voice: true }).svc.services(mine()).services).toEqual([
      { name: 'notify', available: true }, { name: 'storage', available: true }, { name: 'agent.ask', available: true },
      { name: 'perceive', available: false }, { name: 'presence.report', available: false }, { name: 'say', available: true },
      { name: 'memory.search', available: false },
    ]);
  });
});
