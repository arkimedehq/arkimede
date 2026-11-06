// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Home Assistant starts flows (ha-triggers.service.ts): an exposed entity's real state change matching a flow's
 * trigger (entity or pattern, from / to) runs it as its owner — when the owner may use Home Assistant — at most once per
 * cooldown, with the change as the input; and the native tool sources' live context for the turn.
 */
import { describe, it, expect, vi } from 'vitest';
import { HaTriggersService, entityMatches } from '../../src/home-assistant/ha-triggers.service';
import { ToolSourcesRegistry } from '../../src/tool-sources/tool-sources.registry';

const st = (state: string, name = 'Campanello') => ({ entity_id: 'x', state, attributes: { friendly_name: name } });

function setup(flows: any[]) {
  const ha = {
    onStateChanged: vi.fn(() => () => undefined),
    isExposed: (id: string) => id !== 'binary_sensor.hidden',
    toolsFor: (u: string) => u !== 'not-allowed',
    areaOf: () => 'Ingresso',
  };
  const flowsService = { homeAssistantFlows: vi.fn(async () => flows), runByHomeAssistant: vi.fn(async () => ({})) };
  const svc = new HaTriggersService(ha as any, flowsService as any);
  return { svc, flowsService };
}

describe('HaTriggersService', () => {
  it('matches an entity or a pattern', () => {
    expect(entityMatches('binary_sensor.campanello', 'binary_sensor.campanello')).toBe(true);
    expect(entityMatches('binary_sensor.*_door', 'binary_sensor.front_door')).toBe(true);
    expect(entityMatches('binary_sensor.*_door', 'binary_sensor.front_window')).toBe(false);
    expect(entityMatches('person.*', 'person.chloe')).toBe(true);
  });

  it('runs the matching flows as their owner, with the change as input; from / to; cooldown; permissions', async () => {
    const doorbell = { id: 'f1', name: 'Campanello', userId: 'u1', trigger: { type: 'home-assistant', ha: { entityId: 'binary_sensor.campanello', to: 'on' } } };
    const home = { id: 'f2', name: 'Chloé a casa', userId: 'u1', trigger: { type: 'home-assistant', ha: { entityId: 'person.*', from: 'not_home', to: 'home', cooldownSeconds: 0 } } };
    const other = { id: 'f3', name: 'Non permesso', userId: 'not-allowed', trigger: { type: 'home-assistant', ha: { entityId: 'binary_sensor.campanello' } } };
    const t = setup([doorbell, home, other]);
    await t.svc.reload();
    const now = Date.parse('2026-11-06T18:00:00Z');
    expect(await t.svc.onChange('binary_sensor.campanello', st('off'), st('on'), now)).toBe(1);
    expect(t.flowsService.runByHomeAssistant).toHaveBeenCalledWith(doorbell, {
      entity_id: 'binary_sensor.campanello', name: 'Campanello', area: 'Ingresso', from: 'off', to: 'on', at: '2026-11-06T18:00:00.000Z',
    });
    expect(await t.svc.onChange('binary_sensor.campanello', st('off'), st('on'), now + 10_000)).toBe(0); // cooldown 30 s
    expect(await t.svc.onChange('binary_sensor.campanello', st('on'), st('off'), now + 60_000)).toBe(0); // to: on only
    expect(await t.svc.onChange('binary_sensor.campanello', st('on'), st('on'), now + 60_000)).toBe(0); // attributes only
    expect(await t.svc.onChange('person.chloe', st('not_home', 'Chloé'), st('home', 'Chloé'), now)).toBe(1);
    expect(await t.svc.onChange('person.chloe', st('unknown', 'Chloé'), st('home', 'Chloé'), now + 1)).toBe(0); // from not_home only
    expect(await t.svc.onChange('binary_sensor.hidden', st('off'), st('on'), now)).toBe(0); // not exposed
  });
});

describe('ToolSourcesRegistry', () => {
  it('joins the sources\' context and tools; a failing source gives nothing, the others still do', async () => {
    const r = new ToolSourcesRegistry();
    r.register({ name: 'a', loadForUser: async () => [{ name: 'a_tool' } as any], contextFor: async () => '<home>…</home>' });
    r.register({ name: 'b', loadForUser: async () => { throw new Error('down'); }, contextFor: async () => { throw new Error('down'); } });
    r.register({ name: 'c', loadForUser: async () => [] });
    expect((await r.loadForUser('u')).map((t) => t.name)).toEqual(['a_tool']);
    expect(await r.contextFor('u')).toBe('<home>…</home>');
    r.unregister('a');
    expect(await r.contextFor('u')).toBeNull();
  });
});
