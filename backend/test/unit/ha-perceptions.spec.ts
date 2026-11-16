// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * What the house noticed, as the memory's perceptions (ha-perceptions.ts, ha-perceptions.service.ts): only events of the
 * entities the admin chose — a sensor on, a new event, a cover opened, a lock unlocked or jammed, an alarm — never a
 * change from an unknown state (a restart); a fixed sentence in the memory's language with the entity's name and no
 * person; the camera's sensors as `camera`; serious events kept a year; one per entity every ten minutes; nothing when
 * the switch is off or the memory is off.
 */
import { describe, it, expect, vi } from 'vitest';
import { PERCEPTION_COOLDOWN_MS, PerceptionGate, SERIOUS_KEEP_DAYS, entityChosen, perceptionOf } from '../../src/home-assistant/ha-perceptions';
import { HaPerceptionsService } from '../../src/home-assistant/ha-perceptions.service';

const st = (state: string, attributes: Record<string, unknown> = {}, last_changed = '2026-11-09T10:20:00+00:00') => ({ state, attributes, last_changed });
const ctx = (over: Partial<Parameters<typeof perceptionOf>[3]> = {}) => ({ name: 'Front door', area: 'Entrance', camera: false, language: 'en', ...over });

describe('perceptionOf', () => {
  it('a sensor going on is a perception, with its name, room, time and sensor kind', () => {
    expect(perceptionOf('binary_sensor.front_door', st('off'), st('on', { device_class: 'door' }), ctx())).toEqual({
      text: 'Front door opened', sensor: 'sensor', place: 'Entrance', at: '2026-11-09T10:20:00.000Z',
    });
    expect(perceptionOf('binary_sensor.porch_person', st('off'), st('on', { device_class: 'occupancy' }), ctx({ name: 'Porch camera', camera: true })))
      .toMatchObject({ text: 'Porch camera saw someone', sensor: 'camera' });
  });

  it('writes in the memory\'s language, never with a person\'s name', () => {
    expect(perceptionOf('binary_sensor.kitchen_smoke', st('off'), st('on', { device_class: 'smoke' }), ctx({ name: 'Sensore fumo', area: 'Cucina', language: 'it-IT' })))
      .toMatchObject({ text: 'Sensore fumo ha rilevato fumo', place: 'Cucina' });
    expect(perceptionOf('event.doorbell', st('2026-11-09T09:00:00Z'), st('2026-11-09T10:20:00Z', { device_class: 'doorbell', event_type: 'ring' }), ctx({ name: 'campanello', language: 'it' })))
      .toMatchObject({ text: 'Qualcuno ha suonato: campanello' });
  });

  it('serious events are kept a year; the others take the memory\'s default', () => {
    expect(perceptionOf('binary_sensor.smoke', st('off'), st('on', { device_class: 'smoke' }), ctx())!.keepDays).toBe(SERIOUS_KEEP_DAYS);
    expect(perceptionOf('alarm_control_panel.home', st('armed_away'), st('triggered'), ctx({ name: 'Home' }))).toMatchObject({ text: 'The alarm Home went off', keepDays: SERIOUS_KEEP_DAYS });
    expect(perceptionOf('lock.front', st('locked'), st('jammed'), ctx({ name: 'Front lock' }))).toMatchObject({ text: 'Front lock is jammed', keepDays: SERIOUS_KEEP_DAYS });
    expect(perceptionOf('binary_sensor.front_door', st('off'), st('on', { device_class: 'door' }), ctx())!.keepDays).toBeUndefined();
  });

  it('only events: covers that open, locks unlocked, new events; not the way back nor other domains', () => {
    expect(perceptionOf('cover.garage', st('closed'), st('opening', { device_class: 'garage' }), ctx({ name: 'Garage' }))!.text).toBe('Garage opened');
    expect(perceptionOf('cover.garage', st('open'), st('closing'), ctx())).toBeNull();
    expect(perceptionOf('lock.front', st('locked'), st('unlocked'), ctx({ name: 'Front lock' }))!.text).toBe('Front lock was unlocked');
    expect(perceptionOf('lock.front', st('unlocked'), st('locked'), ctx())).toBeNull();
    expect(perceptionOf('binary_sensor.front_door', st('on'), st('off', { device_class: 'door' }), ctx())).toBeNull();
    expect(perceptionOf('sensor.temperature', st('20'), st('21'), ctx())).toBeNull();
    expect(perceptionOf('light.kitchen', st('off'), st('on'), ctx())).toBeNull();
  });

  it('a change from an unknown state is a restart, not an event — except an event entity\'s first event', () => {
    expect(perceptionOf('binary_sensor.front_door', st('unavailable'), st('on', { device_class: 'door' }), ctx())).toBeNull();
    expect(perceptionOf('binary_sensor.front_door', null, st('on', { device_class: 'door' }), ctx())).toBeNull();
    expect(perceptionOf('binary_sensor.front_door', st('off'), st('unavailable'), ctx())).toBeNull();
    expect(perceptionOf('event.doorbell', st('unavailable'), st('2026-11-09T10:20:00Z', { device_class: 'doorbell' }), ctx())).toBeNull();
    expect(perceptionOf('event.doorbell', st('unknown'), st('2026-11-09T10:20:00Z', { device_class: 'doorbell' }), ctx({ name: 'the doorbell' }))!.text).toBe('Someone rang the doorbell');
  });

  it('the admin\'s patterns choose the entities', () => {
    expect(entityChosen(['binary_sensor.*_door', 'event.doorbell'], 'binary_sensor.front_door')).toBe(true);
    expect(entityChosen(['binary_sensor.*_door'], 'binary_sensor.front_window')).toBe(false);
    expect(entityChosen(['', '  '], 'binary_sensor.front_door')).toBe(false);
  });

  it('one perception per entity every ten minutes', () => {
    const gate = new PerceptionGate();
    expect(gate.pass('a', 0)).toBe(true);
    expect(gate.pass('a', PERCEPTION_COOLDOWN_MS - 1)).toBe(false);
    expect(gate.pass('b', 1)).toBe(true);
    expect(gate.pass('a', PERCEPTION_COOLDOWN_MS)).toBe(true);
  });
});

describe('HaPerceptionsService', () => {
  function setup(target: { entities: string[]; userId: string } | null = { entities: ['binary_sensor.*'], userId: 'u1' }) {
    const ha = {
      onStateChanged: vi.fn(() => () => {}),
      perceptionTarget: vi.fn(() => target),
      areaOf: vi.fn(() => 'Entrance'),
      onCameraDevice: vi.fn(() => false),
    };
    const initiatives = { perceive: vi.fn(async () => ({ episodeId: 'e1', duplicate: false, people: [], expiresAt: null })) };
    const users = { findOne: vi.fn(async () => ({ id: 'u1', language: 'en' })) };
    return { svc: new HaPerceptionsService(ha as any, initiatives as any, users as any), initiatives };
  }
  const door = st('on', { device_class: 'door', friendly_name: 'Front door' });

  it('sends a chosen entity\'s event to the memory the presence goes to', async () => {
    const { svc, initiatives } = setup();
    expect(await svc.onChange('binary_sensor.front_door', st('off'), door, 0)).toBe(true);
    expect(initiatives.perceive).toHaveBeenCalledWith('u1', expect.objectContaining({ text: 'Front door opened', sensor: 'sensor', place: 'Entrance' }));
    expect((initiatives.perceive.mock.calls[0] as any[])[1].people).toBeUndefined();
  });

  it('nothing when off, for an entity not chosen, for a non-event, or again within ten minutes', async () => {
    expect(await setup(null).svc.onChange('binary_sensor.front_door', st('off'), door, 0)).toBe(false);
    const { svc, initiatives } = setup({ entities: ['event.*'], userId: 'u1' });
    expect(await svc.onChange('binary_sensor.front_door', st('off'), door, 0)).toBe(false);
    const t = setup();
    expect(await t.svc.onChange('binary_sensor.front_door', st('on'), st('off', { device_class: 'door' }), 0)).toBe(false);
    expect(await t.svc.onChange('binary_sensor.front_door', st('off'), door, 0)).toBe(true);
    expect(await t.svc.onChange('binary_sensor.front_door', st('off'), door, 60_000)).toBe(false);
    expect(initiatives.perceive).not.toHaveBeenCalled();
    expect(t.initiatives.perceive).toHaveBeenCalledTimes(1);
  });
});
