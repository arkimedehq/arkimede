// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * The agent's Home Assistant tools (ha-tools.service.ts): only exposed entities, found by name / area / domain; an
 * action on them (a lock or a garage door only once confirmed; the server's own services never); history and logbook
 * over a period; the user's person named; a native tool source only for the users allowed.
 */
import { describe, it, expect, vi } from 'vitest';
import { HaToolsService, needsConfirmation } from '../../src/home-assistant/ha-tools.service';

const STATES = [
  { entity_id: 'light.cucina', state: 'off', attributes: { friendly_name: 'Luce cucina' } },
  { entity_id: 'sensor.cucina_temp', state: '21.5', attributes: { friendly_name: 'Temperatura cucina', unit_of_measurement: '°C', device_class: 'temperature' } },
  { entity_id: 'lock.porta', state: 'locked', attributes: { friendly_name: 'Porta di casa' } },
  { entity_id: 'cover.garage', state: 'closed', attributes: { friendly_name: 'Garage', device_class: 'garage' } },
  { entity_id: 'calendar.famiglia', state: 'off', attributes: { friendly_name: 'Famiglia' } },
  { entity_id: 'todo.spesa', state: '2', attributes: { friendly_name: 'Spesa' } },
  { entity_id: 'camera.ingresso', state: 'idle', attributes: { friendly_name: 'Ingresso' } },
  { entity_id: 'person.chloe', state: 'home', attributes: { friendly_name: 'Chloé' } },
];

function setup(allowed = true) {
  const commands: any[] = [];
  const ha = {
    toolsFor: vi.fn(() => allowed),
    exposedStates: vi.fn(() => STATES),
    isExposed: (id: string) => STATES.some((s) => s.entity_id === id),
    areaOf: (id: string) => (id.includes('cucina') ? 'Cucina' : null),
    command: vi.fn(async (msg: any) => {
      commands.push(msg);
      if (msg.type === 'history/history_during_period') return { 'sensor.cucina_temp': [{ s: '20.0', lu: 1_700_000_000 }, { s: '21.5', lu: 1_700_003_600 }] };
      if (msg.return_response && msg.service === 'get_events') return { response: { 'calendar.famiglia': { events: [{ summary: 'Nuoto', start: '2026-11-06T18:00:00+01:00', end: '2026-11-06T19:00:00+01:00' }] } } };
      if (msg.return_response && msg.service === 'get_items') return { response: { 'todo.spesa': { items: [{ summary: 'latte', status: 'needs_action' }] } } };
      if (msg.type === 'logbook/get_events') return [{ when: 1_700_000_000, name: 'Porta di casa', entity_id: 'lock.porta', state: 'unlocked' }, { when: 1_700_000_100, entity_id: 'switch.hidden', state: 'on' }];
      return null;
    }),
    callWithResponse: async (domain: string, service: string, entityId: string, data: any) => {
      const res: any = await ha.command({ type: 'call_service', domain, service, service_data: data, target: { entity_id: entityId }, return_response: true });
      return res?.response?.[entityId];
    },
    cameraImage: vi.fn(async () => ({ mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes') })),
    push: vi.fn(async (person: string) => person === 'person.andrea' || person === 'person.chloe'),
    personStates: () => [
      { entity_id: 'person.andrea', state: 'home', attributes: { friendly_name: 'Andrea' } },
      { entity_id: 'person.chloe', state: 'not_home', attributes: { friendly_name: 'Chloé' } },
      { entity_id: 'person.ospite', state: 'home', attributes: { friendly_name: 'Ospite' } },
    ],
    personRoomName: (p: string) => (p === 'person.andrea' ? 'Cucina' : null),
  };
  const registry = { register: vi.fn(), unregister: vi.fn() };
  const users = { findOne: vi.fn(async () => ({ id: 'u1', haPerson: 'person.andrea' })) };
  const files = { saveToolFile: vi.fn(async (_u: string, name: string, mimeType: string, data: Buffer) => ({ id: 'f1', originalName: name, mimeType, size: data.length, storagePath: `/tmp/${name}` })) };
  const svc = new HaToolsService(ha as any, registry as any, users as any, files as any);
  return { svc, ha, commands, registry, files };
}

const byName = (tools: any[], n: string) => tools.find((t) => t.name === n);

describe('HaToolsService', () => {
  it('is a native tool source for the users allowed, naming their person', async () => {
    const t = setup();
    t.svc.onModuleInit();
    expect(t.registry.register).toHaveBeenCalledWith(t.svc);
    const tools = await t.svc.loadForUser('u1');
    expect(tools.map((x) => x.name)).toEqual(['ha_find_entities', 'ha_get_state', 'ha_call_service', 'ha_history', 'ha_logbook',
      'ha_calendar_events', 'ha_calendar_add', 'ha_todo_items', 'ha_todo_add', 'ha_todo_complete', 'ha_camera_snapshot', 'ha_notify']);
    expect(byName(tools, 'ha_find_entities').description).toContain('person.andrea');
    expect(await setup(false).svc.loadForUser('u1')).toEqual([]);
  });

  it('finds exposed entities by words, area and domain', async () => {
    const tools = setup().svc.tools(null);
    const r = JSON.parse(await byName(tools, 'ha_find_entities').invoke({ query: 'cucina', domain: 'sensor' }));
    expect(r).toEqual({ count: 1, entities: [{ entity_id: 'sensor.cucina_temp', name: 'Temperatura cucina', area: 'Cucina', state: '21.5', attributes: { unit_of_measurement: '°C', device_class: 'temperature' } }] });
    expect(JSON.parse(await byName(tools, 'ha_get_state').invoke({ entity_id: 'switch.hidden' })).error).toMatch(/not an entity exposed/);
  });

  it('acts only on exposed entities; a lock or a garage door only once confirmed; never the server\'s own services', async () => {
    const t = setup();
    const call = byName(t.svc.tools(null), 'ha_call_service');
    expect(JSON.parse(await call.invoke({ domain: 'light', service: 'turn_on', entity_id: 'light.cucina', data: { brightness_pct: 40 } })).ok).toBe(true);
    expect(t.commands[0]).toEqual({ type: 'call_service', domain: 'light', service: 'turn_on', service_data: { brightness_pct: 40 }, target: { entity_id: ['light.cucina'] } });
    expect(JSON.parse(await call.invoke({ domain: 'switch', service: 'turn_off', entity_id: 'switch.hidden' })).error).toMatch(/not exposed/);
    expect(JSON.parse(await call.invoke({ domain: 'lock', service: 'unlock', entity_id: 'lock.porta' }))).toMatchObject({ needs_confirmation: true, entities: ['lock.porta'] });
    expect(JSON.parse(await call.invoke({ domain: 'cover', service: 'open_cover', entity_id: 'cover.garage' })).needs_confirmation).toBe(true);
    expect(JSON.parse(await call.invoke({ domain: 'lock', service: 'unlock', entity_id: 'lock.porta', confirmed: true })).ok).toBe(true);
    expect(JSON.parse(await call.invoke({ domain: 'homeassistant', service: 'restart', entity_id: 'light.cucina' })).error).toMatch(/not available/);
    expect(t.commands).toHaveLength(2);
    expect(needsConfirmation({ entity_id: 'cover.tenda', state: 'open', attributes: { device_class: 'shade' } })).toBe(false);
  });

  it('history and logbook over a period, logbook limited to exposed entities', async () => {
    const t = setup();
    const tools = t.svc.tools(null);
    const h = JSON.parse(await byName(tools, 'ha_history').invoke({ entity_id: 'sensor.cucina_temp', start: '2023-11-14T00:00:00Z', end: '2023-11-15T00:00:00Z' }));
    expect(h.changes).toEqual([{ at: new Date(1_700_000_000_000).toISOString(), state: '20.0' }, { at: new Date(1_700_003_600_000).toISOString(), state: '21.5' }]);
    expect(t.commands[0]).toMatchObject({ type: 'history/history_during_period', entity_ids: ['sensor.cucina_temp'], start_time: '2023-11-14T00:00:00.000Z' });
    const l = JSON.parse(await byName(tools, 'ha_logbook').invoke({}));
    expect(l.events).toEqual([{ at: new Date(1_700_000_000_000).toISOString(), name: 'Porta di casa', entity_id: 'lock.porta', state: 'unlocked' }]);
  });

  it('calendars and to-do lists through service calls that answer', async () => {
    const t = setup();
    const tools = t.svc.tools(null);
    const ev = JSON.parse(await byName(tools, 'ha_calendar_events').invoke({ entity_id: 'calendar.famiglia', start: '2026-11-06T00:00:00Z' }));
    expect(ev.events).toEqual([{ summary: 'Nuoto', start: '2026-11-06T18:00:00+01:00', end: '2026-11-06T19:00:00+01:00' }]);
    expect(t.commands[0]).toMatchObject({ domain: 'calendar', service: 'get_events', return_response: true, service_data: { start_date_time: '2026-11-06T00:00:00.000Z', end_date_time: '2026-11-13T00:00:00.000Z' } });
    await byName(tools, 'ha_calendar_add').invoke({ entity_id: 'calendar.famiglia', summary: 'Pizza', start: '2026-11-07', end: '2026-11-08' });
    expect(t.commands[1]).toMatchObject({ domain: 'calendar', service: 'create_event', service_data: { summary: 'Pizza', start_date: '2026-11-07', end_date: '2026-11-08' } });
    expect(JSON.parse(await byName(tools, 'ha_todo_items').invoke({ entity_id: 'todo.spesa' })).items).toEqual([{ item: 'latte', status: 'needs_action' }]);
    await byName(tools, 'ha_todo_add').invoke({ entity_id: 'todo.spesa', item: 'pane' });
    await byName(tools, 'ha_todo_complete').invoke({ entity_id: 'todo.spesa', item: 'latte' });
    expect(t.commands.slice(-2).map((c) => [c.service, c.service_data])).toEqual([['add_item', { item: 'pane' }], ['update_item', { item: 'latte', status: 'completed' }]]);
    expect(JSON.parse(await byName(tools, 'ha_todo_add').invoke({ entity_id: 'todo.altra', item: 'x' })).error).toMatch(/not a to-do list exposed/);
  });

  it('a camera\'s image is a file shown to the model; a notification goes to the user\'s phone or an exposed person\'s', async () => {
    const t = setup();
    const tools = t.svc.tools('person.andrea', 'u1');
    const [text, artifact] = await (byName(tools, 'ha_camera_snapshot') as any).func({ entity_id: 'camera.ingresso' });
    expect(text).toContain('file_id: f1');
    expect(artifact.toolFiles).toEqual([expect.objectContaining({ fileId: 'f1', mimeType: 'image/jpeg' })]);
    expect(t.files.saveToolFile).toHaveBeenCalledWith('u1', expect.stringMatching(/^camera_ingresso-\d+\.jpg$/), 'image/jpeg', expect.any(Buffer));
    const notify = byName(tools, 'ha_notify');
    expect(JSON.parse(await notify.invoke({ message: 'ciao' }))).toEqual({ ok: true, person: 'person.andrea' });
    expect(JSON.parse(await notify.invoke({ message: 'ciao', person: 'person.chloe' }))).toEqual({ ok: true, person: 'person.chloe' });
    expect(JSON.parse(await notify.invoke({ message: 'x', person: 'person.ospite' })).error).toMatch(/not a person exposed/);
    expect(JSON.parse(await byName(setup().svc.tools(null), 'ha_notify').invoke({ message: 'x' })).error).toMatch(/not linked/);
  });

  it('the home now for the turn: the exposed persons and the user, where they are', async () => {
    const t = setup();
    expect(await t.svc.contextFor('u1')).toBe('<home>Home Assistant now — Andrea (the user): home, Cucina; Chloé: away. The user is person.andrea. Use the ha_* tools for devices and states.</home>');
    expect(await setup(false).svc.contextFor('u1')).toBeNull();
  });
});
