// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugin-runtime.service.ts
 *
 * What an active plugin does while it runs (specs/PLUGINS.md §6, §8, §9):
 *   - events: the plugin emits them (validated against its manifest, deduplicated, rate-limited, logged); the core
 *     never interprets them — it starts the flows whose trigger is that event (owners who see the plugin) and hands
 *     them to the plugins that subscribed (their `handlers.events` script);
 *   - services: notify, storage, agent.ask, services — each one only when approved; the reserved ones answer
 *     `unavailable` until the core has a generic service for them;
 *   - routes: a user's request to `/api/plugins/<name>/routes/<path>` runs the route's script, as that user, in the
 *     executor; its output is the answer.
 * Everything that comes from a plugin is data, never instructions.
 */
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { Plugin, PluginEvent, PluginEventOutcome, PluginKv } from './plugin.entity';
import { RESERVED_SERVICES, validateEventData } from './plugin-manifest';
import { matchRoute, routeAnswer } from './plugin-routes';
import { PluginsService } from './plugins.service';
import { FlowsService } from '../flows/flows.service';
import { Flow } from '../flows/flow.entity';
import { SkillsService } from '../skills/skills.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { GuestMessagesService } from '../guests/guest-messages.service';
import { RecordareInitiativesService } from '../recordare/recordare-initiatives.service';
import { Agent } from '../agents/agent.entity';
import { User } from '../users/users.entity';

const MAX_EVENTS_PER_CALL = 100;
/** Events a plugin may emit per minute (beyond: rate_limited). */
const EVENTS_PER_MINUTE = 600;
/** Route requests per user and plugin per minute. */
const ROUTES_PER_MINUTE = 120;
/** Service calls per plugin per minute. */
const SERVICES_PER_MINUTE = 600;
const ROUTE_TIMEOUT_MS = 30_000;
const MAX_ROUTE_BODY_BYTES = 1024 * 1024;
const HANDLER_TIMEOUT_MS = 30_000;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_KEY = 256;
const TEXT_MAX = 8_000;
const SAY_MAX = 300;
/** `say` at most once a minute per place (or person). */
const SAY_EVERY_MS = 60_000;
const PERCEPTION_MAX = 2_000;
const SENSORS = ['camera', 'microphone', 'sensor', 'photo'] as const;
const MAX_PEOPLE = 20;

/** A service answer that is not a result: denied, unavailable, invalid… with its HTTP status. */
export class PluginServiceError extends HttpException {
  constructor(status: number, error: string, message: string) {
    super({ error, message }, status);
  }
}

export interface IncomingEvent {
  id?: unknown;
  type?: unknown;
  at?: unknown;
  data?: unknown;
  subject?: unknown;
}

/** A sliding one-minute counter per key. */
class MinuteLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number) {}
  take(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

/** Whether the event's data has the values the trigger's `match` asks for (top-level fields, equality). */
export function eventMatches(match: Record<string, unknown> | undefined, data: Record<string, unknown>): boolean {
  return !match || Object.entries(match).every(([k, v]) => data?.[k] === v);
}

@Injectable()
export class PluginRuntimeService {
  private readonly logger = new Logger(PluginRuntimeService.name);
  private readonly eventLimiter = new MinuteLimiter(EVENTS_PER_MINUTE);
  private readonly routeLimiter = new MinuteLimiter(ROUTES_PER_MINUTE);
  private readonly serviceLimiter = new MinuteLimiter(SERVICES_PER_MINUTE);
  /** When each flow last started from a plugin event (cooldown). */
  private readonly flowLastRun = new Map<string, number>();
  /** When a plugin last spoke at a place (say). */
  private readonly lastSaid = new Map<string, number>();

  constructor(
    @InjectRepository(PluginEvent) private readonly eventRepo: Repository<PluginEvent>,
    @InjectRepository(PluginKv) private readonly kvRepo: Repository<PluginKv>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly plugins: PluginsService,
    private readonly flows: FlowsService,
    private readonly skills: SkillsService,
    private readonly notifications: NotificationsService,
    private readonly gateway: NotificationsGateway,
    private readonly guests: GuestMessagesService,
    private readonly memory: RecordareInitiativesService,
  ) {}

  // ── Events ───────────────────────────────────────────────────────────────

  /** Takes a batch of events from a plugin: an outcome for each, the accepted ones delivered in the background. */
  async emit(plugin: Plugin, events: IncomingEvent[]): Promise<Array<{ id: string | null; outcome: PluginEventOutcome; error?: string }>> {
    if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_CALL) {
      throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', `events: an array of at most ${MAX_EVENTS_PER_CALL}`);
    }
    const out: Array<{ id: string | null; outcome: PluginEventOutcome; error?: string }> = [];
    for (const e of events) {
      const id = typeof e?.id === 'string' && e.id.trim() && e.id.length <= 128 ? e.id.trim() : null;
      const type = typeof e?.type === 'string' ? e.type : '';
      const at = typeof e?.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at) : new Date();
      const error = !id ? 'id: a string of at most 128 characters' : validateEventData(plugin.manifest!, type, e.data);
      if (error) {
        await this.log(plugin, null, type, at, 'invalid', `${id ?? '(no id)'}: ${error}`);
        out.push({ id, outcome: 'invalid', error });
        continue;
      }
      if (!this.eventLimiter.take(plugin.id)) {
        await this.log(plugin, null, type, at, 'rate_limited', id);
        out.push({ id, outcome: 'rate_limited' });
        continue;
      }
      const saved = await this.log(plugin, id!, type, at, 'accepted', null);
      if (!saved) {
        out.push({ id, outcome: 'duplicate' });
        continue;
      }
      out.push({ id, outcome: 'accepted' });
      const event = {
        plugin: plugin.name, type: `${plugin.name}/${type}`, id: id!, at: at.toISOString(),
        subject: e.subject && typeof e.subject === 'object' ? e.subject : null, data: (e.data ?? {}) as Record<string, unknown>,
      };
      void this.deliver(plugin, saved, event).catch((err) => this.logger.warn(`plugin ${plugin.name}: event ${event.type} not delivered: ${(err as Error).message}`));
    }
    return out;
  }

  /** Records an event; for an accepted one, null when the plugin already sent that id (duplicate). */
  private async log(plugin: Plugin, eventId: string | null, type: string, at: Date, outcome: PluginEventOutcome, detail: string | null): Promise<PluginEvent | null> {
    const row = this.eventRepo.create({
      pluginId: plugin.id, eventId: eventId ?? `${outcome}:${randomUUID()}`, type: type.slice(0, 64) || '(none)', at, outcome, detail,
    });
    if (outcome !== 'accepted') return this.eventRepo.save(row);
    const res = await this.eventRepo.createQueryBuilder().insert().into(PluginEvent).values(row)
      .orIgnore().returning(['id']).execute();
    const id = res.identifiers?.[0]?.id ?? res.raw?.[0]?.id;
    return id ? { ...row, id } as PluginEvent : null;
  }

  /** Starts the flows waiting for the event and hands it to the plugins subscribed to it. */
  async deliver(source: Plugin, row: PluginEvent, event: { plugin: string; type: string; id: string; at: string; subject: unknown; data: Record<string, unknown> }, now = Date.now()): Promise<{ flows: number; plugins: number }> {
    let flows = 0;
    for (const flow of await this.flows.pluginEventFlows(event.type)) {
      if (!(await this.flowMayStart(source, flow, event.data, now))) continue;
      flows++;
      void this.flows.runByPluginEvent(flow, event)
        .catch((err) => this.logger.warn(`flow "${flow.name}" (plugin event ${event.type}) failed: ${(err as Error).message}`));
    }
    let plugins = 0;
    for (const sub of await this.plugins.subscribers(event.type)) {
      if (sub.id === source.id || !(await this.plugins.visibleTo(source, sub.ownerId))) continue;
      const handler = sub.manifest!.handlers.events!;
      const skillId = await this.plugins.skillId(sub, handler.skill);
      if (!skillId) continue;
      plugins++;
      void this.skills.invoke(skillId, handler.script, { event }, HANDLER_TIMEOUT_MS, sub.ownerId)
        .then((r) => { if (!r.success) this.logger.warn(`plugin ${sub.name}: handler failed on ${event.type} (exit ${r.exit_code})`); })
        .catch((err) => this.logger.warn(`plugin ${sub.name}: handler not run on ${event.type}: ${(err as Error).message}`));
    }
    await this.eventRepo.update(row.id, { detail: `flows: ${flows}, plugins: ${plugins}` });
    return { flows, plugins };
  }

  private async flowMayStart(source: Plugin, flow: Flow, data: Record<string, unknown>, now: number): Promise<boolean> {
    const t = flow.trigger?.plugin;
    if (!t || !eventMatches(t.match, data)) return false;
    if (!(await this.plugins.visibleTo(source, flow.userId))) return false;
    const cooldownMs = Math.max(0, t.cooldownSeconds ?? 0) * 1000;
    if (cooldownMs && now - (this.flowLastRun.get(flow.id) ?? 0) < cooldownMs) return false;
    this.flowLastRun.set(flow.id, now);
    return true;
  }

  // ── Services ─────────────────────────────────────────────────────────────

  /** Runs a core service for a plugin (`storage.get`, `notify`…), if approved. */
  async call(plugin: Plugin, service: string, body: any): Promise<unknown> {
    const base = service.startsWith('storage.') ? 'storage' : service;
    if (service === 'services') return this.services(plugin);
    const known = ['notify', 'agent.ask', 'say', 'perceive', 'presence.report', 'storage.get', 'storage.set', 'storage.delete', 'storage.list', ...RESERVED_SERVICES];
    if (!known.includes(service)) throw new PluginServiceError(HttpStatus.NOT_FOUND, 'unknown', `No service "${service}"`);
    if (!plugin.grants?.services.includes(base)) throw new PluginServiceError(HttpStatus.FORBIDDEN, 'denied', `Service "${base}" not approved for this plugin`);
    if (RESERVED_SERVICES.has(base)) throw new PluginServiceError(HttpStatus.SERVICE_UNAVAILABLE, 'unavailable', `This Arkimede has no "${base}" service yet`);
    if (!this.serviceLimiter.take(plugin.id)) throw new PluginServiceError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', 'Too many service calls');
    const b = body && typeof body === 'object' ? body : {};
    switch (service) {
      case 'notify': return this.notify(plugin, b);
      case 'agent.ask': return this.ask(plugin, b);
      case 'say': return this.say(plugin, b);
      case 'perceive': return this.perceive(plugin, b);
      case 'presence.report': return this.presence(plugin, b);
      case 'storage.get': return this.storageGet(plugin, b);
      case 'storage.set': return this.storageSet(plugin, b);
      case 'storage.delete': return this.storageDelete(plugin, b);
      default: return this.storageList(plugin, b);
    }
  }

  /** The services approved and whether the core has them now. */
  services(plugin: Plugin): { services: Array<{ name: string; available: boolean }> } {
    const can = this.memory.capabilities();
    const available = (name: string) => !RESERVED_SERVICES.has(name)
      && (name === 'say' ? can.voice : name === 'perceive' || name === 'presence.report' ? can.memory : true);
    return { services: (plugin.grants?.services ?? []).map((name) => ({ name, available: available(name) })) };
  }

  // ── Memory and voice ─────────────────────────────────────────────────────

  /**
   * Whose memory a plugin's presences and perceptions go to: its owner's — and only a personal plugin writes to a
   * memory (specs/EXTENSION_AUDIENCE.md: a memory is one person's).
   */
  private memoryUser(plugin: Plugin): string {
    if (plugin.audience !== 'personal' || plugin.scope !== 'personal') {
      throw new PluginServiceError(HttpStatus.FORBIDDEN, 'denied', 'Only a personal plugin writes to a memory (its owner\'s)');
    }
    return plugin.ownerId;
  }

  /**
   * One of the plugin's people as the memory knows them: a Home Assistant person — the linked user's, else the one
   * linked to the id (the same contact as Home Assistant's presence) — else the plugin's own identity (bound to a person
   * in Recordare's console).
   */
  private async identityOf(plugin: Plugin, externalId: string): Promise<{ channel: string; externalId: string }> {
    const haPerson = await this.plugins.haPersonOf(plugin, externalId);
    return haPerson ? { channel: 'homeassistant', externalId: haPerson } : { channel: plugin.name, externalId };
  }

  private async people(plugin: Plugin, raw: unknown): Promise<Array<{ identity: { channel: string; externalId: string }; confidence?: number }>> {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.length > MAX_PEOPLE) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', `people: an array of at most ${MAX_PEOPLE}`);
    const out: Array<{ identity: { channel: string; externalId: string }; confidence?: number }> = [];
    for (const p of raw) {
      const id = typeof p?.id === 'string' ? p.id.trim() : '';
      if (!id || id.length > 256) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'people[].id: a string of at most 256 characters');
      const confidence = p?.confidence === undefined ? undefined : Number(p.confidence);
      if (confidence !== undefined && !(confidence >= 0 && confidence <= 1)) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'people[].confidence: between 0 and 1');
      out.push({ identity: await this.identityOf(plugin, id), ...(confidence !== undefined ? { confidence } : {}) });
    }
    return out;
  }

  private placeOf(b: any): string | undefined {
    if (b.place === undefined || b.place === null) return undefined;
    if (typeof b.place !== 'string' || !b.place.trim() || b.place.length > 100) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'place: a name of at most 100 characters');
    return b.place.trim();
  }

  /** What the plugin's senses noticed, remembered as seen (Recordare perceive). */
  private async perceive(plugin: Plugin, b: any): Promise<{ ok: true; duplicate: boolean; expiresAt: string | null }> {
    if (!this.memory.capabilities().memory) throw new PluginServiceError(HttpStatus.SERVICE_UNAVAILABLE, 'unavailable', 'This Arkimede has no memory service');
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > PERCEPTION_MAX) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', `text required (at most ${PERCEPTION_MAX} characters)`);
    if (!SENSORS.includes(b.sensor)) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', `sensor: one of ${SENSORS.join(', ')}`);
    const at = b.at === undefined ? undefined : typeof b.at === 'string' && !Number.isNaN(Date.parse(b.at)) ? b.at : null;
    if (at === null) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'at: an ISO 8601 date');
    const keepDays = b.keepDays === undefined ? undefined : Number(b.keepDays);
    if (keepDays !== undefined && !(Number.isInteger(keepDays) && keepDays >= 1 && keepDays <= 3650)) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'keepDays: 1-3650');
    const place = this.placeOf(b);
    const people = await this.people(plugin, b.people);
    const res = await this.memory.perceive(this.memoryUser(plugin), {
      text, sensor: b.sensor, ...(place ? { place } : {}), ...(at ? { at } : {}), ...(people.length ? { people } : {}),
      ...(keepDays !== undefined ? { keepDays } : {}), ...(b.private === true ? { private: true } : {}),
    });
    if (!res) throw new PluginServiceError(HttpStatus.SERVICE_UNAVAILABLE, 'unavailable', 'The memory did not take it (off, or not reachable)');
    // Only whether it was taken: who the memory recognised stays in the memory.
    return { ok: true, duplicate: res.duplicate, expiresAt: res.expiresAt };
  }

  /** Who is at a place, as the plugin recognised them (a presence impulse, Recordare presence). */
  private async presence(plugin: Plugin, b: any): Promise<{ ok: true }> {
    if (!this.memory.capabilities().memory) throw new PluginServiceError(HttpStatus.SERVICE_UNAVAILABLE, 'unavailable', 'This Arkimede has no memory service');
    const place = this.placeOf(b);
    const people = await this.people(plugin, b.people);
    const someone = b.someone === undefined ? 0 : Number(b.someone);
    if (!(Number.isInteger(someone) && someone >= 0 && someone <= 50)) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'someone: 0-50');
    if (!people.length && !someone) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'people or someone required');
    const ttl = b.ttlSeconds === undefined ? 600 : Number(b.ttlSeconds);
    if (!(Number.isInteger(ttl) && ttl >= 30 && ttl <= 3600)) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'ttlSeconds: 30-3600');
    await this.memory.placePresence(this.memoryUser(plugin), {
      channel: place ? 'camera' : 'home', ...(place ? { place } : {}), people, ...(someone ? { someone } : {}), ttlSeconds: ttl,
      ...(b.left === true ? { left: true } : {}), ...(typeof b.busy === 'boolean' ? { busy: b.busy } : {}),
    });
    return { ok: true };
  }

  /** A sentence said on the voice point of a place, or of the room a linked person is in. */
  private async say(plugin: Plugin, b: any, now = Date.now()): Promise<{ ok: true; point: string }> {
    if (!this.memory.capabilities().voice) throw new PluginServiceError(HttpStatus.SERVICE_UNAVAILABLE, 'unavailable', 'This Arkimede has no voice channel');
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!text || text.length > SAY_MAX) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', `text required (at most ${SAY_MAX} characters)`);
    const place = this.placeOf(b);
    let person: string | undefined;
    if (!place) {
      const ext = typeof b.to?.id === 'string' ? b.to.id : null;
      person = (ext ? await this.plugins.haPersonOf(plugin, ext) : null) ?? undefined;
      if (!person) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'place, or to: a person linked to a Home Assistant person (directly or through a user)');
    }
    const key = `${plugin.id}:${place ?? person}`;
    if (now - (this.lastSaid.get(key) ?? 0) < SAY_EVERY_MS) throw new PluginServiceError(HttpStatus.TOO_MANY_REQUESTS, 'rate_limited', 'At most one sentence a minute per place');
    const point = await this.memory.announce(plugin.ownerId, text, place ? { place } : { person });
    if (!point) throw new PluginServiceError(HttpStatus.SERVICE_UNAVAILABLE, 'unavailable', 'No voice point reaches that place now');
    this.lastSaid.set(key, now);
    return { ok: true, point };
  }

  private async notify(plugin: Plugin, b: any): Promise<{ ok: true }> {
    const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
    const message = typeof b.body === 'string' ? b.body.trim().slice(0, 2000) : '';
    if (!title && !message) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'title or body required');
    let userId = plugin.ownerId;
    if (b.to && b.to !== 'owner') {
      const ext = typeof b.to === 'object' && typeof b.to.id === 'string' ? b.to.id : null;
      const linked = ext ? await this.plugins.linkedUser(plugin, ext) : null;
      if (!linked?.userId) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'unknown_recipient', 'The recipient is not linked to a user who sees this plugin');
      userId = linked.userId;
    }
    const payload = { title: title || (plugin.manifest?.label ?? plugin.name), message, plugin: plugin.name };
    const saved = await this.notifications.create({ userId, source: 'plugin', sourceId: plugin.id, eventType: 'plugin_notify', payload });
    this.gateway.emitToUser(userId, 'skill_event', {
      id: saved.id, daemon_id: null, skill_id: null, event_type: 'plugin_notify', payload, timestamp: new Date().toISOString(),
    });
    return { ok: true };
  }

  private async ask(plugin: Plugin, b: any): Promise<{ reply: string; chatId: string }> {
    const fromId = typeof b.from?.id === 'string' ? b.from.id.trim() : '';
    const conversation = typeof b.conversation === 'string' ? b.conversation.trim() : '';
    const text = typeof b.text === 'string' ? b.text.trim() : '';
    if (!fromId || fromId.length > 256) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'from.id required (at most 256 characters)');
    if (!conversation || conversation.length > 256) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'conversation required (at most 256 characters)');
    if (!text || text.length > TEXT_MAX) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', `text required (at most ${TEXT_MAX} characters)`);
    const linked = await this.plugins.linkedUser(plugin, fromId);
    const name = typeof b.from?.name === 'string' && b.from.name.trim() ? b.from.name.trim().slice(0, 100) : linked.displayName ?? undefined;
    const agent = plugin.agentId ? await this.agentRepo.findOne({ where: { id: plugin.agentId } }) : null;
    const msg = { channel: plugin.manifest?.label ?? plugin.name, externalId: fromId, displayName: name, text, conversation, authorized: linked.authorized };
    const opts = { source: `plugin:${plugin.name}`, agent };
    const r = linked.userId
      ? await this.guests.ask(linked.userId, msg, { ...opts, asUser: true })
      : await this.guests.ask(plugin.ownerId, msg, { ...opts, asUser: false });
    return { reply: r.answer, chatId: r.chatId };
  }

  private key(b: any): string {
    const key = typeof b.key === 'string' ? b.key : '';
    if (!key || key.length > MAX_KEY) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', `key: a string of 1-${MAX_KEY} characters`);
    return key;
  }

  private async storageGet(plugin: Plugin, b: any): Promise<{ value: unknown }> {
    const row = await this.kvRepo.findOne({ where: { pluginId: plugin.id, key: this.key(b) } });
    return { value: row ? row.value : null };
  }

  private async storageSet(plugin: Plugin, b: any): Promise<{ ok: true; used: number; quota: number }> {
    const key = this.key(b);
    if (b.value === undefined) throw new PluginServiceError(HttpStatus.BAD_REQUEST, 'invalid', 'value required (any JSON)');
    const bytes = Buffer.byteLength(JSON.stringify(b.value), 'utf8') + Buffer.byteLength(key, 'utf8');
    if (bytes > MAX_VALUE_BYTES) throw new PluginServiceError(HttpStatus.PAYLOAD_TOO_LARGE, 'too_large', 'A value is at most 1 MB');
    const quota = (plugin.grants?.storageKb ?? 0) * 1024;
    const old = await this.kvRepo.findOne({ where: { pluginId: plugin.id, key }, select: { id: true, bytes: true } });
    const used = (await this.plugins.storageUsed(plugin.id)) - (old?.bytes ?? 0) + bytes;
    if (used > quota) throw new PluginServiceError(507, 'quota', `Storage quota exceeded (${Math.ceil(quota / 1024)} KB)`);
    if (old) await this.kvRepo.update(old.id, { value: b.value as any, bytes });
    else await this.kvRepo.save(this.kvRepo.create({ pluginId: plugin.id, key, value: b.value, bytes }));
    return { ok: true, used, quota };
  }

  private async storageDelete(plugin: Plugin, b: any): Promise<{ ok: true }> {
    await this.kvRepo.delete({ pluginId: plugin.id, key: this.key(b) });
    return { ok: true };
  }

  private async storageList(plugin: Plugin, b: any): Promise<{ keys: string[] }> {
    const prefix = typeof b.prefix === 'string' ? b.prefix.slice(0, MAX_KEY) : '';
    const limit = Math.min(Math.max(Number(b.limit) || 100, 1), 1000);
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = await this.kvRepo.find({
      where: { pluginId: plugin.id, ...(prefix ? { key: Like(`${escaped}%`) } : {}) },
      select: { key: true }, order: { key: 'ASC' }, take: limit,
    });
    return { keys: rows.map((r) => r.key) };
  }

  // ── Routes ───────────────────────────────────────────────────────────────

  /** A user's request to a plugin route: the route's script runs as the user and its output is the answer. */
  async route(name: string, method: string, subpath: string, query: Record<string, unknown>, body: unknown, user: { id: string; role?: string }): Promise<{ status: number; body: unknown }> {
    const plugin = await this.plugins.activeFor(name, user.id);
    const match = matchRoute(plugin.manifest!.contributes.routes, method, subpath);
    if (!match) return { status: 404, body: { error: 'No such route' } };
    if (!this.routeLimiter.take(`${plugin.id}:${user.id}`)) return { status: 429, body: { error: 'Too many requests' } };
    if (body !== undefined && body !== null && Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_ROUTE_BODY_BYTES) {
      return { status: 413, body: { error: 'Request body too large' } };
    }
    const skillId = await this.plugins.skillId(plugin, match.route.skill);
    if (!skillId) return { status: 503, body: { error: 'The plugin is not ready' } };
    const who = await this.userRepo.findOne({ where: { id: user.id }, select: { id: true, name: true, role: true } });
    const input = {
      route: { method: method.toUpperCase(), path: subpath, params: match.params, query: query ?? {}, body: body ?? null },
      user: { id: user.id, name: who?.name ?? null, isAdmin: (who?.role ?? user.role) === 'admin' },
    };
    try {
      return routeAnswer(await this.skills.invoke(skillId, match.route.script, input, ROUTE_TIMEOUT_MS, user.id));
    } catch (err) {
      this.logger.warn(`plugin ${plugin.name}: route ${method} ${subpath} failed: ${(err as Error).message}`);
      return { status: 502, body: { error: 'The plugin could not answer this request.' } };
    }
  }
}
