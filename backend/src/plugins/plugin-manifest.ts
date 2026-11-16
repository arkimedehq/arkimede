// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugin-manifest.ts
 *
 * The plugin package (specs/PLUGINS.md §4), as plain data (no I/O beyond the ZIP in memory): `plugin.yaml` read and
 * validated against plugin-contract v1, every path it names checked against the package, and the permissions the
 * admin approves worked out from the content — the services and subscriptions it declares, plus what its parts reach
 * (the network domains its skills declare, the hosts of its MCP servers, its daemons, routes and pages). Permissions
 * come from what the package holds, not from a list it could get wrong.
 */
import AdmZip from 'adm-zip';
import { load as loadYaml } from 'js-yaml';
import Ajv from 'ajv';
import { z } from 'zod';
import { parseSkillMd } from '../skills/skills.service';

/** The contract versions this core runs. */
export const SUPPORTED_CONTRACTS = [1];
/** The services of contract v1; `RESERVED_SERVICES` are in the contract but the core has none yet (`unavailable`). */
export const SERVICES = ['notify', 'storage', 'agent.ask', 'say', 'perceive', 'presence.report', 'memory.search'] as const;
export const RESERVED_SERVICES = new Set<string>(['memory.search']);
export const MAX_STORAGE_KB = 10 * 1024;
export const DEFAULT_STORAGE_KB = 1024;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

const NAME = /^[a-z][a-z0-9-]{1,62}$/;
const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,62}$/;
const QUALIFIED_EVENT = /^[a-z][a-z0-9-]{1,62}\/[a-z][a-z0-9_.-]{0,62}$/;
const ROUTE_PATH = /^[A-Za-z0-9_.:-]+(\/[A-Za-z0-9_.:-]+)*$/;
const SETTING_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const ajv = new Ajv({ allErrors: false, strict: false });

const relPath = z.string().min(1).max(256)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\\'), 'unsafe path');
const scriptRef = z.object({ skill: z.string().regex(NAME), script: relPath });

const manifestSchema = z.object({
  contract: z.number().int(),
  name: z.string().regex(NAME, 'kebab-case, 2-63 characters'),
  version: z.string().min(1).max(32),
  label: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(1000),
  author: z.string().max(256).optional(),
  license: z.string().max(64).optional(),
  homepage: z.string().url().max(512).optional(),
  /**
   * `personal`: it uses one person's account, data or memory — each user installs their own copy, never shared
   * (specs/EXTENSION_AUDIENCE.md). `shared` (the default): generic, an admin may share it with a team or the organization.
   */
  audience: z.enum(['personal', 'shared']).optional(),
  settings: z.array(z.object({
    key: z.string().regex(SETTING_KEY, 'UPPER_SNAKE_CASE'),
    description: z.string().max(500).optional(),
    required: z.boolean().optional(),
    secret: z.boolean().optional(),
    default: z.string().max(2000).optional(),
  })).max(50).default([]),
  contributes: z.object({
    skills: z.array(relPath).max(20).default([]),
    mcp: z.array(z.object({
      name: z.string().regex(NAME),
      description: z.string().max(1000).optional(),
      transport: z.enum(['http', 'sse']),
      url: z.string().min(1).max(2048),
      headers: z.record(z.string().max(2048)).optional(),
    })).max(10).default([]),
    daemons: z.array(scriptRef).max(5).default([]),
    flows: z.array(relPath).max(20).default([]),
    routes: z.array(scriptRef.extend({
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().max(200).regex(ROUTE_PATH, 'segments of letters, digits, _ . - and :param'),
    })).max(50).default([]),
    ui: z.object({
      pages: z.array(z.object({
        id: z.string().regex(NAME),
        title: z.string().min(1).max(60),
        entry: relPath,
      })).max(10).default([]),
    }).default({ pages: [] }),
  }).default({}),
  events: z.array(z.object({
    name: z.string().regex(EVENT_NAME),
    description: z.string().max(500).optional(),
    schema: z.record(z.any()).optional(),
  })).max(50).default([]),
  subscribes: z.array(z.string().regex(QUALIFIED_EVENT, '<plugin>/<type>')).max(50).default([]),
  handlers: z.object({ events: scriptRef.optional() }).default({}),
  /**
   * The task script that lists the people the plugin knows (`{"people": [{id, name?, lastSeen?}]}`), run when its
   * People card opens so the owner picks an id instead of typing it. Optional: without it ids are typed by hand.
   */
  people: scriptRef.optional(),
  services: z.array(z.enum(SERVICES)).max(SERVICES.length).default([]),
  storage: z.object({ quotaKb: z.number().int().min(1).max(MAX_STORAGE_KB) }).optional(),
}).strict();

export type PluginManifest = z.infer<typeof manifestSchema>;

/** What the admin approves (and what an update is compared with). */
export interface PluginPermissions {
  services: string[];
  subscribes: string[];
  network: string[];
  daemons: string[];
  routes: string[];
  pages: string[];
  storageKb: number;
}

/** A contributed skill: its folder in the package and the name its SKILL.md gives. */
export interface PackageSkill {
  dir: string;
  name: string;
  scripts: Array<{ filename: string; mode: string }>;
  network: string[];
}

export interface PluginPackage {
  manifest: PluginManifest;
  skills: PackageSkill[];
  flows: Array<{ path: string; definition: Record<string, any> }>;
  permissions: PluginPermissions;
  zip: AdmZip;
}

export class PluginManifestError extends Error {}

/** Reads and validates a plugin ZIP. Throws PluginManifestError with a readable reason. */
export function readPluginPackage(buffer: Buffer): PluginPackage {
  if (buffer.length > MAX_PACKAGE_BYTES) throw new PluginManifestError(`package larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`);
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new PluginManifestError('not a ZIP file');
  }
  const entries = zip.getEntries();
  let unpacked = 0;
  for (const e of entries) {
    if (e.entryName.startsWith('/') || e.entryName.split('/').includes('..') || e.entryName.includes('\\')) {
      throw new PluginManifestError(`unsafe path in the package: ${e.entryName}`);
    }
    unpacked += e.header.size;
  }
  if (unpacked > MAX_UNPACKED_BYTES) throw new PluginManifestError('package too large once unpacked');
  const files = new Map(entries.filter((e) => !e.isDirectory).map((e) => [e.entryName, e]));
  const yamlEntry = files.get('plugin.yaml') ?? files.get('plugin.yml');
  if (!yamlEntry) throw new PluginManifestError('plugin.yaml missing at the root of the package');

  let raw: unknown;
  try {
    raw = loadYaml(yamlEntry.getData().toString('utf8'));
  } catch (err) {
    throw new PluginManifestError(`plugin.yaml is not valid YAML: ${(err as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PluginManifestError(`plugin.yaml: ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  const manifest = parsed.data;
  if (!SUPPORTED_CONTRACTS.includes(manifest.contract)) {
    throw new PluginManifestError(`contract ${manifest.contract} not supported (this Arkimede runs ${SUPPORTED_CONTRACTS.join(', ')})`);
  }
  const settingKeys = new Set(manifest.settings.map((s) => s.key));
  if (settingKeys.size !== manifest.settings.length) throw new PluginManifestError('settings: duplicate key');

  // Skills: each folder holds a SKILL.md; its name is what routes, daemons and handlers refer to.
  const skills: PackageSkill[] = manifest.contributes.skills.map((dir) => {
    const clean = dir.replace(/\/+$/, '');
    const md = files.get(`${clean}/SKILL.md`);
    if (!md) throw new PluginManifestError(`contributes.skills: ${clean}/SKILL.md not found`);
    let skillManifest: any;
    try {
      skillManifest = parseSkillMd(md.getData().toString('utf8')).manifest;
    } catch (err) {
      throw new PluginManifestError(`${clean}/SKILL.md: ${(err as Error).message}`);
    }
    if (!skillManifest?.name) throw new PluginManifestError(`${clean}/SKILL.md: name missing`);
    const scripts = (skillManifest.scripts ?? []).map((s: any) => ({ filename: String(s.filename), mode: String(s.mode ?? 'task') }));
    for (const s of scripts) {
      if (!files.has(`${clean}/${s.filename}`) && !files.has(`${clean}/scripts/${s.filename.replace(/^scripts\//, '')}`)) {
        throw new PluginManifestError(`${clean}/SKILL.md: script ${s.filename} not in the package`);
      }
    }
    return { dir: clean, name: String(skillManifest.name), scripts, network: (skillManifest.network ?? []).map(String) };
  });
  if (new Set(skills.map((s) => s.name)).size !== skills.length) throw new PluginManifestError('contributes.skills: two skills with the same name');

  const checkScript = (where: string, ref: { skill?: string; script?: string }, mode: 'task' | 'daemon') => {
    const skill = skills.find((s) => s.name === ref.skill);
    if (!skill) throw new PluginManifestError(`${where}: skill "${ref.skill}" is not one of contributes.skills`);
    const s = skill.scripts.find((x) => bareScript(x.filename) === bareScript(ref.script ?? ''));
    if (!s) throw new PluginManifestError(`${where}: ${ref.script} is not a script of skill "${ref.skill}"`);
    if ((mode === 'daemon') !== (s.mode === 'daemon')) throw new PluginManifestError(`${where}: ${ref.script} must be a ${mode} script (mode: ${s.mode})`);
  };
  manifest.contributes.daemons.forEach((d, i) => checkScript(`contributes.daemons[${i}]`, d, 'daemon'));
  manifest.contributes.routes.forEach((r, i) => checkScript(`contributes.routes[${i}]`, r, 'task'));
  if (manifest.handlers.events) checkScript('handlers.events', manifest.handlers.events, 'task');
  if (manifest.people) checkScript('people', manifest.people, 'task');
  if (manifest.subscribes.length && !manifest.handlers.events) {
    throw new PluginManifestError('subscribes needs handlers.events (the script that receives the events)');
  }
  const routeKeys = manifest.contributes.routes.map((r) => `${r.method} ${r.path}`);
  if (new Set(routeKeys).size !== routeKeys.length) throw new PluginManifestError('contributes.routes: duplicate route');

  const pageIds = manifest.contributes.ui.pages.map((p) => p.id);
  if (new Set(pageIds).size !== pageIds.length) throw new PluginManifestError('contributes.ui.pages: duplicate id');
  for (const p of manifest.contributes.ui.pages) {
    if (!files.has(p.entry)) throw new PluginManifestError(`contributes.ui.pages: ${p.entry} not in the package`);
  }
  const mcpNames = manifest.contributes.mcp.map((m) => m.name);
  if (new Set(mcpNames).size !== mcpNames.length) throw new PluginManifestError('contributes.mcp: duplicate name');
  for (const m of manifest.contributes.mcp) {
    for (const v of [m.url, ...Object.values(m.headers ?? {})]) {
      for (const key of placeholders(v)) {
        if (!settingKeys.has(key)) throw new PluginManifestError(`contributes.mcp "${m.name}": \${${key}} is not a setting`);
      }
    }
  }

  const flows = manifest.contributes.flows.map((p) => {
    const f = files.get(p);
    if (!f) throw new PluginManifestError(`contributes.flows: ${p} not in the package`);
    let definition: any;
    try {
      definition = JSON.parse(f.getData().toString('utf8'));
    } catch {
      throw new PluginManifestError(`contributes.flows: ${p} is not valid JSON`);
    }
    if (!definition || typeof definition !== 'object' || typeof definition.name !== 'string' || !definition.name.trim()) {
      throw new PluginManifestError(`contributes.flows: ${p} needs a "name"`);
    }
    return { path: p, definition };
  });

  if (new Set(manifest.events.map((e) => e.name)).size !== manifest.events.length) throw new PluginManifestError('events: duplicate name');
  for (const e of manifest.events) {
    if (!e.schema) continue;
    try {
      ajv.compile(e.schema);
    } catch (err) {
      throw new PluginManifestError(`events "${e.name}": invalid schema: ${(err as Error).message}`);
    }
  }

  return { manifest, skills, flows, permissions: permissionsOf(manifest, skills), zip };
}

/** A script's name without the `scripts/` folder. */
export function bareScript(filename: string): string {
  return filename.replace(/^scripts\//, '');
}

/** The `${KEY}` placeholders of a manifest value. */
export function placeholders(value: string): string[] {
  return [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map((m) => m[1]);
}

/** What a plugin reaches: declared services and subscriptions, and the reach of its parts. */
export function permissionsOf(manifest: PluginManifest, skills: PackageSkill[]): PluginPermissions {
  const hosts = manifest.contributes.mcp.map((m) => {
    try {
      const host = new URL(m.url).host;
      return host && !host.includes('$') ? host : `${m.name} (URL from a setting)`;
    } catch {
      return `${m.name} (URL from a setting)`;
    }
  });
  return {
    services: [...new Set(manifest.services)].sort(),
    subscribes: [...new Set(manifest.subscribes)].sort(),
    network: [...new Set([...skills.flatMap((s) => s.network), ...hosts])].sort(),
    daemons: manifest.contributes.daemons.map((d) => `${d.skill}/${bareScript(d.script)}`).sort(),
    routes: manifest.contributes.routes.map((r) => `${r.method} ${r.path}`).sort(),
    pages: manifest.contributes.ui.pages.map((p) => p.id).sort(),
    storageKb: manifest.services.includes('storage') ? (manifest.storage?.quotaKb ?? DEFAULT_STORAGE_KB) : 0,
  };
}

/**
 * Whether a plugin needs an admin's approval before it runs (specs/EXTENSION_AUDIENCE.md): it reaches the network, the
 * core (services, subscriptions, routes run as users) or resources (daemons, storage). One that only brings skills
 * without network, flows or pages runs at once for whoever installs it.
 */
export function needsAdminApproval(p: PluginPermissions): boolean {
  return p.network.length > 0 || p.services.length > 0 || p.subscribes.length > 0 || p.daemons.length > 0
    || p.routes.length > 0 || p.storageKb > 0;
}

/**
 * What `next` asks beyond `granted`: services, subscriptions, network, daemons and a larger quota. New routes and pages
 * are not a new permission: they run the plugin's own scripts, with what it was already granted.
 */
export function newPermissions(granted: PluginPermissions | null, next: PluginPermissions): string[] {
  if (!granted) return ['(first approval)'];
  const out: string[] = [];
  const more = (kind: string, a: string[], b: string[]) => b.filter((x) => !a.includes(x)).forEach((x) => out.push(`${kind}: ${x}`));
  more('service', granted.services, next.services);
  more('subscription', granted.subscribes, next.subscribes);
  more('network', granted.network, next.network);
  more('daemon', granted.daemons, next.daemons);
  if (next.storageKb > granted.storageKb) out.push(`storage: ${next.storageKb} KB`);
  return out;
}

const validators = new WeakMap<object, ReturnType<Ajv['compile']>>();

/** Validates an event's data against the schema its plugin declared (no schema = any object). Null when valid. */
export function validateEventData(manifest: PluginManifest, type: string, data: unknown): string | null {
  const decl = manifest.events.find((e) => e.name === type);
  if (!decl) return `type "${type}" is not declared in plugin.yaml events`;
  if (data !== undefined && (data === null || typeof data !== 'object' || Array.isArray(data))) return 'data must be an object';
  if (!decl.schema) return null;
  let validate = validators.get(decl.schema);
  if (!validate) {
    validate = ajv.compile(decl.schema);
    validators.set(decl.schema, validate);
  }
  return validate(data ?? {}) ? null : `data: ${ajv.errorsText(validate.errors)}`;
}
