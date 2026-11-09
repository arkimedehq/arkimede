// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file home-assistant.service.ts
 *
 * Home Assistant as a native integration: one connection to its WebSocket API (the admin's URL and long-lived token),
 * kept open and shared by
 *   - the agent's `ha_*` tools (ha-tools.service.ts) — over the entities Home Assistant exposes to Assist, kept here;
 *   - the memory's eyes and voice at home (Recordare D55 §5c), for the Wyoming user — the account voice runs as, the
 *     body of the agent's memory. Each part is switched on from the admin's settings.
 *   - Presence: the registries and states (ha-model.ts) give who is home and who is in which room with a voice point;
 *     every change is told to the memory as presence impulses (an arrival, a departure, someone in an empty room —
 *     people by their `homeassistant` identity, `person.x`, the address bound on their card in Recordare), and what
 *     is present is told again every few minutes so it stays live. What the memory answers is said in that room.
 *     With the busy switch on, a person busy on their phone (a call, do-not-disturb, a Focus) is told as busy, and the
 *     chat presence of their user says it too (RecordareInitiativesService.setBusy).
 *   - Voice: the voice channel of the initiatives (RecordareInitiativesService.setVoice): a text is said on the voice
 *     point of a room — `assist_satellite.start_conversation` (it listens for the answer) when the satellite can, else
 *     `announce` — and the satellite is bound to the chat for the reply (ConversationFocusService: the Wyoming turn of
 *     that satellite goes into it).
 * The connection is kept: lost, it is opened again with a growing pause.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../app-config/app-config.service';
import { ConversationFocusService, FOCUS_DEFAULT_TTL_MS, type VoiceTurn } from '../chats/conversation-focus.service';
import { RecordareInitiativesService, type BusySignal, type PushChannel, type VoiceChannel } from '../recordare/recordare-initiatives.service';
import { HaModel, current, impulses, slugify, turnSpeaker, type Impulse, type Snapshot, type VoicePoint } from './ha-model';
import { HaSocket } from './ha-socket';

/** What is present is told again this often (presences live 2× as long). */
const REFRESH_MS = 5 * 60_000;
/**
 * State changes are gathered this long, from the first one, before the impulses are worked out: later changes do not
 * push it back (a busy Home Assistant sends several a second, and a wait for quiet would never end).
 */
const SETTLE_MS = 2_000;
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
/** How sure a room presence is (a per-room tracker); at home is an account's certainty. */
const ROOM_CONFIDENCE = 0.9;
/** The one person at home spoke to a satellite: medium (they may have a guest) — Recordare's medium threshold. */
const ALONE_CONFIDENCE = 0.6;
/** A satellite turn is told once its answer has been spoken (what the memory then says follows it, never over it). */
const TURN_DELAY_MS = 10_000;
/** AssistSatelliteEntityFeature.START_CONVERSATION. */
const START_CONVERSATION = 2;

export interface HomeAssistantStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  error: string | null;
  version: string | null;
  url: string | null;
  /** The Wyoming user: whose memory hears the presences. */
  memoryUserId: string | null;
  voicePoints: Array<{ entityId: string; area: string; listens: boolean }>;
  home: string[];
  rooms: Array<{ area: string; people: string[]; someone: number }>;
  /** The people present and busy on their phone (the busy switch on). */
  busy: string[];
  /** Every `person.*` (to link Arkimede users to them). */
  persons: Array<{ entityId: string; name: string }>;
  /** How many entities are exposed to Assist (what the tools see). */
  exposed: number;
}

/** The token of an `Authorization: Bearer …` header, or null. */
export function bearerToken(headers: Record<string, string>): string | null {
  const value = headers.Authorization ?? headers.authorization ?? '';
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() || null : null;
}

@Injectable()
export class HomeAssistantService implements OnModuleInit, OnModuleDestroy, VoiceChannel, PushChannel, BusySignal {
  private readonly logger = new Logger(HomeAssistantService.name);
  private socket: HaSocket | null = null;
  private model = new HaModel();
  private last: Snapshot = { home: new Set(), rooms: new Map() };
  private settings = { presence: false, busy: false, voice: false, tools: false, toolsUserIds: null as string[] | null };
  private status: Omit<HomeAssistantStatus, 'voicePoints' | 'home' | 'rooms' | 'busy' | 'persons' | 'exposed'> = { state: 'off', error: null, version: null, url: null, memoryUserId: null };
  /** The entities exposed to Assist: all the tools may see or touch. */
  private exposedSet = new Set<string>();
  /** Every entity's current state (the tools read it). */
  private statesById = new Map<string, { entity_id: string; state: string; attributes: Record<string, any>; last_changed?: string }>();
  private settle: NodeJS.Timeout | null = null;
  private refresh: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private retryMs = RETRY_MIN_MS;
  /** Bumped on every (re)configuration: a stale connection attempt drops itself. */
  private generation = 0;
  /** The socket factory (tests give a fake Home Assistant). */
  newSocket: () => HaSocket = () => new HaSocket();
  /** The REST API (camera images): base URL and token of the current connection. */
  private rest: { url: string; token: string } | null = null;
  /** The notify services (`get_services`), cached a few minutes. */
  private notifyServices: { at: number; names: Set<string> } | null = null;
  /** Who listens to state changes (ha-triggers.service.ts). */
  private readonly stateListeners = new Set<(entityId: string, from: any | null, to: any | null) => void>();
  /** The REST fetch (tests give a fake). */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly focus: ConversationFocusService,
    private readonly initiatives: RecordareInitiativesService,
  ) {}

  onModuleInit(): void {
    void this.apply().catch((err) => this.logger.warn(`Home Assistant not started: ${(err as Error).message}`));
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Reads the settings and (re)connects — at start-up and after the admin changes them. */
  async apply(): Promise<HomeAssistantStatus> {
    this.stop();
    const cfg = await this.appConfig.getHomeAssistantConfig(true);
    this.settings = { presence: cfg.haPresenceEnabled, busy: cfg.haPresenceEnabled && cfg.haBusyEnabled, voice: cfg.haVoiceEnabled, tools: cfg.haToolsEnabled, toolsUserIds: cfg.haToolsUserIds };
    this.status = { ...this.status, state: 'off', error: null, version: null, url: cfg.haUrl };
    if ((this.settings.presence || this.settings.voice || this.settings.tools) && cfg.haUrl && cfg.haToken) {
      await this.connect(this.generation, cfg.haUrl, cfg.haToken);
    } else if (this.settings.presence || this.settings.voice || this.settings.tools) {
      this.status = { ...this.status, state: 'error', error: 'set the Home Assistant URL and token' };
    }
    return this.getStatus();
  }

  getStatus(): HomeAssistantStatus {
    const snap = this.socket ? this.model.snapshot() : { home: new Set<string>(), rooms: new Map<string, { people: Set<string>; someone: number }>() };
    return {
      ...this.status,
      voicePoints: this.socket ? this.model.voicePoints().map((p) => ({ entityId: p.entityId, area: this.model.areaName(p.areaId), listens: (p.features & START_CONVERSATION) !== 0 })) : [],
      home: [...snap.home],
      rooms: [...snap.rooms].map(([a, r]) => ({ area: this.model.areaName(a), people: [...r.people], someone: r.someone })),
      busy: [...(snap.busy ?? [])],
      persons: [...this.statesById.values()].filter((s) => s.entity_id.startsWith('person.'))
        .map((s) => ({ entityId: s.entity_id, name: String(s.attributes?.friendly_name ?? s.entity_id) })),
      exposed: this.exposedSet.size,
    };
  }

  // ── For the tools (ha-tools.service.ts) ─────────────────────────────────────

  /** Whether the agent's tools are on for this user and Home Assistant is connected. */
  toolsFor(userId: string): boolean {
    return !!this.socket && this.settings.tools && (!this.settings.toolsUserIds || this.settings.toolsUserIds.includes(userId));
  }

  /** The exposed entities' current states (what the tools may see). */
  exposedStates(): Array<{ entity_id: string; state: string; attributes: Record<string, any>; last_changed?: string }> {
    return [...this.exposedSet].map((id) => this.statesById.get(id)).filter((s): s is NonNullable<typeof s> => !!s);
  }

  isExposed(entityId: string): boolean {
    return this.exposedSet.has(entityId);
  }

  /** The area name of an entity (its own or its device's), or null. */
  areaOf(entityId: string): string | null {
    const id = this.model.areaIdOf(entityId);
    return id ? this.model.areaName(id) : null;
  }

  /** A service call that answers (`return_response`: calendar.get_events, todo.get_items…): its response. */
  async callWithResponse<T = any>(domain: string, service: string, entityId: string, data: Record<string, unknown> = {}): Promise<T> {
    const res = await this.command<{ response?: Record<string, T> }>({
      type: 'call_service', domain, service, service_data: data, target: { entity_id: entityId }, return_response: true,
    }, 30_000);
    return (res?.response?.[entityId] ?? res?.response) as T;
  }

  /** A camera's current image (REST `camera_proxy`), or null. */
  async cameraImage(entityId: string): Promise<{ mimeType: string; data: Buffer } | null> {
    if (!this.rest || !this.socket) return null;
    const res = await this.fetchImpl(`${this.rest.url}/api/camera_proxy/${encodeURIComponent(entityId)}`, {
      headers: { Authorization: `Bearer ${this.rest.token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`camera image: HTTP ${res.status}`);
    return { mimeType: res.headers.get('content-type')?.split(';')[0] || 'image/jpeg', data: Buffer.from(await res.arrayBuffer()) };
  }

  /** The companion app's notify service of a person (`mobile_app_<phone>`), or null when they have none. */
  async notifyServiceFor(person: string): Promise<string | null> {
    if (!this.notifyServices || Date.now() - this.notifyServices.at > 5 * 60_000) {
      const all = await this.command<Record<string, Record<string, unknown>>>({ type: 'get_services' });
      this.notifyServices = { at: Date.now(), names: new Set(Object.keys(all?.notify ?? {})) };
    }
    return this.model.personDevices(person).map((d) => `mobile_app_${slugify(d)}`).find((s) => this.notifyServices!.names.has(s)) ?? null;
  }

  /** PushChannel: a push notification on the person's phone (the companion app). True when sent. */
  async push(person: string, message: string, title?: string): Promise<boolean> {
    if (!this.socket) return false;
    const service = await this.notifyServiceFor(person);
    if (!service) return false;
    await this.command({ type: 'call_service', domain: 'notify', service, service_data: { message, ...(title ? { title } : {}) } }, 30_000);
    return true;
  }

  /** Listens to every state change (entity, old state, new state); returns the unsubscribe. */
  onStateChanged(listener: (entityId: string, from: any | null, to: any | null) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** The person entities' current states (presence for the turn's context). */
  personStates(): Array<{ entity_id: string; state: string; attributes: Record<string, any> }> {
    return [...this.statesById.values()].filter((s) => s.entity_id.startsWith('person.'));
  }

  /** The room a person is in (a per-room tracker), by name; null when unknown. */
  personRoomName(person: string): string | null {
    const id = this.model.personRoom(person);
    return id ? this.model.areaName(id) : null;
  }

  /** A WebSocket command (throws when not connected). */
  command<T = any>(msg: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    if (!this.socket) return Promise.reject(new Error('Home Assistant is not connected'));
    return this.socket.command<T>(msg, timeoutMs);
  }

  // ── VoiceChannel ─────────────────────────────────────────────────────────────

  async say(userId: string, text: string, where: { areaId?: string; person?: string }, chatId: string): Promise<string | null> {
    const socket = this.socket;
    if (!socket || !this.settings.voice) return null;
    const areaId = where.areaId ?? (where.person ? this.model.personRoom(where.person) : null);
    const point = areaId ? pickPoint(this.model.voicePoints(), areaId) : null;
    if (!point) return null;
    const listens = (point.features & START_CONVERSATION) !== 0;
    // Bound first: an answer may come before call_service returns.
    this.focus.set(userId, point.entityId, chatId, FOCUS_DEFAULT_TTL_MS);
    await socket.command({
      type: 'call_service', domain: 'assist_satellite', service: listens ? 'start_conversation' : 'announce',
      service_data: listens ? { start_message: text } : { message: text },
      target: { entity_id: point.entityId },
    }, 60_000);
    this.logger.log(`said on ${point.entityId} (${this.model.areaName(point.areaId)}, ${listens ? 'listening' : 'announce'}): ${text.length} chars`);
    return point.entityId;
  }

  // ── Connection ───────────────────────────────────────────────────────────────

  private async connect(gen: number, url: string, token: string): Promise<void> {
    const wyoming = await this.appConfig.getWyomingConfig();
    this.status.memoryUserId = wyoming.wyomingHandleUserId;
    if (gen !== this.generation) return;
    this.status = { ...this.status, state: 'connecting' };

    const socket = this.newSocket();
    try {
      await socket.connect(HaSocket.urlOf(url), token);
      this.rest = { url: new URL(url).origin, token };
      this.notifyServices = null;
      if (gen !== this.generation) return socket.close();
      const [areas, devices, entities, states] = await Promise.all([
        socket.command({ type: 'config/area_registry/list' }),
        socket.command({ type: 'config/device_registry/list' }),
        socket.command({ type: 'config/entity_registry/list' }),
        socket.command({ type: 'get_states' }),
      ]);
      const model = new HaModel();
      model.useBusy(this.settings.busy);
      model.setRegistries({ areas, devices, entities });
      model.setStates(states);
      this.statesById = new Map((states as any[]).map((s) => [s.entity_id, s]));
      this.exposedSet = await this.loadExposed(socket);
      await socket.subscribe('state_changed', (e) => {
        const id = e?.data?.entity_id;
        const next = e?.data?.new_state ?? null;
        model.update(id, next);
        if (next) this.statesById.set(id, next); else this.statesById.delete(id);
        if (this.settings.presence) this.changed();
        for (const l of this.stateListeners) {
          try { l(id, e?.data?.old_state ?? null, next); } catch (err) { this.logger.warn(`state listener failed: ${(err as Error).message}`); }
        }
      });
      // A room, device or entity added or moved (or exposed): the registries again.
      for (const type of ['area_registry_updated', 'device_registry_updated', 'entity_registry_updated']) {
        await socket.subscribe(type, () => void this.reloadRegistries(socket, model));
      }
      if (gen !== this.generation) return socket.close();
      this.socket = socket;
      this.model = model;
      this.retryMs = RETRY_MIN_MS;
      this.status = { ...this.status, state: 'connected', error: null, version: socket.version };
      socket.onClose = (reason) => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.initiatives.setVoice(null);
        this.initiatives.setPush(null);
        this.initiatives.setBusy(null);
        this.focus.setVoiceTurnListener(null);
        this.fail(`connection lost: ${reason}`, gen, true);
      };
      if (this.settings.voice) this.initiatives.setVoice(this);
      this.initiatives.setPush(this);
      if (this.settings.busy) this.initiatives.setBusy(this);
      if (this.settings.presence) this.focus.setVoiceTurnListener((turn) => this.voiceTurn(turn));
      this.logger.log(`connected to Home Assistant ${socket.version}: ${model.voicePoints().length} voice points, ${this.exposedSet.size} entities exposed to Assist`);
      if (this.settings.presence) {
        // Everyone present now is an arrival for the memory (a presence it has not got live).
        this.last = { home: new Set(), rooms: new Map() };
        this.changed(0);
        this.refresh = setInterval(() => void this.tell(current(this.model.snapshot())), REFRESH_MS);
        this.refresh.unref?.();
      }
    } catch (err) {
      socket.close();
      this.fail((err as Error).message, gen, true);
    }
  }

  /** The entities exposed to Assist (`homeassistant/expose_entity/list`, the `conversation` assistant). */
  private async loadExposed(socket: HaSocket): Promise<Set<string>> {
    try {
      const res = await socket.command<{ exposed_entities?: Record<string, { conversation?: boolean }> }>({ type: 'homeassistant/expose_entity/list' });
      return new Set(Object.entries(res?.exposed_entities ?? {}).filter(([, v]) => v?.conversation).map(([id]) => id));
    } catch (err) {
      this.logger.warn(`Home Assistant exposed entities not read (the tools see none): ${(err as Error).message}`);
      return new Set();
    }
  }

  private async reloadRegistries(socket: HaSocket, model: HaModel): Promise<void> {
    try {
      const [areas, devices, entities] = await Promise.all([
        socket.command({ type: 'config/area_registry/list' }),
        socket.command({ type: 'config/device_registry/list' }),
        socket.command({ type: 'config/entity_registry/list' }),
      ]);
      model.setRegistries({ areas, devices, entities });
      this.exposedSet = await this.loadExposed(socket);
      if (this.settings.presence) this.changed();
    } catch (err) {
      this.logger.warn(`Home Assistant registries not reloaded: ${(err as Error).message}`);
    }
  }

  private fail(error: string, gen: number, retry: boolean): void {
    if (gen !== this.generation) return;
    this.status = { ...this.status, state: 'error', error };
    this.logger.warn(`Home Assistant: ${error}${retry ? ` — retrying in ${Math.round(this.retryMs / 1000)}s` : ''}`);
    this.clearTimers();
    if (!retry) return;
    this.retry = setTimeout(() => void this.reconnect(gen), this.retryMs);
    this.retry.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private async reconnect(gen: number): Promise<void> {
    const cfg = await this.appConfig.getHomeAssistantConfig(true);
    if (gen === this.generation && cfg.haUrl && cfg.haToken) await this.connect(gen, cfg.haUrl, cfg.haToken);
  }

  private stop(): void {
    this.generation++;
    this.clearTimers();
    this.initiatives.setVoice(null);
    this.initiatives.setPush(null);
    this.initiatives.setBusy(null);
    this.focus.setVoiceTurnListener(null);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  private clearTimers(): void {
    if (this.settle) clearTimeout(this.settle);
    if (this.refresh) clearInterval(this.refresh);
    if (this.retry) clearTimeout(this.retry);
    this.settle = this.refresh = this.retry = null;
  }

  // ── Presence ─────────────────────────────────────────────────────────────────

  /** A state changed: once the changes are gathered, the impulses for what changed. */
  private changed(delayMs = SETTLE_MS): void {
    if (this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = null;
      const next = this.model.snapshot();
      const changes = impulses(this.last, next);
      this.last = next;
      void this.tell(changes);
    }, delayMs);
    this.settle.unref?.();
  }

  /**
   * Someone spoke to a satellite: its room is lived in — a presence there for the memory, once the answer has been
   * spoken (turnSpeaker: who, by elimination). Recordare tells an arrival from a refresh: a first turn may bring what is
   * due, the next ones only a timed request or promise.
   */
  voiceTurn(turn: VoiceTurn, delayMs = TURN_DELAY_MS): void {
    const userId = this.status.memoryUserId;
    if (!this.settings.presence || !this.socket || !userId || turn.userId !== userId) return;
    const point = this.model.voicePointOf(turn.satelliteId, turn.deviceId);
    if (!point) return;
    const timer = setTimeout(() => {
      if (!this.socket) return;
      const who = turnSpeaker(this.model.snapshot(), point.areaId, ROOM_CONFIDENCE, ALONE_CONFIDENCE);
      void this.initiatives.roomPresence(userId, {
        channel: 'voice',
        place: this.model.areaName(point.areaId),
        people: who.people.map((p) => ({ identity: { channel: 'homeassistant', externalId: p.person }, confidence: p.confidence })),
        ...(who.someone ? { someone: who.someone } : {}),
        ttlSeconds: Math.round((REFRESH_MS * 2) / 1000),
      }, point.areaId).catch((err) => this.logger.warn(`Home Assistant: a satellite turn's presence failed: ${(err as Error).message}`));
    }, delayMs);
    timer.unref?.();
  }

  /** Whether a sensor on the phone of `person` (`person.x`) says they are busy now (the busy switch on, connected). */
  busy(person: string): boolean {
    return this.settings.busy && !!this.socket && this.model.personBusy(person);
  }

  /** Tells the memory (the Wyoming user's) these impulses, one at a time. */
  private async tell(list: Impulse[]): Promise<void> {
    const userId = this.status.memoryUserId;
    if (!this.settings.presence || !userId || !list.length) return;
    for (const imp of list) {
      const room = imp.channel === 'voice';
      await this.initiatives.roomPresence(userId, {
        channel: imp.channel,
        ...(imp.areaId ? { place: this.model.areaName(imp.areaId) } : {}),
        people: imp.people.map((p) => ({ identity: { channel: 'homeassistant', externalId: p }, confidence: room ? ROOM_CONFIDENCE : 1 })),
        ...(imp.someone ? { someone: imp.someone } : {}),
        ttlSeconds: Math.round((REFRESH_MS * 2) / 1000),
        ...(imp.left ? { left: true } : {}),
        ...(imp.busy !== undefined ? { busy: imp.busy } : {}),
      }, room ? imp.areaId : undefined);
      if (imp.busy !== undefined) this.logger.log(`presence busy: ${imp.busy} for ${imp.people.join(', ')} (${imp.areaId ? this.model.areaName(imp.areaId) : imp.channel})`);
    }
  }
}

/** The voice point to speak on in an area: one that listens first, else the first. */
function pickPoint(points: VoicePoint[], areaId: string): VoicePoint | null {
  const here = points.filter((p) => p.areaId === areaId);
  return here.find((p) => (p.features & START_CONVERSATION) !== 0) ?? here[0] ?? null;
}
