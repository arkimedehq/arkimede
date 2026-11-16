// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ha-perceptions.ts
 *
 * What the house noticed, as the memory's perceptions (Recordare `perceive`, API.md §4c) — plain data, no I/O. A state
 * change of an entity the admin chose becomes a perception only when it is an event worth remembering: a sensor that
 * goes on (smoke, a door, movement, someone seen), a new `event.*` (the doorbell), a cover that opens, a lock unlocked
 * or jammed, an alarm or a siren that goes off. Never a stream: a change from an unknown state (a restart, an entity
 * coming back) is not an event, and each entity is told at most once every few minutes (PerceptionGate).
 *
 * The text is a fixed sentence in the memory's language, with the entity's name — no model, and never a person's
 * name: Home Assistant recognises nobody here, so `people` stays empty ("someone"). Serious events (smoke, gas, water,
 * an alarm, a jammed lock…) are kept a year; the others fade with the memory's default.
 */
import { entityMatches } from './ha-triggers.service';

export type PerceptionSensor = 'camera' | 'sensor';

export interface HaPerception {
  text: string;
  sensor: PerceptionSensor;
  place?: string;
  at?: string;
  keepDays?: number;
}

export interface PerceptionContext {
  /** The entity's friendly name. */
  name: string;
  /** Its area's name, when it has one. */
  area: string | null;
  /** Its device also has a camera (a camera's own sensors: someone seen, movement). */
  camera: boolean;
  /** The memory's language (`it…` → Italian, else English). */
  language: string | null;
}

/** How long a serious event is kept (days); the others take the memory's default. */
export const SERIOUS_KEEP_DAYS = 365;
/** Each entity is told at most once in this long (Recordare's own duplicate window is the same). */
export const PERCEPTION_COOLDOWN_MS = 10 * 60_000;

const UNKNOWN = new Set(['unknown', 'unavailable', '', 'none']);
const SERIOUS_CLASSES = new Set(['smoke', 'gas', 'carbon_monoxide', 'moisture', 'safety', 'tamper']);

type Lang = 'it' | 'en';
type Phrase = Record<Lang, (name: string) => string>;

const BINARY: Record<string, Phrase> = {
  smoke: { en: (n) => `${n} detected smoke`, it: (n) => `${n} ha rilevato fumo` },
  gas: { en: (n) => `${n} detected gas`, it: (n) => `${n} ha rilevato gas` },
  carbon_monoxide: { en: (n) => `${n} detected carbon monoxide`, it: (n) => `${n} ha rilevato monossido di carbonio` },
  moisture: { en: (n) => `${n} detected water`, it: (n) => `${n} ha rilevato acqua` },
  safety: { en: (n) => `${n} reported a safety problem`, it: (n) => `${n} ha segnalato un problema di sicurezza` },
  tamper: { en: (n) => `${n} was tampered with`, it: (n) => `Manomissione rilevata: ${n}` },
  door: { en: (n) => `${n} opened`, it: (n) => `Apertura: ${n}` },
  garage_door: { en: (n) => `${n} opened`, it: (n) => `Apertura: ${n}` },
  window: { en: (n) => `${n} opened`, it: (n) => `Apertura: ${n}` },
  opening: { en: (n) => `${n} opened`, it: (n) => `Apertura: ${n}` },
  motion: { en: (n) => `${n} detected movement`, it: (n) => `${n} ha rilevato un movimento` },
  occupancy: { en: (n) => `${n} saw someone`, it: (n) => `${n} ha visto qualcuno` },
  presence: { en: (n) => `${n} saw someone`, it: (n) => `${n} ha visto qualcuno` },
  sound: { en: (n) => `${n} heard a sound`, it: (n) => `${n} ha sentito un rumore` },
  vibration: { en: (n) => `${n} detected a vibration`, it: (n) => `${n} ha rilevato una vibrazione` },
};
const BINARY_OTHER: Phrase = { en: (n) => `${n} went on`, it: (n) => `Attivazione: ${n}` };

const PHRASES = {
  doorbell: { en: (n: string) => `Someone rang ${n}`, it: (n: string) => `Qualcuno ha suonato: ${n}` },
  eventMotion: BINARY.motion,
  event: { en: (n: string, t: string) => `${n}: ${t}`, it: (n: string, t: string) => `${n}: ${t}` },
  coverOpened: BINARY.opening,
  unlocked: { en: (n: string) => `${n} was unlocked`, it: (n: string) => `Sblocco: ${n}` },
  jammed: { en: (n: string) => `${n} is jammed`, it: (n: string) => `Serratura bloccata: ${n}` },
  alarm: { en: (n: string) => `The alarm ${n} went off`, it: (n: string) => `È scattato l'allarme: ${n}` },
  siren: { en: (n: string) => `The siren ${n} went off`, it: (n: string) => `È suonata la sirena: ${n}` },
};

const lang = (language: string | null): Lang => (language?.toLowerCase().startsWith('it') ? 'it' : 'en');
const known = (s: any): boolean => !!s && typeof s.state === 'string' && !UNKNOWN.has(s.state);

/** Whether an entity id matches one of the admin's patterns (`*` = any characters). */
export function entityChosen(patterns: string[], entityId: string): boolean {
  return patterns.some((p) => !!p.trim() && entityMatches(p, entityId));
}

/**
 * The perception a state change is, or null when it is not an event worth remembering. `from` and `to` are Home
 * Assistant states (`{state, attributes, last_changed}`).
 */
export function perceptionOf(entityId: string, from: any | null, to: any | null, ctx: PerceptionContext): HaPerception | null {
  const domain = entityId.split('.')[0];
  // An event entity's first event ever comes from `unknown`; anything else from an unknown state is a restart.
  const fromKnown = known(from) || (domain === 'event' && from?.state === 'unknown');
  if (!fromKnown || !known(to) || from.state === to.state) return null;
  const deviceClass: string = to.attributes?.device_class ?? '';
  const l = lang(ctx.language);
  const name = ctx.name.trim() || entityId;
  let text: string | null = null;
  let serious = false;

  switch (domain) {
    case 'binary_sensor':
      if (from.state !== 'off' || to.state !== 'on') return null;
      text = (BINARY[deviceClass] ?? BINARY_OTHER)[l](name);
      serious = SERIOUS_CLASSES.has(deviceClass);
      break;
    case 'event': {
      // The state is the time of the last event: every new one is a change.
      const type = String(to.attributes?.event_type ?? '').trim();
      text = deviceClass === 'doorbell' ? PHRASES.doorbell[l](name)
        : deviceClass === 'motion' ? PHRASES.eventMotion[l](name)
        : type ? PHRASES.event[l](name, type) : null;
      break;
    }
    case 'cover':
      if (from.state !== 'closed' || (to.state !== 'open' && to.state !== 'opening')) return null;
      text = PHRASES.coverOpened[l](name);
      break;
    case 'lock':
      if (to.state === 'jammed') {
        text = PHRASES.jammed[l](name);
        serious = true;
      } else if (from.state === 'locked' && (to.state === 'unlocked' || to.state === 'open')) {
        text = PHRASES.unlocked[l](name);
      }
      break;
    case 'alarm_control_panel':
      if (to.state !== 'triggered') return null;
      text = PHRASES.alarm[l](name);
      serious = true;
      break;
    case 'siren':
      if (from.state !== 'off' || to.state !== 'on') return null;
      text = PHRASES.siren[l](name);
      serious = true;
      break;
    default:
      return null;
  }
  if (!text) return null;
  const at = typeof to.last_changed === 'string' && !Number.isNaN(Date.parse(to.last_changed)) ? new Date(to.last_changed).toISOString() : undefined;
  return {
    text: text.slice(0, 2000),
    sensor: ctx.camera ? 'camera' : 'sensor',
    ...(ctx.area ? { place: ctx.area } : {}),
    ...(at ? { at } : {}),
    ...(serious ? { keepDays: SERIOUS_KEEP_DAYS } : {}),
  };
}

/** At most one perception per entity every PERCEPTION_COOLDOWN_MS. */
export class PerceptionGate {
  private readonly last = new Map<string, number>();
  pass(entityId: string, now = Date.now()): boolean {
    if (now - (this.last.get(entityId) ?? -Infinity) < PERCEPTION_COOLDOWN_MS) return false;
    this.last.set(entityId, now);
    return true;
  }
}
