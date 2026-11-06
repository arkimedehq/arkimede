// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Home Assistant as the memory's presence registries (ha-model.ts): voice points with their area (fixed, or a mobile one
 * from a sensor on its device), people at home, a person in a room from a sensor on their tracker's device, occupancy as
 * "someone"; what changed between two snapshots as presence impulses.
 */
import { describe, it, expect } from 'vitest';
import { HaModel, impulses, current, turnSpeaker, type HaState } from '../../src/home-assistant/ha-model';

const st = (entity_id: string, state: string, attributes: Record<string, unknown> = {}): HaState => ({ entity_id, state, attributes });

function house() {
  const m = new HaModel();
  m.setRegistries({
    areas: [{ area_id: 'cucina', name: 'Cucina' }, { area_id: 'salotto', name: 'Salotto', aliases: ['soggiorno'] }, { area_id: 'camera_chloe', name: 'Camera di Chloé' }],
    devices: [{ id: 'dev-voice', area_id: 'cucina' }, { id: 'dev-duck', area_id: null }, { id: 'dev-phone-chloe', area_id: null }, { id: 'dev-phone-andrea', area_id: null }, { id: 'dev-pir', area_id: 'salotto' }],
    entities: [
      { entity_id: 'assist_satellite.cucina', device_id: 'dev-voice', area_id: null },
      { entity_id: 'assist_satellite.quacksat', device_id: 'dev-duck', area_id: null },
      { entity_id: 'sensor.quacksat_where', device_id: 'dev-duck', area_id: null },
      { entity_id: 'device_tracker.chloe_phone', device_id: 'dev-phone-chloe', area_id: null },
      { entity_id: 'sensor.chloe_phone_area', device_id: 'dev-phone-chloe', area_id: null },
      { entity_id: 'device_tracker.andrea_phone', device_id: 'dev-phone-andrea', area_id: null },
      { entity_id: 'sensor.andrea_phone_area', device_id: 'dev-phone-andrea', area_id: null },
      { entity_id: 'binary_sensor.salotto_pir', device_id: 'dev-pir', area_id: null },
    ],
  });
  m.setStates([
    st('assist_satellite.cucina', 'idle', { supported_features: 3 }),
    st('assist_satellite.quacksat', 'idle', { supported_features: 1 }),
    st('sensor.quacksat_where', 'Soggiorno'),
    st('person.chloe', 'home', { device_trackers: ['device_tracker.chloe_phone'] }),
    st('sensor.chloe_phone_area', 'cucina'),
    st('person.andrea', 'not_home', { device_trackers: ['device_tracker.andrea_phone'] }),
    st('sensor.andrea_phone_area', 'unknown'),
    st('binary_sensor.salotto_pir', 'off', { device_class: 'motion' }),
  ]);
  return m;
}

describe('HaModel', () => {
  it('voice points: a fixed satellite by its device\'s area, a mobile one by the sensor on its device (an alias too)', () => {
    expect(house().voicePoints()).toEqual([
      { entityId: 'assist_satellite.cucina', areaId: 'cucina', features: 3 },
      { entityId: 'assist_satellite.quacksat', areaId: 'salotto', features: 1 },
    ]);
  });

  it('a snapshot: who is home, who is in a room with a voice point, someone where only occupancy says so', () => {
    const m = house();
    let s = m.snapshot();
    expect([...s.home]).toEqual(['person.chloe']);
    expect([...s.rooms]).toEqual([['cucina', { people: new Set(['person.chloe']), someone: 0 }]]);
    m.update('binary_sensor.salotto_pir', st('binary_sensor.salotto_pir', 'on', { device_class: 'motion' }));
    s = m.snapshot();
    expect(s.rooms.get('salotto')).toEqual({ people: new Set(), someone: 1 });
    // A room with no voice point is not a room the agent can speak in.
    m.update('sensor.chloe_phone_area', st('sensor.chloe_phone_area', 'Camera di Chloé'));
    expect(m.snapshot().rooms.has('camera_chloe')).toBe(false);
  });

  it('impulses: arrivals and departures at home and in rooms; nothing when nothing changed', () => {
    const m = house();
    const a = m.snapshot();
    expect(current(a)).toEqual([
      { channel: 'home', people: ['person.chloe'] },
      { channel: 'voice', areaId: 'cucina', people: ['person.chloe'], someone: 0 },
    ]);
    expect(impulses(a, m.snapshot())).toEqual([]);
    // Chloé goes to the living room (the duck is there), Andrea comes home.
    m.update('sensor.chloe_phone_area', st('sensor.chloe_phone_area', 'salotto'));
    m.update('person.andrea', st('person.andrea', 'home', { device_trackers: ['device_tracker.andrea_phone'] }));
    expect(impulses(a, m.snapshot())).toEqual([
      { channel: 'home', people: ['person.andrea'] },
      { channel: 'voice', areaId: 'salotto', people: ['person.chloe'], someone: 0 },
      { channel: 'voice', areaId: 'cucina', people: ['person.chloe'], left: true },
    ]);
  });

  it('voicePointOf: a satellite turn\'s point by its entity or its device', () => {
    const m = house();
    expect(m.voicePointOf('assist_satellite.cucina', null)?.areaId).toBe('cucina');
    expect(m.voicePointOf(null, 'dev-duck')?.areaId).toBe('salotto');
    expect(m.voicePointOf('assist_satellite.altro', null)).toBeNull();
    expect(m.voicePointOf(null, null)).toBeNull();
  });

  it('turnSpeaker: the one person the room places there; else the one person at home (medium); else someone', () => {
    const snap = (home: string[], room: string[] = []) => ({ home: new Set(home), rooms: new Map(room.length ? [['salotto', { people: new Set(room), someone: 0 }]] : []) });
    expect(turnSpeaker(snap(['person.andrea', 'person.chloe'], ['person.chloe']), 'salotto', 0.9, 0.6))
      .toEqual({ people: [{ person: 'person.chloe', confidence: 0.9 }], someone: 0 });
    expect(turnSpeaker(snap(['person.andrea']), 'salotto', 0.9, 0.6)).toEqual({ people: [{ person: 'person.andrea', confidence: 0.6 }], someone: 0 });
    expect(turnSpeaker(snap(['person.andrea', 'person.eriona']), 'salotto', 0.9, 0.6)).toEqual({ people: [], someone: 1 });
    expect(turnSpeaker(snap([]), 'salotto', 0.9, 0.6)).toEqual({ people: [], someone: 1 });
  });
});
