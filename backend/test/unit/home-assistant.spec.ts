// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Home Assistant as a native integration (home-assistant.service.ts), against a fake Home Assistant: it connects with
 * the admin's URL and token, reads the entities exposed to Assist, tells the memory who is home and in which room (people by their `homeassistant` identity),
 * registers itself as the initiatives' voice channel, says a text on the room's satellite (start_conversation when it
 * listens) and binds the satellite to the chat; off when the settings say so.
 */
import { describe, it, expect, vi } from 'vitest';
import { HomeAssistantService, bearerToken } from '../../src/home-assistant/home-assistant.service';

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeHa() {
  const calls: any[] = [];
  const handlers = new Map<string, (e: any) => void>();
  const socket: any = {
    version: '2026.11.0', onClose: null, url: '', token: '',
    connect: vi.fn(async (url: string, token: string) => { socket.url = url; socket.token = token; }),
    subscribe: vi.fn(async (type: string, h: (e: any) => void) => { handlers.set(type, h); }),
    close: vi.fn(),
    command: vi.fn(async (msg: any) => {
      calls.push(msg);
      switch (msg.type) {
        case 'config/area_registry/list': return [{ area_id: 'cucina', name: 'Cucina' }];
        case 'config/device_registry/list': return [{ id: 'dv', area_id: 'cucina' }, { id: 'ph', area_id: null, name: 'Pixel di Chloé' }];
        case 'get_services': return { notify: { mobile_app_pixel_di_chloe: {}, persistent_notification: {} } };
        case 'config/entity_registry/list': return [
          { entity_id: 'assist_satellite.cucina', device_id: 'dv', area_id: null },
          { entity_id: 'device_tracker.chloe', device_id: 'ph', area_id: null },
          { entity_id: 'sensor.chloe_area', device_id: 'ph', area_id: null },
        ];
        case 'homeassistant/expose_entity/list': return { exposed_entities: { 'light.cucina': { conversation: true }, 'lock.porta': { conversation: true }, 'switch.hidden': { conversation: false } } };
        case 'get_states': return [
          { entity_id: 'light.cucina', state: 'off', attributes: { friendly_name: 'Luce cucina' } },
          { entity_id: 'lock.porta', state: 'locked', attributes: { friendly_name: 'Porta' } },
          { entity_id: 'switch.hidden', state: 'on', attributes: {} },
          { entity_id: 'assist_satellite.cucina', state: 'idle', attributes: { supported_features: 3 } },
          { entity_id: 'person.chloe', state: 'home', attributes: { device_trackers: ['device_tracker.chloe'] } },
          { entity_id: 'sensor.chloe_area', state: 'Cucina', attributes: {} },
        ];
        default: return null;
      }
    }),
  };
  return { socket, calls, handlers };
}

const BASE = { haUrl: 'http://homeassistant.local:8123', haToken: 'tok-1', hasHaToken: true, haPresenceEnabled: true, haVoiceEnabled: true, haToolsEnabled: true, haToolsUserIds: null as string[] | null };

function setup(over: Partial<typeof BASE> = {}) {
  const cfg = { ...BASE, ...over };
  const ha = fakeHa();
  const appConfig = {
    getHomeAssistantConfig: vi.fn(async () => cfg),
    getWyomingConfig: vi.fn(async () => ({ wyomingHandleUserId: 'body' })),
  };
  const focus = { set: vi.fn(), setVoiceTurnListener: vi.fn() };
  const initiatives = { setVoice: vi.fn(), setPush: vi.fn(), roomPresence: vi.fn(async () => undefined) };
  const svc = new HomeAssistantService(appConfig as any, focus as any, initiatives as any);
  svc.newSocket = () => ha.socket;
  return { svc, ha, focus, initiatives };
}

describe('HomeAssistantService', () => {
  it('connects with the admin\'s URL and token, tells who is home and in the kitchen, registers the voice', async () => {
    const t = setup();
    const status = await t.svc.apply();
    expect(t.ha.socket.url).toBe('ws://homeassistant.local:8123/api/websocket');
    expect(t.ha.socket.token).toBe('tok-1');
    expect(status).toMatchObject({ state: 'connected', version: '2026.11.0', memoryUserId: 'body', exposed: 2,
      voicePoints: [{ entityId: 'assist_satellite.cucina', area: 'Cucina', listens: true }], persons: [{ entityId: 'person.chloe', name: 'person.chloe' }] });
    expect(t.svc.exposedStates().map((s) => s.entity_id).sort()).toEqual(['light.cucina', 'lock.porta']);
    expect(t.svc.toolsFor('anyone')).toBe(true);
    expect(t.initiatives.setVoice).toHaveBeenLastCalledWith(t.svc);
    await settle();
    const chloe = { identity: { channel: 'homeassistant', externalId: 'person.chloe' } };
    expect(t.initiatives.roomPresence).toHaveBeenCalledWith('body', expect.objectContaining({ channel: 'home', people: [{ ...chloe, confidence: 1 }] }), undefined);
    expect(t.initiatives.roomPresence).toHaveBeenCalledWith('body', expect.objectContaining({ channel: 'voice', place: 'Cucina', people: [{ ...chloe, confidence: 0.9 }], ttlSeconds: 600 }), 'cucina');
    // She leaves the kitchen (her tracker says nowhere): a departure.
    t.ha.handlers.get('state_changed')!({ data: { entity_id: 'sensor.chloe_area', new_state: { entity_id: 'sensor.chloe_area', state: 'unknown', attributes: {} } } });
    await settle(2_100);
    expect(t.initiatives.roomPresence).toHaveBeenLastCalledWith('body', expect.objectContaining({ channel: 'voice', place: 'Cucina', left: true }), 'cucina');
    t.svc.onModuleDestroy();
  });

  it('a satellite turn is a presence in its room, once the answer is spoken; only the Wyoming user\'s, only a known satellite', async () => {
    const t = setup();
    await t.svc.apply();
    expect(t.focus.setVoiceTurnListener).toHaveBeenLastCalledWith(expect.any(Function));
    await settle();
    t.initiatives.roomPresence.mockClear();
    // By its entity or by its device; someone else's turn, or an unknown satellite: nothing.
    t.svc.voiceTurn({ userId: 'body', satelliteId: 'assist_satellite.cucina', deviceId: null }, 0);
    t.svc.voiceTurn({ userId: 'body', satelliteId: null, deviceId: 'dv' }, 0);
    t.svc.voiceTurn({ userId: 'other', satelliteId: 'assist_satellite.cucina', deviceId: null }, 0);
    t.svc.voiceTurn({ userId: 'body', satelliteId: 'assist_satellite.altro', deviceId: null }, 0);
    await settle();
    expect(t.initiatives.roomPresence).toHaveBeenCalledTimes(2);
    // Chloé's tracker places her in the kitchen: she spoke, as sure as the room sensor.
    expect(t.initiatives.roomPresence).toHaveBeenLastCalledWith('body', expect.objectContaining({
      channel: 'voice', place: 'Cucina', people: [{ identity: { channel: 'homeassistant', externalId: 'person.chloe' }, confidence: 0.9 }],
    }), 'cucina');
    t.svc.onModuleDestroy();
    expect(t.focus.setVoiceTurnListener).toHaveBeenLastCalledWith(null);
  });

  it('says a text on the satellite of the person\'s room (listening) and binds it to the chat', async () => {
    const t = setup();
    await t.svc.apply();
    expect(await t.svc.say('body', 'Chloé, alle 18 hai nuoto.', { person: 'person.chloe' }, 'chat-1')).toBe('assist_satellite.cucina');
    expect(t.focus.set).toHaveBeenCalledWith('body', 'assist_satellite.cucina', 'chat-1', expect.any(Number));
    expect(t.ha.calls.at(-1)).toEqual({ type: 'call_service', domain: 'assist_satellite', service: 'start_conversation',
      service_data: { start_message: 'Chloé, alle 18 hai nuoto.' }, target: { entity_id: 'assist_satellite.cucina' } });
    expect(await t.svc.say('body', 'x', { person: 'person.andrea' }, 'chat-1')).toBeNull(); // not in a room
    t.svc.onModuleDestroy();
  });

  it('off: no connection; no URL: an error; voice off: nothing said; the tools only for the users allowed', async () => {
    const off = setup({ haPresenceEnabled: false, haVoiceEnabled: false, haToolsEnabled: false });
    expect((await off.svc.apply()).state).toBe('off');
    expect(off.ha.socket.connect).not.toHaveBeenCalled();
    expect((await setup({ haUrl: null }).svc.apply())).toMatchObject({ state: 'error', error: 'set the Home Assistant URL and token' });
    const quiet = setup({ haVoiceEnabled: false, haToolsUserIds: ['u-allowed'] });
    await quiet.svc.apply();
    expect(quiet.initiatives.setVoice).not.toHaveBeenCalledWith(quiet.svc);
    expect(await quiet.svc.say('body', 'x', { areaId: 'cucina' }, 'c')).toBeNull();
    expect([quiet.svc.toolsFor('u-allowed'), quiet.svc.toolsFor('someone-else')]).toEqual([true, false]);
    quiet.svc.onModuleDestroy();
  });

  it('reads the Bearer token of the MCP server\'s headers', () => {
    expect(bearerToken({ Authorization: 'Bearer abc ' })).toBe('abc');
    expect(bearerToken({ authorization: 'bearer x' })).toBe('x');
    expect(bearerToken({ 'X-Key': 'y' })).toBeNull();
  });

  it('a push on a person\'s phone: the companion app\'s notify service found from their tracker\'s device', async () => {
    const t = setup();
    await t.svc.apply();
    expect(t.initiatives.setPush).toHaveBeenLastCalledWith(t.svc);
    expect(await t.svc.notifyServiceFor('person.chloe')).toBe('mobile_app_pixel_di_chloe');
    expect(await t.svc.push('person.chloe', 'Nuoto alle 18', 'Arkimede')).toBe(true);
    expect(t.ha.calls.at(-1)).toEqual({ type: 'call_service', domain: 'notify', service: 'mobile_app_pixel_di_chloe', service_data: { message: 'Nuoto alle 18', title: 'Arkimede' } });
    expect(await t.svc.push('person.andrea', 'x')).toBe(false);
    t.svc.fetchImpl = vi.fn(async () => new Response(Buffer.from('img'), { headers: { 'content-type': 'image/jpeg' } })) as any;
    expect(await t.svc.cameraImage('camera.ingresso')).toEqual({ mimeType: 'image/jpeg', data: Buffer.from('img') });
    expect((t.svc.fetchImpl as any).mock.calls[0][0]).toBe('http://homeassistant.local:8123/api/camera_proxy/camera.ingresso');
    t.svc.onModuleDestroy();
  });
});
