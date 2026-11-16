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
          { entity_id: 'binary_sensor.ph_focus', device_id: 'ph', area_id: null, platform: 'mobile_app', unique_id: 'wh1_focus' },
        ];
        case 'homeassistant/expose_entity/list': return { exposed_entities: { 'light.cucina': { conversation: true }, 'lock.porta': { conversation: true }, 'switch.hidden': { conversation: false } } };
        case 'get_states': return [
          { entity_id: 'light.cucina', state: 'off', attributes: { friendly_name: 'Luce cucina' } },
          { entity_id: 'lock.porta', state: 'locked', attributes: { friendly_name: 'Porta' } },
          { entity_id: 'switch.hidden', state: 'on', attributes: {} },
          { entity_id: 'assist_satellite.cucina', state: 'idle', attributes: { supported_features: 3 } },
          { entity_id: 'person.chloe', state: 'home', attributes: { device_trackers: ['device_tracker.chloe'] } },
          { entity_id: 'sensor.chloe_area', state: 'Cucina', attributes: {} },
          { entity_id: 'binary_sensor.ph_focus', state: 'off', attributes: {} },
        ];
        default: return null;
      }
    }),
  };
  return { socket, calls, handlers };
}

const BASE = { haUrl: 'http://homeassistant.local:8123', haToken: 'tok-1', hasHaToken: true, haPresenceEnabled: true, haBusyEnabled: false, haVoiceEnabled: true, haToolsEnabled: true, haToolsUserIds: null as string[] | null,
  haPerceptionsEnabled: false, haPerceptionEntities: [] as string[] };

function setup(over: Partial<typeof BASE> = {}, voice: { satellites?: Record<string, string>; own?: Array<{ userId: string; person: string }>; modes?: Record<string, 'personal' | 'entity'> } = {}) {
  const cfg = { ...BASE, ...over };
  const ha = fakeHa();
  // 'body': the Home Assistant memory and the satellites' default account.
  const appConfig = {
    getHomeAssistantConfig: vi.fn(async () => cfg),
    voiceAccounts: vi.fn(async () => ({ memoryUserId: 'body', defaultUserId: 'body', satellites: voice.satellites ?? {} })),
    presenceUsers: vi.fn(async () => voice.own ?? []),
  };
  const focus = { set: vi.fn(), setVoiceTurnListener: vi.fn() };
  const initiatives = { setPush: vi.fn(), setBusy: vi.fn(), roomPresence: vi.fn(async () => undefined) };
  const identity = { mode: vi.fn(async (u: string) => voice.modes?.[u] ?? 'personal') };
  const voiceDelivery = { setChannel: vi.fn() };
  const svc = new HomeAssistantService(appConfig as any, focus as any, initiatives as any, identity as any, voiceDelivery as any);
  svc.newSocket = () => ha.socket;
  return { svc, ha, focus, initiatives, voiceDelivery };
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
    expect(t.voiceDelivery.setChannel).toHaveBeenLastCalledWith(t.svc);
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

  it('a satellite turn is a presence in its room for the Home Assistant memory, whatever the account; only a known satellite', async () => {
    const t = setup();
    await t.svc.apply();
    expect(t.focus.setVoiceTurnListener).toHaveBeenLastCalledWith(expect.any(Function));
    await settle();
    t.initiatives.roomPresence.mockClear();
    // By its entity or by its device, any account's turn; an unknown satellite: nothing.
    t.svc.voiceTurn({ userId: 'body', satelliteId: 'assist_satellite.cucina', deviceId: null }, 0);
    t.svc.voiceTurn({ userId: 'body', satelliteId: null, deviceId: 'dv' }, 0);
    t.svc.voiceTurn({ userId: 'other', satelliteId: 'assist_satellite.cucina', deviceId: null }, 0);
    t.svc.voiceTurn({ userId: 'body', satelliteId: 'assist_satellite.altro', deviceId: null }, 0);
    await settle();
    expect(t.initiatives.roomPresence).toHaveBeenCalledTimes(3);
    // Chloé's tracker places her in the kitchen: she spoke, as sure as the room sensor.
    expect(t.initiatives.roomPresence).toHaveBeenLastCalledWith('body', expect.objectContaining({
      channel: 'voice', place: 'Cucina', people: [{ identity: { channel: 'homeassistant', externalId: 'person.chloe' }, confidence: 0.9 }],
    }), 'cucina');
    t.svc.onModuleDestroy();
    expect(t.focus.setVoiceTurnListener).toHaveBeenLastCalledWith(null);
  });

  it('a satellite turn whose voice was recognised: the presence carries who spoke, not who it was by elimination', async () => {
    const t = setup();
    await t.svc.apply();
    await settle();
    t.initiatives.roomPresence.mockClear();
    t.svc.voiceTurn({ userId: 'body', satelliteId: 'assist_satellite.cucina', deviceId: null, speaker: { identity: { channel: 'voice', externalId: 'v-sam' }, confidence: 0.65 } }, 0);
    await settle();
    expect(t.initiatives.roomPresence).toHaveBeenCalledWith('body', expect.objectContaining({
      channel: 'voice', place: 'Cucina', people: [{ identity: { channel: 'voice', externalId: 'v-sam' }, confidence: 0.65 }],
    }), 'cucina');
    t.svc.onModuleDestroy();
  });

  it('says a text on the satellite of the person\'s room (listening) and binds it to the chat', async () => {
    const t = setup();
    await t.svc.apply();
    expect(await t.svc.say('body', 'Chloé, alle 18 hai nuoto.', { person: 'person.chloe' }, 'chat-1')).toBe('assist_satellite.cucina');
    expect(t.focus.set).toHaveBeenCalledWith('body', 'assist_satellite.cucina', 'chat-1', expect.any(Number));
    expect(t.ha.calls.at(-1)).toEqual({ type: 'call_service', domain: 'assist_satellite', service: 'start_conversation',
      service_data: { start_message: 'Chloé, alle 18 hai nuoto.' }, target: { entity_id: 'assist_satellite.cucina' } });
    expect(await t.svc.say('body', 'x', { person: 'person.andrea' }, 'chat-1')).toBeNull(); // not in a room
    // Another user's memory: not on a satellite that is not theirs.
    expect(await t.svc.say('someone', 'x', { areaId: 'cucina' }, 'chat-2')).toBeNull();
    t.svc.onModuleDestroy();
  });

  it('a voice delivery is said only where presence is confirmed: the person\'s room, not busy; else an occupied room', async () => {
    const t = setup({ haBusyEnabled: true });
    await t.svc.apply();
    expect(t.voiceDelivery.setChannel).toHaveBeenLastCalledWith(t.svc);
    // A linked person: where they are, on a satellite of the account; not in a room → nothing.
    expect(await t.svc.sayWherePresent('body', 'Tra cinque minuti esci.', 'chat-1', { person: 'person.chloe' })).toBe('assist_satellite.cucina');
    expect(t.focus.set).toHaveBeenLastCalledWith('body', 'assist_satellite.cucina', 'chat-1', expect.any(Number));
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-1', { person: 'person.andrea' })).toBeNull();
    // No person (a household account): a room with someone in it; another account has no satellite there.
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-2', {})).toBe('assist_satellite.cucina');
    expect(await t.svc.sayWherePresent('someone', 'x', 'chat-3', {})).toBeNull();
    // Busy on the phone: not by voice, neither as the person nor as the one in the room.
    t.ha.handlers.get('state_changed')!({ data: { entity_id: 'binary_sensor.ph_focus', new_state: { entity_id: 'binary_sensor.ph_focus', state: 'on', attributes: {} } } });
    await settle(2_100);
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-1', { person: 'person.chloe' })).toBeNull();
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-2', {})).toBeNull();
    // A room asked for (the presence the caller answers): there.
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-4', { areaId: 'cucina' })).toBe('assist_satellite.cucina');
    // She leaves the kitchen: an empty room hears nothing.
    t.ha.handlers.get('state_changed')!({ data: { entity_id: 'binary_sensor.ph_focus', new_state: { entity_id: 'binary_sensor.ph_focus', state: 'off', attributes: {} } } });
    t.ha.handlers.get('state_changed')!({ data: { entity_id: 'sensor.chloe_area', new_state: { entity_id: 'sensor.chloe_area', state: 'unknown', attributes: {} } } });
    await settle(2_100);
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-2', {})).toBeNull();
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-1', { person: 'person.andrea' })).toBeNull();
    // Someone just spoke to the satellite: a presence there for a while — anyone's, or the person recognised by voice.
    t.svc.voiceTurn({ userId: 'body', satelliteId: 'assist_satellite.cucina', deviceId: null, speaker: { identity: { channel: 'homeassistant', externalId: 'person.andrea' }, confidence: 0.8 } }, 0);
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-2', {})).toBe('assist_satellite.cucina');
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-1', { person: 'person.andrea' })).toBe('assist_satellite.cucina');
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-1', { person: 'person.someone' })).toBeNull();
    // A reminder asked "in ten minutes" finds the one who asked; after 20 minutes the turn is no presence any more.
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-2', {}, Date.now() + 11 * 60_000)).toBe('assist_satellite.cucina');
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-2', {}, Date.now() + 21 * 60_000)).toBeNull();
    // The last turn counts, an unrecognised one too (a short "yes" after a recognised request).
    t.svc.voiceTurn({ userId: 'body', satelliteId: null, deviceId: 'dv' }, 0);
    expect(await t.svc.sayWherePresent('body', 'x', 'chat-2', {}, Date.now() + 19 * 60_000)).toBe('assist_satellite.cucina');
    t.svc.onModuleDestroy();
    expect(t.voiceDelivery.setChannel).toHaveBeenLastCalledWith(null);
  });

  it('a satellite assigned to a user: their memory speaks there, the default account no longer', async () => {
    const t = setup({}, { satellites: { 'assist_satellite.cucina': 'sam' } });
    await t.svc.apply();
    expect(await t.svc.say('body', 'x', { areaId: 'cucina' }, 'c')).toBeNull();
    expect(await t.svc.say('sam', 'Ciao Sam', { areaId: 'cucina' }, 'c-sam')).toBe('assist_satellite.cucina');
    expect(t.focus.set).toHaveBeenCalledWith('sam', 'assist_satellite.cucina', 'c-sam', expect.any(Number));
    expect(t.svc.satelliteEntity(null, 'dv')).toBe('assist_satellite.cucina');
    t.svc.onModuleDestroy();
  });

  it('a user who asked for it: their own presence to their own memory too, as the holder (no people named)', async () => {
    const t = setup({}, { own: [{ userId: 'chloe-user', person: 'person.chloe' }, { userId: 'nobody', person: 'person.absent' }] });
    await t.svc.apply();
    await settle();
    expect(t.initiatives.roomPresence).toHaveBeenCalledWith('chloe-user', { channel: 'home', ttlSeconds: 600 }, undefined);
    expect(t.initiatives.roomPresence).toHaveBeenCalledWith('chloe-user', { channel: 'voice', place: 'Cucina', ttlSeconds: 600 }, 'cucina');
    expect(t.initiatives.roomPresence.mock.calls.some((c: any[]) => c[0] === 'nobody')).toBe(false);
    t.svc.onModuleDestroy();
  });

  it('an entity memory gets no presence naming nobody, even if its user asked for it', async () => {
    const t = setup({}, { own: [{ userId: 'chloe-user', person: 'person.chloe' }], modes: { 'chloe-user': 'entity' } });
    await t.svc.apply();
    await settle();
    expect(t.initiatives.roomPresence.mock.calls.some((c: any[]) => c[0] === 'chloe-user')).toBe(false);
    expect(t.initiatives.roomPresence).toHaveBeenCalledWith('body', expect.objectContaining({ channel: 'home' }), undefined);
    t.svc.onModuleDestroy();
  });

  it('off: no connection; no URL: an error; voice off: nothing said; the tools only for the users allowed', async () => {
    const off = setup({ haPresenceEnabled: false, haVoiceEnabled: false, haToolsEnabled: false });
    expect((await off.svc.apply()).state).toBe('off');
    expect(off.ha.socket.connect).not.toHaveBeenCalled();
    expect((await setup({ haUrl: null }).svc.apply())).toMatchObject({ state: 'error', error: 'set the Home Assistant URL and token' });
    const quiet = setup({ haVoiceEnabled: false, haToolsUserIds: ['u-allowed'] });
    await quiet.svc.apply();
    expect(quiet.voiceDelivery.setChannel).not.toHaveBeenCalledWith(quiet.svc);
    expect(await quiet.svc.sayWherePresent('body', 'x', 'c', {})).toBeNull();
    expect(await quiet.svc.say('body', 'x', { areaId: 'cucina' }, 'c')).toBeNull();
    expect([quiet.svc.toolsFor('u-allowed'), quiet.svc.toolsFor('someone-else')]).toEqual([true, false]);
    quiet.svc.onModuleDestroy();
  });

  it('perceptions alone connect; their target is the Home Assistant memory, with the chosen entities, only while on', async () => {
    const t = setup({ haPresenceEnabled: false, haVoiceEnabled: false, haToolsEnabled: false, haPerceptionsEnabled: true, haPerceptionEntities: ['binary_sensor.*_door'] });
    expect((await t.svc.apply()).state).toBe('connected');
    expect(t.svc.perceptionTarget()).toEqual({ entities: ['binary_sensor.*_door'], userId: 'body' });
    t.svc.onModuleDestroy();
    const off = setup({ haPerceptionsEnabled: false, haPerceptionEntities: ['binary_sensor.*_door'] });
    await off.svc.apply();
    expect(off.svc.perceptionTarget()).toBeNull();
    const none = setup({ haPerceptionsEnabled: true, haPerceptionEntities: [] });
    await none.svc.apply();
    expect(none.svc.perceptionTarget()).toBeNull();
    off.svc.onModuleDestroy();
    none.svc.onModuleDestroy();
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

  it('busy (switch on): a Focus on the phone is said at once where the person is, then false when it ends', async () => {
    const t = setup({ haBusyEnabled: true });
    await t.svc.apply();
    expect(t.initiatives.setBusy).toHaveBeenLastCalledWith(t.svc);
    await settle();
    expect(t.initiatives.roomPresence.mock.calls.some(([, imp]: any) => 'busy' in imp)).toBe(false); // nobody busy: as before
    const focus = (state: string) => t.ha.handlers.get('state_changed')!({ data: { entity_id: 'binary_sensor.ph_focus', new_state: { entity_id: 'binary_sensor.ph_focus', state, attributes: {} } } });
    t.initiatives.roomPresence.mockClear();
    focus('on');
    await settle(2_100);
    expect(t.svc.busy('person.chloe')).toBe(true);
    expect(t.svc.getStatus().busy).toEqual(['person.chloe']);
    expect(t.initiatives.roomPresence).toHaveBeenCalledTimes(1);
    expect(t.initiatives.roomPresence).toHaveBeenLastCalledWith('body', {
      channel: 'voice', place: 'Cucina', people: [{ identity: { channel: 'homeassistant', externalId: 'person.chloe' }, confidence: 0.9 }],
      ttlSeconds: 600, busy: true,
    }, 'cucina');
    focus('off');
    await settle(2_100);
    expect(t.initiatives.roomPresence).toHaveBeenLastCalledWith('body', expect.objectContaining({ channel: 'voice', place: 'Cucina', busy: false }), 'cucina');
    t.svc.onModuleDestroy();
    expect(t.initiatives.setBusy).toHaveBeenLastCalledWith(null);
  });

  it('busy switch off (or the presence off): a Focus on changes nothing, no impulse says busy', async () => {
    for (const over of [{ haBusyEnabled: false }, { haBusyEnabled: true, haPresenceEnabled: false }]) {
      const t = setup(over);
      await t.svc.apply();
      expect(t.initiatives.setBusy).not.toHaveBeenCalledWith(t.svc);
      t.ha.handlers.get('state_changed')!({ data: { entity_id: 'binary_sensor.ph_focus', new_state: { entity_id: 'binary_sensor.ph_focus', state: 'on', attributes: {} } } });
      await settle(2_100);
      expect(t.svc.busy('person.chloe')).toBe(false);
      expect(t.initiatives.roomPresence.mock.calls.some(([, imp]: any) => 'busy' in imp)).toBe(false);
      t.svc.onModuleDestroy();
    }
  });

  it('a change is told within the gathering time even while other entities change several times a second', async () => {
    const t = setup();
    await t.svc.apply();
    await settle();
    t.initiatives.roomPresence.mockClear();
    const noise = setInterval(() => t.ha.handlers.get('state_changed')!({ data: { entity_id: 'sensor.power', new_state: { entity_id: 'sensor.power', state: String(Math.random()), attributes: {} } } }), 100);
    t.ha.handlers.get('state_changed')!({ data: { entity_id: 'sensor.chloe_area', new_state: { entity_id: 'sensor.chloe_area', state: 'unknown', attributes: {} } } });
    await settle(2_300);
    clearInterval(noise);
    expect(t.initiatives.roomPresence).toHaveBeenCalledWith('body', expect.objectContaining({ channel: 'voice', place: 'Cucina', left: true }), 'cucina');
    t.svc.onModuleDestroy();
  });
});

