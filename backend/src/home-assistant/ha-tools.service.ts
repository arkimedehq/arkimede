// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file ha-tools.service.ts
 *
 * The agent's Home Assistant tools (native, in place of Home Assistant's MCP server), a native tool source
 * (tool-sources.registry.ts) for the users the admin allows. They see and touch only the entities Home Assistant exposes
 * to Assist — the list the owner already keeps there — and ask before a lock, an alarm or a door:
 *   - ha_find_entities: entities by name, area or domain, with their state;
 *   - ha_get_state: one entity's state and attributes;
 *   - ha_call_service: an action (turn on, open, set, run a script or a scene) on exposed entities;
 *   - ha_history: how an entity's state changed over a period;
 *   - ha_logbook: what happened (who opened, what turned on) over a period;
 *   - ha_calendar_events / ha_calendar_add: a calendar's events over a period, a new event;
 *   - ha_todo_items / ha_todo_add / ha_todo_complete: a to-do list (the shopping list too);
 *   - ha_camera_snapshot: a camera's current image, shown to the model (a file, as any tool's image);
 *   - ha_notify: a push notification on a person's phone (the companion app) — the user's own, or an exposed person's.
 * The user's own Home Assistant person (users.haPerson) is named in the descriptions, so "me" and "my phone" make sense.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { User } from '../users/users.entity';
import { ToolSourcesRegistry, type ToolSource } from '../tool-sources/tool-sources.registry';
import { FilesService } from '../files/files.service';
import { toolFileLine, type ToolFile } from '../files/tool-files';
import { HomeAssistantService } from './home-assistant.service';
import { markActionTool } from '../agent/action-replies';

/** Actions that need the user's confirmation first (security: a door opened by a misunderstanding). */
const CONFIRM_DOMAINS = new Set(['lock', 'alarm_control_panel']);
const CONFIRM_COVER_CLASSES = new Set(['garage', 'gate', 'door']);
/** Services the agent never calls, whatever is exposed (the server itself, its configuration). */
const BLOCKED_DOMAINS = new Set(['homeassistant', 'hassio', 'system_log', 'recorder', 'logger', 'backup', 'update', 'shell_command', 'python_script', 'rest_command']);
const MAX_LIST = 60;
const MAX_CHANGES = 120;
const SERVICE_TIMEOUT_MS = 30_000;

/** The attributes worth showing for an entity (the rest is noise for a model). */
const KEPT_ATTRIBUTES = ['unit_of_measurement', 'device_class', 'brightness', 'color_temp_kelvin', 'temperature', 'current_temperature',
  'target_temp_high', 'target_temp_low', 'hvac_action', 'preset_mode', 'percentage', 'current_position', 'media_title', 'media_artist',
  'volume_level', 'source', 'battery_level', 'message', 'start_time', 'end_time', 'next_dawn', 'next_setting'];

type HaState = { entity_id: string; state: string; attributes: Record<string, any>; last_changed?: string };

export function needsConfirmation(entity: HaState | undefined): boolean {
  if (!entity) return false;
  const domain = entity.entity_id.split('.')[0];
  return CONFIRM_DOMAINS.has(domain) || (domain === 'cover' && CONFIRM_COVER_CLASSES.has(entity.attributes?.device_class));
}

const fold = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Most entities an area alone may target in one call ("spegni le luci in cucina"). */
const MAX_AREA_TARGETS = 30;
const MAX_CANDIDATES = 10;

export type TargetResolution =
  | { ids: string[] }
  | { error: string; candidates?: HaState[] };

/**
 * The entities a service call targets when the agent names them instead of giving entity ids, so an action
 * needs no ha_find_entities round first. Among the exposed entities — of the service's domain when it is an
 * entity domain (light.turn_on → lights), else any (music_assistant.play_media → its media player):
 * - a name: the entity whose name is exactly it, else the only one whose name, id or area holds all its words;
 *   several → ambiguous, never acted on (the candidates go back to the agent);
 * - an area alone: every entity of the service's domain in that area (needs an entity domain).
 */
export function resolveTargets(
  states: HaState[], areaOf: (id: string) => string | null,
  { domain, name, area }: { domain: string; name?: string; area?: string },
): TargetResolution {
  const entityDomain = states.some((s) => s.entity_id.startsWith(`${domain}.`));
  let pool = entityDomain ? states.filter((s) => s.entity_id.startsWith(`${domain}.`)) : states;
  if (area) pool = pool.filter((s) => { const a = areaOf(s.entity_id); return !!a && fold(a).includes(fold(area)); });
  const words = name ? fold(name).split(/\s+/).filter(Boolean) : [];
  if (!words.length) {
    if (!area) return { error: 'give entity_id, name or area' };
    if (!entityDomain) return { error: `name the ${domain} target: an area alone works only for an entity domain (light, switch, cover…)` };
    if (!pool.length) return { error: `no exposed ${domain} entity in the area "${area}"` };
    if (pool.length > MAX_AREA_TARGETS) return { error: `too many ${domain} entities in "${area}": name them` };
    return { ids: pool.map((s) => s.entity_id) };
  }
  const nameOf = (s: HaState) => fold(String(s.attributes?.friendly_name ?? ''));
  const exact = pool.filter((s) => nameOf(s) === fold(name!).trim());
  const found = exact.length ? exact : pool.filter((s) => {
    const hay = fold(`${s.entity_id} ${s.attributes?.friendly_name ?? ''} ${areaOf(s.entity_id) ?? ''}`);
    return words.every((w) => hay.includes(w));
  });
  if (found.length === 1) return { ids: [found[0].entity_id] };
  if (!found.length) return { error: `no exposed entity matches "${name}"${area ? ` in "${area}"` : ''}` };
  return { error: `"${name}" matches several entities: ask which one, or call again with its entity_id`, candidates: found.slice(0, MAX_CANDIDATES) };
}

@Injectable()
export class HaToolsService implements ToolSource, OnModuleInit, OnModuleDestroy {
  readonly name = 'ha';
  readonly label = 'Home Assistant';

  constructor(
    private readonly ha: HomeAssistantService,
    private readonly registry: ToolSourcesRegistry,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  onModuleDestroy(): void {
    this.registry.unregister(this.name);
  }

  async loadForUser(userId: string): Promise<StructuredToolInterface[]> {
    if (!this.ha.toolsFor(userId)) return [];
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, haPerson: true } });
    return this.tools(user?.haPerson ?? null, userId);
  }

  /**
   * The home now, for the turn: who is home and in which room (the persons exposed to Assist, and the user's own), and
   * who the user is in Home Assistant. Null when the tools are not for this user.
   */
  async contextFor(userId: string): Promise<string | null> {
    if (!this.ha.toolsFor(userId)) return null;
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, haPerson: true } });
    const me = user?.haPerson ?? null;
    const people = this.ha.personStates().filter((p) => p.entity_id === me || this.ha.isExposed(p.entity_id)).map((p) => {
      const name = p.attributes?.friendly_name ?? p.entity_id;
      const room = this.ha.personRoomName(p.entity_id);
      const where = p.state === 'home' ? (room ? `home, ${room}` : 'home') : p.state === 'not_home' ? 'away' : p.state;
      return `${name}${p.entity_id === me ? ' (the user)' : ''}: ${where}`;
    });
    if (!people.length && !me) return null;
    return `<home>Home Assistant now — ${people.length ? people.join('; ') : 'no person exposed'}.${me ? ` The user is ${me}.` : ''} Use the ha_* tools for devices and states.</home>`;
  }

  /** One entity as the tools show it. */
  view(s: HaState): Record<string, unknown> {
    const attrs = Object.fromEntries(KEPT_ATTRIBUTES.filter((k) => s.attributes?.[k] !== undefined).map((k) => [k, s.attributes[k]]));
    return {
      entity_id: s.entity_id,
      name: s.attributes?.friendly_name ?? s.entity_id,
      area: this.ha.areaOf(s.entity_id),
      state: s.state,
      ...(Object.keys(attrs).length ? { attributes: attrs } : {}),
      ...(s.last_changed ? { since: s.last_changed } : {}),
    };
  }

  tools(person: string | null, userId = ''): StructuredToolInterface[] {
    const me = person ? ` The user you are talking to is ${person} in Home Assistant ("me", "my phone", "my room").` : '';
    const find = new DynamicStructuredTool({
      name: 'ha_find_entities',
      description: `Finds Home Assistant entities (lights, switches, sensors, climate, covers, media players, scripts, scenes, persons…) by name, area or domain, with their current state. Only the entities the owner exposed to Assist.${me}`,
      schema: z.object({
        query: z.string().optional().describe('Words of the name or entity id, e.g. "cucina luce"'),
        area: z.string().optional().describe('An area (room) name, e.g. "Cucina"'),
        domain: z.string().optional().describe('An entity domain, e.g. light, switch, sensor, climate, cover, script, scene, person'),
        limit: z.number().int().min(1).max(MAX_LIST).optional(),
      }),
      func: async ({ query, area, domain, limit }) => {
        const words = query ? fold(query).split(/\s+/).filter(Boolean) : [];
        const found = this.ha.exposedStates().filter((s) => {
          if (domain && !s.entity_id.startsWith(`${domain}.`)) return false;
          const a = this.ha.areaOf(s.entity_id);
          if (area && (!a || !fold(a).includes(fold(area)))) return false;
          const hay = fold(`${s.entity_id} ${s.attributes?.friendly_name ?? ''} ${a ?? ''}`);
          return words.every((w) => hay.includes(w));
        });
        const shown = found.slice(0, limit ?? 30).map((s) => this.view(s));
        return JSON.stringify({ count: found.length, entities: shown });
      },
    });

    const getState = new DynamicStructuredTool({
      name: 'ha_get_state',
      description: 'The current state and main attributes of one Home Assistant entity (an exposed one).',
      schema: z.object({ entity_id: z.string().describe('e.g. sensor.cucina_temperatura') }),
      func: async ({ entity_id }) => {
        const s = this.ha.exposedStates().find((x) => x.entity_id === entity_id);
        return s ? JSON.stringify(this.view(s)) : JSON.stringify({ error: `${entity_id} is not an entity exposed to Assist` });
      },
    });

    const callService = new DynamicStructuredTool({
      name: 'ha_call_service',
      description: 'Acts in the home through Home Assistant: calls a service on exposed entities — light.turn_on (data: brightness_pct, color_name…), switch.turn_off, climate.set_temperature (data: temperature), cover.open_cover, media_player.volume_set, script.turn_on, scene.turn_on, and so on. Target the entities by entity_id, or by name (and/or area) as the user says them: they are resolved among the exposed entities, so ha_find_entities is not needed first; an area alone means every entity of that domain there ("spegni le luci in cucina"). A name that matches several entities is not acted on: the candidates come back, ask which one. Locks, alarms, garage doors and gates: ask the user first, then call again with confirmed: true.',
      schema: z.object({
        domain: z.string().describe('The service domain, e.g. light'),
        service: z.string().describe('The service, e.g. turn_on'),
        entity_id: z.union([z.string(), z.array(z.string())]).optional().describe('One or more exposed entity ids (or give name / area instead)'),
        name: z.string().optional().describe('The entity\'s name as the user says it, e.g. "luce cucina" (instead of entity_id)'),
        area: z.string().optional().describe('An area (room), alone for every entity of the domain there or to narrow a name, e.g. "Cucina"'),
        data: z.record(z.string(), z.any()).optional().describe('Service data, e.g. {"brightness_pct": 40}'),
        confirmed: z.boolean().optional().describe('true only after the user confirmed a lock, alarm, garage door or gate action'),
      }),
      func: async ({ domain, service, entity_id, name, area, data, confirmed }) => {
        if (BLOCKED_DOMAINS.has(domain)) return JSON.stringify({ error: `the ${domain} services are not available to the agent` });
        let ids = entity_id === undefined ? [] : Array.isArray(entity_id) ? entity_id : [entity_id];
        if (!ids.length && (name || area)) {
          const target = resolveTargets(this.ha.exposedStates(), (id) => this.ha.areaOf(id), { domain, name, area });
          if ('error' in target) {
            return JSON.stringify({ error: target.error, ...(target.candidates ? { candidates: target.candidates.map((s) => this.view(s)) } : {}) });
          }
          ids = target.ids;
        }
        const states = new Map(this.ha.exposedStates().map((s) => [s.entity_id, s]));
        const unknown = ids.filter((id) => !states.has(id));
        if (!ids.length || unknown.length) return JSON.stringify({ error: `not exposed to Assist: ${unknown.join(', ') || '(no entity)'}` });
        const sensitive = ids.filter((id) => needsConfirmation(states.get(id)));
        if (sensitive.length && !confirmed) {
          return JSON.stringify({ needs_confirmation: true, entities: sensitive,
            message: 'Ask the user to confirm this action on a lock, an alarm or a door, then call again with confirmed: true.' });
        }
        await this.ha.command({ type: 'call_service', domain, service, service_data: data ?? {}, target: { entity_id: ids } }, SERVICE_TIMEOUT_MS);
        await new Promise((r) => setTimeout(r, 500)); // the new state arrives as an event
        const after = this.ha.exposedStates().filter((s) => ids.includes(s.entity_id)).map((s) => this.view(s));
        return JSON.stringify({ ok: true, entities: after });
      },
    });

    const history = new DynamicStructuredTool({
      name: 'ha_history',
      description: 'How the state of a Home Assistant entity changed over a period (e.g. "when did the gate open today?", "how cold was it last night?"). Default: the last 24 hours.',
      schema: z.object({
        entity_id: z.string(),
        start: z.string().optional().describe('ISO date-time; default 24 hours ago'),
        end: z.string().optional().describe('ISO date-time; default now'),
      }),
      func: async ({ entity_id, start, end }) => {
        if (!this.ha.isExposed(entity_id)) return JSON.stringify({ error: `${entity_id} is not an entity exposed to Assist` });
        const to = end ? new Date(end) : new Date();
        const from = start ? new Date(start) : new Date(to.getTime() - 86_400_000);
        const res = await this.ha.command<Record<string, Array<{ s: string; lu: number }>>>({
          type: 'history/history_during_period', start_time: from.toISOString(), end_time: to.toISOString(),
          entity_ids: [entity_id], minimal_response: true, no_attributes: true, significant_changes_only: false,
        });
        const changes = (res?.[entity_id] ?? []).map((c) => ({ at: new Date(c.lu * 1000).toISOString(), state: c.s }));
        return JSON.stringify({ entity_id, from: from.toISOString(), to: to.toISOString(), count: changes.length,
          changes: changes.length > MAX_CHANGES ? changes.slice(-MAX_CHANGES) : changes });
      },
    });

    const logbook = new DynamicStructuredTool({
      name: 'ha_logbook',
      description: 'What happened in the home over a period, from Home Assistant\'s logbook (doors opened, lights turned on, people arriving, automations run) — for one entity or all exposed ones. Default: the last 6 hours.',
      schema: z.object({
        entity_id: z.string().optional(),
        start: z.string().optional().describe('ISO date-time; default 6 hours ago'),
        end: z.string().optional().describe('ISO date-time; default now'),
      }),
      func: async ({ entity_id, start, end }) => {
        if (entity_id && !this.ha.isExposed(entity_id)) return JSON.stringify({ error: `${entity_id} is not an entity exposed to Assist` });
        const to = end ? new Date(end) : new Date();
        const from = start ? new Date(start) : new Date(to.getTime() - 6 * 3_600_000);
        const res = await this.ha.command<Array<{ when: number | string; name?: string; message?: string; entity_id?: string; state?: string }>>({
          type: 'logbook/get_events', start_time: from.toISOString(), end_time: to.toISOString(), ...(entity_id ? { entity_ids: [entity_id] } : {}),
        });
        const events = (res ?? []).filter((e) => !e.entity_id || this.ha.isExposed(e.entity_id)).map((e) => ({
          at: typeof e.when === 'number' ? new Date(e.when * 1000).toISOString() : e.when,
          ...(e.name ? { name: e.name } : {}), ...(e.entity_id ? { entity_id: e.entity_id } : {}),
          ...(e.state !== undefined ? { state: e.state } : {}), ...(e.message ? { message: e.message } : {}),
        }));
        return JSON.stringify({ from: from.toISOString(), to: to.toISOString(), count: events.length,
          events: events.length > MAX_CHANGES ? events.slice(-MAX_CHANGES) : events });
      },
    });

    const exposedIn = (domain: string) => (id: string) => id.startsWith(`${domain}.`) && this.ha.isExposed(id);
    const notExposed = (id: string, what: string) => JSON.stringify({ error: `${id} is not a ${what} exposed to Assist` });

    const calendarEvents = new DynamicStructuredTool({
      name: 'ha_calendar_events',
      description: 'The events of a Home Assistant calendar (calendar.*) over a period. Default: the next 7 days.',
      schema: z.object({
        entity_id: z.string().describe('e.g. calendar.famiglia'),
        start: z.string().optional().describe('ISO date-time; default now'),
        end: z.string().optional().describe('ISO date-time; default 7 days after start'),
      }),
      func: async ({ entity_id, start, end }) => {
        if (!exposedIn('calendar')(entity_id)) return notExposed(entity_id, 'calendar');
        const from = start ? new Date(start) : new Date();
        const to = end ? new Date(end) : new Date(from.getTime() + 7 * 86_400_000);
        const res = await this.ha.callWithResponse<{ events?: any[] }>('calendar', 'get_events', entity_id,
          { start_date_time: from.toISOString(), end_date_time: to.toISOString() });
        const events = (res?.events ?? []).slice(0, MAX_CHANGES).map((e) => ({ summary: e.summary, start: e.start, end: e.end,
          ...(e.location ? { location: e.location } : {}), ...(e.description ? { description: String(e.description).slice(0, 300) } : {}) }));
        return JSON.stringify({ entity_id, from: from.toISOString(), to: to.toISOString(), events });
      },
    });

    const calendarAdd = new DynamicStructuredTool({
      name: 'ha_calendar_add',
      description: 'Adds an event to a Home Assistant calendar (calendar.*). Times in ISO format; for an all-day event give dates only (YYYY-MM-DD, end = the day after).',
      schema: z.object({
        entity_id: z.string(),
        summary: z.string().min(1),
        start: z.string().describe('ISO date-time, or YYYY-MM-DD for all day'),
        end: z.string().describe('ISO date-time, or YYYY-MM-DD (exclusive) for all day'),
        description: z.string().optional(),
        location: z.string().optional(),
      }),
      func: async ({ entity_id, summary, start, end, description, location }) => {
        if (!exposedIn('calendar')(entity_id)) return notExposed(entity_id, 'calendar');
        const allDay = /^\d{4}-\d{2}-\d{2}$/.test(start);
        await this.ha.command({ type: 'call_service', domain: 'calendar', service: 'create_event', target: { entity_id },
          service_data: { summary, ...(allDay ? { start_date: start, end_date: end } : { start_date_time: start, end_date_time: end }),
            ...(description ? { description } : {}), ...(location ? { location } : {}) } }, SERVICE_TIMEOUT_MS);
        return JSON.stringify({ ok: true, entity_id, summary, start, end });
      },
    });

    const todoItems = new DynamicStructuredTool({
      name: 'ha_todo_items',
      description: 'The items of a Home Assistant to-do list (todo.*, e.g. the shopping list). Default: the ones still to do.',
      schema: z.object({
        entity_id: z.string().describe('e.g. todo.lista_della_spesa'),
        status: z.enum(['needs_action', 'completed', 'all']).optional(),
      }),
      func: async ({ entity_id, status }) => {
        if (!exposedIn('todo')(entity_id)) return notExposed(entity_id, 'to-do list');
        const res = await this.ha.callWithResponse<{ items?: any[] }>('todo', 'get_items', entity_id,
          status === 'all' ? {} : { status: [status ?? 'needs_action'] });
        const items = (res?.items ?? []).slice(0, MAX_CHANGES).map((x) => ({ item: x.summary, status: x.status,
          ...(x.due ? { due: x.due } : {}), ...(x.description ? { description: x.description } : {}) }));
        return JSON.stringify({ entity_id, items });
      },
    });

    const todoAdd = new DynamicStructuredTool({
      name: 'ha_todo_add',
      description: 'Adds an item to a Home Assistant to-do list (todo.*), e.g. "milk" to the shopping list.',
      schema: z.object({
        entity_id: z.string(),
        item: z.string().min(1),
        due: z.string().optional().describe('YYYY-MM-DD or an ISO date-time, when the list supports it'),
        description: z.string().optional(),
      }),
      func: async ({ entity_id, item, due, description }) => {
        if (!exposedIn('todo')(entity_id)) return notExposed(entity_id, 'to-do list');
        const dueField = due ? (/^\d{4}-\d{2}-\d{2}$/.test(due) ? { due_date: due } : { due_datetime: due }) : {};
        await this.ha.command({ type: 'call_service', domain: 'todo', service: 'add_item', target: { entity_id },
          service_data: { item, ...dueField, ...(description ? { description } : {}) } }, SERVICE_TIMEOUT_MS);
        return JSON.stringify({ ok: true, entity_id, item });
      },
    });

    const todoComplete = new DynamicStructuredTool({
      name: 'ha_todo_complete',
      description: 'Marks an item of a Home Assistant to-do list as done (or removes it with remove: true).',
      schema: z.object({ entity_id: z.string(), item: z.string().min(1), remove: z.boolean().optional() }),
      func: async ({ entity_id, item, remove }) => {
        if (!exposedIn('todo')(entity_id)) return notExposed(entity_id, 'to-do list');
        await this.ha.command(remove
          ? { type: 'call_service', domain: 'todo', service: 'remove_item', target: { entity_id }, service_data: { item } }
          : { type: 'call_service', domain: 'todo', service: 'update_item', target: { entity_id }, service_data: { item, status: 'completed' } },
        SERVICE_TIMEOUT_MS);
        return JSON.stringify({ ok: true, entity_id, item, ...(remove ? { removed: true } : { status: 'completed' }) });
      },
    });

    const camera = new DynamicStructuredTool<any>({
      name: 'ha_camera_snapshot',
      description: 'The current image of a Home Assistant camera (camera.*): you are shown it, to tell who or what is there.',
      schema: z.object({ entity_id: z.string().describe('e.g. camera.ingresso') }),
      responseFormat: 'content_and_artifact',
      func: async ({ entity_id }: { entity_id: string }) => {
        if (!exposedIn('camera')(entity_id)) return [notExposed(entity_id, 'camera'), { toolFiles: [] }];
        const image = await this.ha.cameraImage(entity_id);
        if (!image) return [JSON.stringify({ error: 'no image' }), { toolFiles: [] }];
        const ext = image.mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        const saved = await this.files.saveToolFile(userId, `${entity_id.replace('.', '_')}-${Date.now()}.${ext}`, image.mimeType, image.data);
        const file: ToolFile = { fileId: saved.id, name: saved.originalName, mimeType: saved.mimeType, size: Number(saved.size), path: saved.storagePath };
        return [`Snapshot of ${entity_id} at ${new Date().toISOString()}\n${toolFileLine(file)}`, { toolFiles: [file] }];
      },
    });

    const notify = new DynamicStructuredTool({
      name: 'ha_notify',
      description: `Sends a push notification to a person's phone (Home Assistant's companion app): by default to the user you are talking to${person ? ` (${person})` : ''}, else to an exposed person (person.*).`,
      schema: z.object({
        message: z.string().min(1),
        title: z.string().optional(),
        person: z.string().optional().describe('person.x; default the user'),
      }),
      func: async ({ message, title, person: to }) => {
        const target = to ?? person;
        if (!target) return JSON.stringify({ error: 'no person: the user is not linked to a Home Assistant person; give one' });
        if (target !== person && !this.ha.isExposed(target)) return notExposed(target, 'person');
        const sent = await this.ha.push(target, message, title);
        return JSON.stringify(sent ? { ok: true, person: target } : { error: `${target} has no phone with the companion app` });
      },
    });

    // Action tools (agent/action-replies.ts): they act and answer only whether it worked.
    for (const t of [callService, calendarAdd, todoAdd, todoComplete, notify]) markActionTool(t);
    return [find, getState, callService, history, logbook, calendarEvents, calendarAdd, todoItems, todoAdd, todoComplete, camera, notify];
  }
}
