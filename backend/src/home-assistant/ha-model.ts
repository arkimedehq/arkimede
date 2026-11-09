// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ha-model.ts
 *
 * What Arkimede reads from Home Assistant, as plain data (no I/O): its registries (areas, devices, entities) and the
 * entities' states, turned into the two registries of the memory's presence standard (Recordare D55 §5c) — nothing an
 * admin keeps by hand:
 *   - voice points: every `assist_satellite` entity with its area — the entity's own, else its device's; a MOBILE one
 *     (a robot) takes its area from a sensor on the same device whose state names an area (quacksat:
 *     `sensor.quacksat_where`);
 *   - presence sources: `person.*` at home (the "at home" level); a person IN A ROOM when a sensor on the device of one
 *     of their `device_trackers` names an area (per-room Bluetooth such as Bermuda: `sensor.<phone>_area`); occupancy
 *     without identity (`binary_sensor` occupancy / presence / motion, on) is "someone" in its area;
 *   - busy (opt-in, `useBusy`): a person is busy when a sensor of the companion app on one of their phones says so — a
 *     call (Android `phone_state`: ringing / off-hook), do-not-disturb (Android `dnd_sensor`), a Focus (iOS `focus`).
 *     The sensors are known by the entity registry (platform `mobile_app`, the sensor's key at the end of the
 *     unique_id), not by their entity id, which can be renamed. A person with none of them has no busy signal.
 * A snapshot is who is home, who is busy and, for the rooms that have a voice point, who is there; `impulses(prev,
 * next)` is what changed, as presence impulses (an arrival, a person who left, someone in an empty room, a person busy
 * or no longer busy).
 */

export interface HaState {
  entity_id: string;
  state: string;
  attributes: Record<string, any>;
}

export interface HaRegistries {
  areas: Array<{ area_id: string; name: string; aliases?: string[] }>;
  devices: Array<{ id: string; area_id: string | null; name?: string | null; name_by_user?: string | null }>;
  entities: Array<{ entity_id: string; device_id: string | null; area_id: string | null; platform?: string | null; unique_id?: string | null }>;
}

export interface VoicePoint {
  entityId: string;
  areaId: string;
  /** Home Assistant's AssistSatelliteEntityFeature bits: 1 announce, 2 start a conversation. */
  features: number;
}

export interface Snapshot {
  /** `person.*` entities at home. */
  home: Set<string>;
  /** Rooms with a voice point and someone in them: the people recognised there, and how many it cannot name. */
  rooms: Map<string, { people: Set<string>; someone: number }>;
  /** `person.*` entities busy now and present (at home or in a room): only with the busy signals on. */
  busy?: Set<string>;
}

export interface Impulse {
  channel: 'home' | 'voice';
  /** The area's id (voice only). */
  areaId?: string;
  /** `person.*` entities. */
  people: string[];
  someone?: number;
  left?: boolean;
  /** One person busy (true) or no longer busy (false, only after a true); absent = nothing said about it. */
  busy?: boolean;
}

const OCCUPANCY = new Set(['occupancy', 'presence', 'motion']);
/** The companion app's sensors that say a person is busy (the key their unique_id ends with): the busy states. */
const BUSY_SENSORS: Array<{ domain: string; key: string; busy: (state: string) => boolean }> = [
  { domain: 'sensor', key: 'phone_state', busy: (v) => v === 'ringing' || v === 'offhook' },
  { domain: 'sensor', key: 'dnd_sensor', busy: (v) => v === 'priority_only' || v === 'total_silence' || v === 'alarms_only' },
  { domain: 'binary_sensor', key: 'focus', busy: (v) => v === 'on' },
];
const fold = (s: string) => s.trim().toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[\s_-]+/g, ' ');

export class HaModel {
  private areas = new Map<string, string>();
  private areaByWord = new Map<string, string>();
  private entityArea = new Map<string, string>();
  private entityDevice = new Map<string, string>();
  private deviceEntities = new Map<string, string[]>();
  private deviceNames = new Map<string, string>();
  private states = new Map<string, HaState>();
  /** The busy sensors (entity id → which), by device. */
  private busySensors = new Map<string, Array<{ entityId: string; busy: (state: string) => boolean }>>();
  private busyOn = false;

  /** Whether the snapshot reads who is busy (the admin's switch). */
  useBusy(on: boolean): void {
    this.busyOn = on;
  }

  setRegistries(r: HaRegistries): void {
    this.areas = new Map(r.areas.map((a) => [a.area_id, a.name]));
    this.areaByWord = new Map();
    for (const a of r.areas) for (const w of [a.area_id, a.name, ...(a.aliases ?? [])]) if (w) this.areaByWord.set(fold(w), a.area_id);
    const deviceArea = new Map(r.devices.map((d) => [d.id, d.area_id]));
    this.deviceNames = new Map(r.devices.flatMap((d) => (d.name_by_user || d.name ? [[d.id, String(d.name_by_user || d.name)] as [string, string]] : [])));
    this.entityArea = new Map();
    this.entityDevice = new Map();
    this.deviceEntities = new Map();
    this.busySensors = new Map();
    for (const e of r.entities) {
      const sensor = e.platform === 'mobile_app' && e.device_id && e.unique_id
        ? BUSY_SENSORS.find((b) => e.entity_id.startsWith(`${b.domain}.`) && String(e.unique_id).endsWith(`_${b.key}`)) : undefined;
      if (sensor) this.busySensors.set(e.device_id!, [...(this.busySensors.get(e.device_id!) ?? []), { entityId: e.entity_id, busy: sensor.busy }]);
      const area = e.area_id ?? (e.device_id ? deviceArea.get(e.device_id) : null);
      if (area) this.entityArea.set(e.entity_id, area);
      if (e.device_id) {
        this.entityDevice.set(e.entity_id, e.device_id);
        this.deviceEntities.set(e.device_id, [...(this.deviceEntities.get(e.device_id) ?? []), e.entity_id]);
      }
    }
  }

  setStates(states: HaState[]): void {
    this.states = new Map(states.map((s) => [s.entity_id, s]));
  }

  /** A state change (null: the entity was removed). */
  update(entityId: string, state: HaState | null): void {
    if (state) this.states.set(entityId, state);
    else this.states.delete(entityId);
  }

  /**
   * The names a person's phones have in Home Assistant (the devices of their `device_trackers`): the companion app's
   * notify service is `notify.mobile_app_<the device name, slugified>`.
   */
  personDevices(person: string): string[] {
    const trackers = this.states.get(person)?.attributes?.device_trackers;
    return (Array.isArray(trackers) ? trackers : [])
      .map((t) => this.entityDevice.get(String(t)))
      .flatMap((d) => (d && this.deviceNames.get(d) ? [this.deviceNames.get(d)!] : []));
  }

  /** The area of an entity: its own, else its device's; null when none. */
  areaIdOf(entityId: string): string | null {
    return this.entityArea.get(entityId) ?? null;
  }

  areaName(areaId: string): string {
    return this.areas.get(areaId) ?? areaId;
  }

  /** The area a value names (an area id, name or alias; case, accents and separators ignored), or null. */
  areaFromValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? this.areaByWord.get(fold(value)) ?? null : null;
  }

  /** The area named by a sensor on the same device as `entityId` (a mobile point, a phone's room), or null. */
  private areaOnDevice(entityId: string): string | null {
    const device = this.entityDevice.get(entityId);
    for (const other of device ? this.deviceEntities.get(device) ?? [] : []) {
      if (!other.startsWith('sensor.')) continue;
      const area = this.areaFromValue(this.states.get(other)?.state);
      if (area) return area;
    }
    return null;
  }

  voicePoints(): VoicePoint[] {
    const points: VoicePoint[] = [];
    for (const s of this.states.values()) {
      if (!s.entity_id.startsWith('assist_satellite.') || s.state === 'unavailable') continue;
      const areaId = this.areaOnDevice(s.entity_id) ?? this.entityArea.get(s.entity_id);
      if (areaId) points.push({ entityId: s.entity_id, areaId, features: Number(s.attributes?.supported_features) || 0 });
    }
    return points;
  }

  /** The voice point a satellite turn came from: by its entity, or by its device (the hub may report either). */
  voicePointOf(satelliteId: string | null, deviceId: string | null): VoicePoint | null {
    const ids = [satelliteId, deviceId].filter((x): x is string => !!x);
    if (!ids.length) return null;
    return this.voicePoints().find((p) => ids.includes(p.entityId) || ids.includes(this.entityDevice.get(p.entityId) ?? '')) ?? null;
  }

  /** The room a person is in (from their trackers' devices), or null. */
  personRoom(person: string): string | null {
    const trackers = this.states.get(person)?.attributes?.device_trackers;
    for (const tracker of Array.isArray(trackers) ? trackers : []) {
      const area = this.areaOnDevice(String(tracker));
      if (area) return area;
    }
    return null;
  }

  /** Whether a sensor of the companion app on one of the person's phones says they are busy now. */
  personBusy(person: string): boolean {
    const trackers = this.states.get(person)?.attributes?.device_trackers;
    for (const tracker of Array.isArray(trackers) ? trackers : []) {
      const device = this.entityDevice.get(String(tracker));
      for (const s of device ? this.busySensors.get(device) ?? [] : []) {
        const state = this.states.get(s.entityId)?.state;
        if (state && s.busy(state)) return true;
      }
    }
    return false;
  }

  snapshot(): Snapshot {
    const voiceAreas = new Set(this.voicePoints().map((p) => p.areaId));
    const home = new Set<string>();
    const rooms = new Map<string, { people: Set<string>; someone: number }>();
    const room = (a: string) => rooms.get(a) ?? rooms.set(a, { people: new Set(), someone: 0 }).get(a)!;
    for (const s of this.states.values()) {
      if (s.entity_id.startsWith('person.')) {
        if (s.state === 'home') home.add(s.entity_id);
        const area = this.personRoom(s.entity_id);
        if (area && voiceAreas.has(area)) room(area).people.add(s.entity_id);
      } else if (s.entity_id.startsWith('binary_sensor.') && s.state === 'on' && OCCUPANCY.has(s.attributes?.device_class)) {
        const area = this.entityArea.get(s.entity_id);
        if (area && voiceAreas.has(area)) room(area).someone = 1;
      }
    }
    // Occupancy says someone is there: nobody more when the people there are already known.
    for (const r of rooms.values()) if (r.people.size) r.someone = 0;
    if (!this.busyOn) return { home, rooms };
    const placed = new Set([...home, ...[...rooms.values()].flatMap((r) => [...r.people])]);
    return { home, rooms, busy: new Set([...placed].filter((p) => this.personBusy(p))) };
  }
}

/** Where a person is in a snapshot, as an impulse's place: their room with a voice point, else home; null when away. */
function placeOf(s: Snapshot, person: string): Pick<Impulse, 'channel' | 'areaId'> | null {
  for (const [areaId, r] of s.rooms) if (r.people.has(person)) return { channel: 'voice', areaId };
  return s.home.has(person) ? { channel: 'home' } : null;
}

/**
 * What changed between two snapshots, as presence impulses. A person who became busy is said first, on their own (busy
 * is theirs, not the others' in the room), where they are; no longer busy (false) once, only after a true and while
 * still present — a person who left ends their presence, and the busy with it.
 */
export function impulses(prev: Snapshot, next: Snapshot): Impulse[] {
  const out: Impulse[] = [];
  for (const p of next.busy ?? []) {
    const place = placeOf(next, p);
    if (place && !prev.busy?.has(p)) out.push({ ...place, people: [p], busy: true });
  }
  for (const p of prev.busy ?? []) {
    const place = placeOf(next, p);
    if (place && !next.busy?.has(p)) out.push({ ...place, people: [p], busy: false });
  }
  for (const p of next.home) if (!prev.home.has(p)) out.push({ channel: 'home', people: [p] });
  for (const p of prev.home) if (!next.home.has(p)) out.push({ channel: 'home', people: [p], left: true });
  for (const [areaId, r] of next.rooms) {
    const before = prev.rooms.get(areaId);
    const same = before && before.someone === r.someone && before.people.size === r.people.size && [...r.people].every((p) => before.people.has(p));
    if (!same && (r.people.size || r.someone)) out.push({ channel: 'voice', areaId, people: [...r.people], someone: r.someone });
  }
  for (const [areaId, r] of prev.rooms) {
    const gone = [...r.people].filter((p) => !next.rooms.get(areaId)?.people.has(p));
    if (gone.length) out.push({ channel: 'voice', areaId, people: gone, left: true });
  }
  return out;
}

/**
 * Who spoke to the satellite in `areaId` (a voice turn: someone is surely there). Without a voiceprint the speaker is
 * known only by elimination: the one person the room's sensors place there (as sure as those sensors), else the one
 * person at home (medium: they may have a guest), else "someone".
 */
export function turnSpeaker(s: Snapshot, areaId: string, roomConfidence: number, aloneConfidence: number):
  { people: Array<{ person: string; confidence: number }>; someone: number } {
  const inRoom = [...(s.rooms.get(areaId)?.people ?? [])];
  if (inRoom.length === 1) return { people: [{ person: inRoom[0], confidence: roomConfidence }], someone: 0 };
  if (inRoom.length > 1) return { people: inRoom.map((person) => ({ person, confidence: roomConfidence })), someone: 0 };
  if (s.home.size === 1) return { people: [{ person: [...s.home][0], confidence: aloneConfidence }], someone: 0 };
  return { people: [], someone: 1 };
}

/** Everything present now, as impulses (the periodic refresh that keeps the presences live). */
export function current(s: Snapshot): Impulse[] {
  return impulses({ home: new Set(), rooms: new Map() }, s);
}

/** Home Assistant's slugify (util/__init__.py): accents dropped, anything not a letter or digit → "_", trimmed. */
export function slugify(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
