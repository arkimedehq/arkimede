// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file plugins.service.ts
 *
 * The plugins' life cycle (specs/PLUGINS.md §10): install a package (ZIP or registry) after checking its manifest and
 * signature, keep it waiting for the admin's approval, then create what it contributes through the installers that
 * exist (skills, MCP servers, flows, daemons — owned by the plugin's owner, with the plugin's scope), configure it,
 * update it (back to approval when it asks more), disable it and remove it. Also who sees a plugin (its scope), its
 * settings and the configuration its scripts get, the links between its people and Arkimede's users, and the trusted
 * signing keys.
 *
 * The package lives on disk under PLUGINS_BASE_PATH/<name>/ (`current`: the version running; `pending`: one waiting
 * for approval). The plugin's code never runs in this process: its scripts are skills, run by the executor.
 */
import {
  BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { LessThan, Repository } from 'typeorm';
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { Plugin, PluginEvent, PluginIdentity, PluginKv, PluginScope, PluginSetting, PluginTrustedKey } from './plugin.entity';
import {
  PluginManifest, PluginManifestError, PluginPackage, PluginPermissions, SUPPORTED_CONTRACTS, bareScript, needsAdminApproval, newPermissions,
  readPluginPackage,
} from './plugin-manifest';
import { TrustedKey, mintPluginToken, officialKeys, sha256Hex, trustOf, validPublicKey } from './plugin-trust';
import { Skill } from '../skills/skill.entity';
import { SkillsService } from '../skills/skills.service';
import { McpServer } from '../mcp-servers/mcp-server.entity';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { Flow } from '../flows/flow.entity';
import { FlowsService } from '../flows/flows.service';
import { DaemonsService } from '../daemons/daemons.service';
import { TeamsService } from '../teams/teams.service';
import { AppConfigEntity } from '../app-config/app-config.entity';
import { Agent } from '../agents/agent.entity';
import { User } from '../users/users.entity';
import { AuditService } from '../audit/audit.service';
import { decrypt, encrypt } from '../custom-tools/crypto.utils';

const CONFIG_ID = 1;
const EVENT_RETENTION_DAYS = 30;
const SWEEP_MS = 24 * 3_600_000;
/** How long the daemons of a newly activated plugin wait for its skills to finish installing. */
const SKILLS_READY_TIMEOUT_MS = 15 * 60_000;
const SKILLS_READY_POLL_MS = 5_000;
/** The people script (manifest `people`): its time, how long its list is kept, how many people it may give. */
const PEOPLE_TIMEOUT_MS = 20_000;
const PEOPLE_CACHE_MS = 60_000;
const MAX_KNOWN_PEOPLE = 2000;
/** A Home Assistant person entity. */
const HA_PERSON = /^person\.[a-z0-9_]{1,200}$/;

/** One of the people a plugin knows, as its people script lists them. */
export interface KnownPerson { id: string; name: string | null; lastSeen: string | null }

export interface PluginReview {
  plugin: Plugin;
  manifest: PluginManifest;
  permissions: PluginPermissions;
  /** What it asks beyond what was approved (all of it on a first install). */
  newPermissions: string[];
}

export interface ApproveOptions {
  scope?: PluginScope;
  teamId?: string | null;
  agentId?: string | null;
}

/** Who installs, and how (specs/EXTENSION_AUDIENCE.md). */
export interface InstallOptions {
  signature?: string | null;
  keyId?: string | null;
  /** The actor is an admin. */
  isAdmin?: boolean;
  /** The package came from the registry, checked against its SHA-256: a trusted source even unsigned. */
  fromRegistry?: boolean;
  /** An admin installing a copy on a user's behalf: the copy is that user's. */
  forUserId?: string | null;
  /** The copy this package updates (its manager chose it): the package must carry its name; the owner stays. */
  targetId?: string | null;
}

@Injectable()
export class PluginsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PluginsService.name);
  private readonly base: string;
  private sweep: NodeJS.Timeout | null = null;
  /** The people scripts' last lists, per plugin (PEOPLE_CACHE_MS). */
  private readonly knownCache = new Map<string, { at: number; people: KnownPerson[] }>();

  constructor(
    @InjectRepository(Plugin) private readonly repo: Repository<Plugin>,
    @InjectRepository(PluginSetting) private readonly settingRepo: Repository<PluginSetting>,
    @InjectRepository(PluginEvent) private readonly eventRepo: Repository<PluginEvent>,
    @InjectRepository(PluginKv) private readonly kvRepo: Repository<PluginKv>,
    @InjectRepository(PluginIdentity) private readonly identityRepo: Repository<PluginIdentity>,
    @InjectRepository(PluginTrustedKey) private readonly keyRepo: Repository<PluginTrustedKey>,
    @InjectRepository(Skill) private readonly skillRepo: Repository<Skill>,
    @InjectRepository(McpServer) private readonly mcpRepo: Repository<McpServer>,
    @InjectRepository(Flow) private readonly flowRepo: Repository<Flow>,
    @InjectRepository(AppConfigEntity) private readonly configRepo: Repository<AppConfigEntity>,
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly skills: SkillsService,
    private readonly mcp: McpServersService,
    private readonly flows: FlowsService,
    private readonly daemons: DaemonsService,
    private readonly teams: TeamsService,
    private readonly cfg: ConfigService,
    @Optional() private readonly audit?: AuditService,
  ) {
    this.base = cfg.get<string>('PLUGINS_BASE_PATH', '/app/uploads/plugins');
  }

  onModuleInit(): void {
    this.skills.setPluginConfigProvider((pluginId) => this.configFor(pluginId));
    this.skills.setPluginEgressProvider(() => this.egressHosts());
    // The skills synced the egress allowlist at their own start, before this provider: sync again with the plugins' hosts.
    void this.skills.syncEgress();
    this.sweep = setInterval(() => void this.dropOldEvents(), SWEEP_MS);
    this.sweep.unref?.();
    void this.dropOldEvents();
  }

  onModuleDestroy(): void {
    this.skills.setPluginConfigProvider(null);
    this.skills.setPluginEgressProvider(null);
    if (this.sweep) clearInterval(this.sweep);
  }

  contract(): { supported: number[] } {
    return { supported: SUPPORTED_CONTRACTS };
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  /** The copies a user manages: every one for an admin, their own otherwise. */
  findAll(userId?: string, isAdmin = true): Promise<Plugin[]> {
    return this.repo.find({ where: isAdmin || !userId ? {} : { ownerId: userId }, order: { name: 'ASC' } });
  }

  /** Whether the user manages this copy: an admin, or its owner. */
  canManage(plugin: Pick<Plugin, 'ownerId'>, user: { id: string; role?: string }): boolean {
    return user.role === 'admin' || plugin.ownerId === user.id;
  }

  async findOne(id: string): Promise<Plugin> {
    const plugin = await this.repo.findOne({ where: { id } });
    if (!plugin) throw new NotFoundException('Plugin not found');
    return plugin;
  }

  /** A user's copy of a plugin, by name. */
  async findCopy(name: string, ownerId: string): Promise<Plugin | null> {
    return this.repo.findOne({ where: { name, ownerId } });
  }

  /** Whether `userId` sees the plugin: its scope, as for skills and tools. */
  async visibleTo(plugin: Pick<Plugin, 'scope' | 'ownerId' | 'teamId'>, userId: string): Promise<boolean> {
    if (plugin.scope === 'org') return true;
    if (plugin.scope === 'personal') return plugin.ownerId === userId;
    return !!plugin.teamId && (await this.teams.teamIdsForUser(userId)).includes(plugin.teamId);
  }

  /** The active plugins the user sees, with their pages (the menu): one per name, their own copy first. */
  async pagesFor(userId: string): Promise<Array<{ name: string; label: string; pages: Array<{ id: string; title: string }> }>> {
    const active = await this.repo.find({ where: { status: 'active' }, order: { name: 'ASC' } });
    const names = [...new Set(active.filter((p) => p.manifest?.contributes.ui.pages.length).map((p) => p.name))];
    const out: Array<{ name: string; label: string; pages: Array<{ id: string; title: string }> }> = [];
    for (const name of names) {
      const p = await this.preferred(active.filter((x) => x.name === name), userId);
      if (p) out.push({ name: p.name, label: p.manifest?.label ?? p.name, pages: p.manifest!.contributes.ui.pages.map((x) => ({ id: x.id, title: x.title })) });
    }
    return out;
  }

  /**
   * The copy of a plugin the user reaches by name: their own first, then their team's, then the organization's; 404
   * otherwise (a plugin out of reach is not revealed).
   */
  async activeFor(name: string, userId: string): Promise<Plugin> {
    const plugin = await this.preferred(await this.repo.find({ where: { name, status: 'active' } }), userId);
    if (!plugin?.manifest) throw new NotFoundException('Plugin not found');
    return plugin;
  }

  private async preferred(copies: Plugin[], userId: string): Promise<Plugin | null> {
    const rank = (p: Plugin) => (p.scope === 'personal' ? 0 : p.scope === 'team' ? 1 : 2);
    for (const p of [...copies].sort((a, b) => rank(a) - rank(b))) if (await this.visibleTo(p, userId)) return p;
    return null;
  }

  /** What the admin reviews: the version waiting (or running), its permissions and what is new in them. */
  async review(id: string): Promise<PluginReview> {
    const plugin = await this.findOne(id);
    const dir = this.dir(plugin.id, plugin.pendingManifest ? 'pending' : 'current');
    const pkg = this.readDir(dir);
    return { plugin, manifest: pkg.manifest, permissions: pkg.permissions, newPermissions: newPermissions(plugin.grants, pkg.permissions) };
  }

  /** The primitives a plugin created (its page in the settings). */
  async contents(id: string): Promise<{ skills: Array<{ id: string; name: string; status: string }>; mcp: Array<{ id: string; name: string }>; flows: Array<{ id: string; name: string; enabled: boolean }> }> {
    const [skills, mcp, flows] = await Promise.all([
      this.skillRepo.find({ where: { pluginId: id }, select: { id: true, name: true, status: true } }),
      this.mcpRepo.find({ where: { pluginId: id }, select: { id: true, name: true } }),
      this.flowRepo.find({ where: { pluginId: id }, select: { id: true, name: true, enabled: true } }),
    ]);
    return { skills, mcp, flows };
  }

  async events(id: string, limit = 100): Promise<PluginEvent[]> {
    return this.eventRepo.find({ where: { pluginId: id }, order: { createdAt: 'DESC' }, take: Math.min(Math.max(limit, 1), 500) });
  }

  // ── Install, approve, update ─────────────────────────────────────────────

  /**
   * Installs a package (specs/EXTENSION_AUDIENCE.md): anyone, for themselves, from a trusted source (the registry, or
   * signed by a trusted key); an unsigned ZIP only an admin, when the instance allows it; an admin may install a copy
   * on a user's behalf. Every copy starts personal. A copy that reaches the network, the core or resources waits for an
   * admin's approval; any other runs at once for a user (an admin reviews it first). A package with the name of a copy
   * the owner has is an update of that copy: applied at once when it asks nothing new, else stopped until approved.
   * `targetId` names the copy to update (its page's "update"), whoever installs it: settings, people, networks and the
   * flows' state are kept, as for any update; the same version again reinstalls it.
   */
  async install(buffer: Buffer, actorId: string, opts: InstallOptions = {}): Promise<PluginReview> {
    let pkg: PluginPackage;
    try {
      pkg = readPluginPackage(buffer);
    } catch (err) {
      if (err instanceof PluginManifestError) throw new BadRequestException(err.message);
      throw err;
    }
    const isAdmin = opts.isAdmin ?? false;
    const sha256 = sha256Hex(buffer);
    const trust = trustOf(sha256, opts.signature, await this.trustedKeys(), opts.keyId);
    const trusted = !!opts.fromRegistry || trust.level !== 'unsigned';
    if (!trusted && !(isAdmin && (await this.allowUnsigned()))) {
      await this.audit?.record({ actorId, action: 'plugin.install', resource: pkg.manifest.name, outcome: 'denied', ctx: { reason: 'untrusted source' } });
      throw new ForbiddenException(isAdmin
        ? 'This plugin has no valid signature from a trusted key, and unsigned plugins are not allowed on this instance.'
        : 'Plugins can be installed from the registry or signed by a trusted key.');
    }
    const { manifest } = pkg;
    const target = opts.targetId ? await this.findOne(opts.targetId) : null;
    if (target && target.name !== manifest.name) {
      throw new BadRequestException(`This package is ${manifest.name}, not ${target.name}`);
    }
    let ownerId = target?.ownerId ?? actorId;
    if (!target && opts.forUserId && opts.forUserId !== actorId) {
      if (!isAdmin) throw new ForbiddenException('Only an admin installs a plugin on a user\'s behalf');
      if (!(await this.userRepo.exists({ where: { id: opts.forUserId } }))) throw new BadRequestException('User not found');
      ownerId = opts.forUserId;
    }
    const audience = manifest.audience ?? 'shared';
    const existing = target ?? await this.findCopy(manifest.name, ownerId);

    if (!existing) {
      const plugin = await this.repo.save(this.repo.create({
        name: manifest.name, version: manifest.version, contract: manifest.contract, manifest: null, pendingManifest: manifest,
        status: 'pending_approval', statusDetail: null, scope: 'personal', ownerId, teamId: null, agentId: null, audience,
        trust: trust.level, signedBy: trust.keyId, sha256, grants: null, tokenVersion: 1,
      }));
      this.extract(pkg.zip, this.dir(plugin.id, 'pending'));
      await this.audit?.record({ actorId, action: 'plugin.install', resource: plugin.name, outcome: 'ok', ctx: { version: plugin.version, trust: trust.level, ownerId, audience } });
      // A user's copy that needs nothing of the admin runs at once.
      if (!isAdmin && !needsAdminApproval(pkg.permissions)) await this.approve(plugin.id, ownerId, {}, { system: true });
      return this.review(plugin.id);
    }

    const asks = newPermissions(existing.grants, pkg.permissions);
    const patch: Partial<Plugin> = { version: manifest.version, contract: manifest.contract, trust: trust.level, signedBy: trust.keyId, sha256, audience };
    if (audience === 'personal' && existing.scope !== 'personal') {
      throw new BadRequestException('This version is personal: the shared copy cannot take it (install it as a personal copy)');
    }
    this.extract(pkg.zip, this.dir(existing.id, 'pending'));
    if (!asks.length && existing.status === 'active' && existing.manifest) {
      // Nothing new to approve: the new version replaces the old one now.
      await this.repo.update(existing.id, patch);
      await this.apply(await this.findOne(existing.id), actorId);
      await this.audit?.record({ actorId, action: 'plugin.update', resource: existing.name, outcome: 'ok', ctx: { version: manifest.version } });
      return this.review(existing.id);
    }
    // It asks more (or the copy was not running): it waits for the admin, stopped.
    if (existing.status === 'active') await this.stop(existing);
    await this.repo.update(existing.id, {
      ...patch, pendingManifest: manifest, status: 'pending_approval',
      statusDetail: asks.length && existing.grants ? `The update asks: ${asks.join(', ')}` : null,
    });
    await this.skills.syncEgress();
    await this.audit?.record({ actorId, action: 'plugin.update', resource: existing.name, outcome: 'ok', ctx: { version: manifest.version, pending: true, asks } });
    return this.review(existing.id);
  }

  /**
   * Approves the version waiting (an admin; or the system, for a user's copy that needs nothing of the admin): a shared
   * plugin's scope and team are chosen here (a personal one stays personal), the agent too; its contributions are
   * created.
   */
  async approve(id: string, actorId: string, opts: ApproveOptions = {}, how: { system?: boolean } = {}): Promise<Plugin> {
    const plugin = await this.findOne(id);
    if (!plugin.pendingManifest) throw new BadRequestException('Nothing waits for approval');
    const { scope, teamId } = this.scopeFor(plugin, opts);
    const agentId = await this.agentFor({ ...plugin, scope }, opts.agentId);
    const pkg = this.readDir(this.dir(plugin.id, 'pending'));
    await this.repo.update(id, {
      scope, teamId, agentId, grants: pkg.permissions, approvedBy: how.system ? null : actorId, approvedAt: new Date(), statusDetail: null,
    });
    await this.apply(await this.findOne(id), actorId);
    await this.audit?.record({ actorId, action: 'plugin.approve', resource: plugin.name, outcome: 'ok', ctx: { version: plugin.version, scope, grants: pkg.permissions, automatic: !!how.system } });
    return this.findOne(id);
  }

  /** The scope a copy may have: a personal plugin is always personal; a shared one what the admin chose. */
  private scopeFor(plugin: Plugin, opts: ApproveOptions): { scope: PluginScope; teamId: string | null } {
    const scope = opts.scope ?? plugin.scope;
    if (plugin.audience === 'personal' && scope !== 'personal') {
      throw new BadRequestException('This plugin is personal: it cannot be shared with a team or the organization');
    }
    const teamId = scope === 'team' ? (opts.teamId ?? plugin.teamId) : null;
    if (scope === 'team' && !teamId) throw new BadRequestException('teamId missing for team scope');
    return { scope, teamId };
  }

  /** The agent for agent.ask: an agent of the copy's owner for a personal copy, any agent for a shared one. */
  private async agentFor(plugin: Plugin, chosen: string | null | undefined): Promise<string | null> {
    const agentId = chosen !== undefined ? chosen : plugin.agentId;
    if (!agentId) return null;
    const where = plugin.scope === 'personal' ? { id: agentId, userId: plugin.ownerId } : { id: agentId };
    if (!(await this.agentRepo.exists({ where }))) throw new BadRequestException('Agent not found');
    return agentId;
  }

  /** Rejects the version waiting: a first install is removed; an update is dropped and the plugin stays disabled. */
  async reject(id: string, actorId: string): Promise<void> {
    const plugin = await this.findOne(id);
    if (!plugin.pendingManifest) throw new BadRequestException('Nothing waits for approval');
    fs.rmSync(this.dir(plugin.id, 'pending'), { recursive: true, force: true });
    if (!plugin.manifest) {
      await this.uninstall(id, actorId);
      return;
    }
    await this.repo.update(id, { pendingManifest: null, status: 'disabled', statusDetail: 'Update rejected', version: plugin.manifest.version });
    await this.audit?.record({ actorId, action: 'plugin.reject', resource: plugin.name, outcome: 'ok' });
  }

  /**
   * Makes the package in `pending` (if any) the running one and (re)creates its contributions from it; the flows keep
   * whether they were on. The plugin becomes active, with a new token version.
   */
  private async apply(plugin: Plugin, actorId: string): Promise<void> {
    const pending = this.dir(plugin.id, 'pending');
    const current = this.dir(plugin.id, 'current');
    if (fs.existsSync(pending)) {
      fs.rmSync(current, { recursive: true, force: true });
      fs.renameSync(pending, current);
    }
    const pkg = this.readDir(current);
    const flowsOn = new Map((await this.flowRepo.find({ where: { pluginId: plugin.id }, select: { name: true, enabled: true } })).map((f) => [f.name, f.enabled]));
    // The network the admin gave its skills (a LAN broker needs an open network) survives an update.
    const networks = new Map((await this.skillRepo.find({ where: { pluginId: plugin.id }, select: { name: true, grantedNetworks: true, networkMode: true } }))
      .map((sk) => [sk.name, { grantedNetworks: sk.grantedNetworks ?? [], networkMode: sk.networkMode ?? null }]));
    await this.removeContributions(plugin);
    await this.repo.update(plugin.id, {
      manifest: pkg.manifest, pendingManifest: null, version: pkg.manifest.version, contract: pkg.manifest.contract,
      status: 'active', statusDetail: null, tokenVersion: plugin.tokenVersion + 1,
    });
    const active = await this.findOne(plugin.id);
    try {
      await this.createContributions(active, pkg, current, flowsOn, networks);
    } catch (err) {
      const detail = `Contributions not created: ${(err as Error).message}`;
      this.logger.warn(`plugin ${plugin.name}: ${detail}`);
      await this.repo.update(plugin.id, { status: 'error', statusDetail: detail.slice(0, 2000) });
      await this.removeContributions(active).catch(() => undefined);
      await this.skills.syncEgress();
      throw new BadRequestException(detail);
    }
    await this.skills.syncEgress();
    this.logger.log(`plugin ${plugin.name} ${pkg.manifest.version} active (actor ${actorId})`);
  }

  // ── Enable, disable, uninstall ───────────────────────────────────────────

  async disable(id: string, actorId: string): Promise<Plugin> {
    const plugin = await this.findOne(id);
    if (plugin.status !== 'active') throw new BadRequestException('The plugin is not active');
    await this.stop(plugin);
    await this.repo.update(id, { status: 'disabled' });
    await this.skills.syncEgress();
    await this.audit?.record({ actorId, action: 'plugin.disable', resource: plugin.name, outcome: 'ok' });
    return this.findOne(id);
  }

  async enable(id: string, actorId: string): Promise<Plugin> {
    const plugin = await this.findOne(id);
    if (plugin.status !== 'disabled' && plugin.status !== 'error') throw new BadRequestException('The plugin is not disabled');
    if (!plugin.manifest) throw new BadRequestException('The plugin was never approved');
    if (plugin.pendingManifest) throw new BadRequestException('A version waits for approval');
    if (plugin.status === 'error') {
      await this.apply(plugin, actorId);
    } else {
      await this.repo.update(id, { status: 'active', statusDetail: null, tokenVersion: plugin.tokenVersion + 1 });
      for (const s of await this.skillRepo.find({ where: { pluginId: id } })) await this.skills.setEnabled(s.id, s.ownerId, true);
      for (const m of await this.mcpRepo.find({ where: { pluginId: id } })) await this.mcpRepo.update(m.id, { enabled: true });
      await this.skills.syncEgress();
      this.startDaemonsWhenReady(await this.findOne(id));
    }
    await this.audit?.record({ actorId, action: 'plugin.enable', resource: plugin.name, outcome: 'ok' });
    return this.findOne(id);
  }

  /** Removes the plugin and everything it brought: contributions, files, settings, data, events, people links. */
  async uninstall(id: string, actorId: string): Promise<void> {
    const plugin = await this.findOne(id);
    await this.removeContributions(plugin);
    fs.rmSync(path.join(this.base, plugin.id), { recursive: true, force: true });
    await this.repo.delete(id);
    await this.skills.syncEgress();
    await this.audit?.record({ actorId, action: 'plugin.uninstall', resource: plugin.name, outcome: 'ok' });
  }

  /** Stops what runs: daemons stopped, skills and MCP servers switched off, tokens revoked. */
  private async stop(plugin: Plugin): Promise<void> {
    await this.repo.update(plugin.id, { tokenVersion: plugin.tokenVersion + 1 });
    await this.stopDaemons(plugin);
    for (const s of await this.skillRepo.find({ where: { pluginId: plugin.id } })) await this.skills.setEnabled(s.id, s.ownerId, false).catch(() => undefined);
    for (const m of await this.mcpRepo.find({ where: { pluginId: plugin.id } })) await this.mcpRepo.update(m.id, { enabled: false });
  }

  // ── Scope and agent ──────────────────────────────────────────────────────

  /**
   * Changes scope, team or agent of an approved copy. The scope only an admin, and never for a personal plugin; the
   * agent also the owner of a personal copy. Its primitives follow the scope.
   */
  async setAccess(id: string, actorId: string, opts: ApproveOptions, isAdmin = true): Promise<Plugin> {
    const plugin = await this.findOne(id);
    if (!isAdmin && ((opts.scope !== undefined && opts.scope !== plugin.scope) || opts.teamId !== undefined)) {
      throw new ForbiddenException('Only an admin shares a plugin');
    }
    const { scope, teamId } = this.scopeFor(plugin, opts);
    const agentId = await this.agentFor({ ...plugin, scope }, opts.agentId);
    await this.repo.update(id, { scope, teamId, agentId });
    await this.skillRepo.update({ pluginId: id }, { scope, teamId, isApproved: false });
    if (scope === 'org') for (const sk of await this.skillRepo.find({ where: { pluginId: id }, select: { id: true } })) await this.skills.approve(sk.id);
    await this.mcpRepo.update({ pluginId: id }, { scope, teamId });
    await this.flowRepo.update({ pluginId: id }, { scope, teamId });
    if (scope !== plugin.scope || teamId !== plugin.teamId) {
      // People linked to users who no longer see the plugin go back to being guests.
      for (const idn of await this.identityRepo.find({ where: { pluginId: id } })) {
        if (idn.userId && !(await this.visibleTo({ scope, teamId, ownerId: plugin.ownerId }, idn.userId))) {
          await this.identityRepo.update(idn.id, { userId: null });
        }
      }
    }
    await this.audit?.record({ actorId, action: 'plugin.access', resource: plugin.name, outcome: 'ok', ctx: { scope, teamId, agentId } });
    return this.findOne(id);
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  /** The settings as the admin sees them: the manifest's, with values (secrets only say whether they are set). */
  async settings(id: string): Promise<Array<{ key: string; description?: string; required: boolean; secret: boolean; value: string | null; set: boolean }>> {
    const plugin = await this.findOne(id);
    const manifest = plugin.manifest ?? plugin.pendingManifest;
    const stored = new Map((await this.settingRepo.find({ where: { pluginId: id } })).map((s) => [s.key, s]));
    return (manifest?.settings ?? []).map((s) => {
      const row = stored.get(s.key);
      return {
        key: s.key, description: s.description, required: !!s.required, secret: !!s.secret,
        value: s.secret ? null : (row?.value ?? s.default ?? null), set: !!row,
      };
    });
  }

  /** Sets settings (admin): unknown keys refused; an empty value removes it. The MCP servers and daemons follow. */
  async setSettings(id: string, values: Record<string, string>, actorId: string): Promise<void> {
    const plugin = await this.findOne(id);
    const manifest = plugin.manifest ?? plugin.pendingManifest;
    const decl = new Map((manifest?.settings ?? []).map((s) => [s.key, s]));
    for (const [key, value] of Object.entries(values)) {
      const d = decl.get(key);
      if (!d) throw new BadRequestException(`Unknown setting ${key}`);
      if (typeof value !== 'string' || value.length > 4000) throw new BadRequestException(`Invalid value for ${key}`);
      if (value === '') {
        await this.settingRepo.delete({ pluginId: id, key });
        continue;
      }
      const stored = d.secret ? encrypt(value) : value;
      const row = await this.settingRepo.findOne({ where: { pluginId: id, key } });
      if (row) await this.settingRepo.update(row.id, { value: stored, secret: !!d.secret });
      else await this.settingRepo.save(this.settingRepo.create({ pluginId: id, key, value: stored, secret: !!d.secret }));
    }
    await this.audit?.record({ actorId, action: 'plugin.settings', resource: plugin.name, outcome: 'ok', ctx: { keys: Object.keys(values) } });
    if (plugin.status === 'active' && plugin.manifest) {
      await this.syncMcp(plugin, plugin.manifest);
      await this.skills.syncEgress();
      await this.stopDaemons(plugin);
      this.startDaemonsWhenReady(plugin);
    }
  }

  /** The plugin's settings in clear (defaults included), for its scripts and its MCP servers. */
  private async settingValues(plugin: Plugin): Promise<Record<string, string>> {
    const manifest = plugin.manifest ?? plugin.pendingManifest;
    const out: Record<string, string> = {};
    for (const s of manifest?.settings ?? []) if (s.default !== undefined) out[s.key] = s.default;
    for (const row of await this.settingRepo.find({ where: { pluginId: plugin.id } })) {
      try {
        out[row.key] = row.secret ? decrypt(row.value) : row.value;
      } catch {
        this.logger.warn(`plugin ${plugin.name}: setting ${row.key} could not be decrypted`);
      }
    }
    return out;
  }

  /**
   * What every script of an active plugin gets in `_config` (specs/PLUGINS.md §4): its settings and its token. The
   * core's plugin API is at `$BACKEND_INTERNAL_URL/internal/plugins` (the executor gives every script that variable).
   * Nothing for a plugin that is not active (its token would not work anyway).
   */
  async configFor(pluginId: string): Promise<Record<string, string>> {
    const plugin = await this.repo.findOne({ where: { id: pluginId } });
    if (!plugin || plugin.status !== 'active' || !plugin.manifest) return {};
    return {
      ...(await this.settingValues(plugin)),
      PLUGIN_NAME: plugin.name,
      PLUGIN_VERSION: plugin.version,
      PLUGIN_TOKEN: mintPluginToken(plugin.id, plugin.tokenVersion),
    };
  }

  /**
   * The hosts active plugins reach, for the egress allowlist: their MCP servers' URLs with the settings filled in — the
   * network the admin approved ("<server> (URL from a setting)" included). Their daemons run in the executor, behind
   * the proxy. An address becomes a single-host range; a URL still missing a setting gives nothing.
   */
  async egressHosts(): Promise<string[]> {
    const hosts = new Set<string>();
    for (const plugin of await this.repo.find({ where: { status: 'active' } })) {
      if (!plugin.manifest?.contributes.mcp.length) continue;
      const values = await this.settingValues(plugin);
      for (const m of plugin.manifest.contributes.mcp) {
        let missing = false;
        const url = m.url.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, key: string) => {
          if (!values[key]) missing = true;
          return values[key] ?? '';
        });
        if (missing) continue;
        let host: string;
        try {
          host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
        } catch {
          continue;
        }
        if (!host) continue;
        hosts.add(net.isIPv4(host) ? `${host}/32` : net.isIPv6(host) ? `${host}/128` : host);
      }
    }
    return [...hosts].sort();
  }

  // ── People ───────────────────────────────────────────────────────────────

  identities(id: string): Promise<PluginIdentity[]> {
    return this.identityRepo.find({ where: { pluginId: id }, order: { createdAt: 'ASC' } });
  }

  /** Links one of the plugin's people to a user who sees the plugin (or none: a guest), and marks guests authorized. */
  /**
   * Links one of the plugin's people. `haPerson` (a Home Assistant person) only an admin sets: Home Assistant is the
   * admin's integration.
   */
  async setIdentity(id: string, externalId: string, data: { userId?: string | null; authorized?: boolean; displayName?: string | null; haPerson?: string | null }, actorId: string, isAdmin = true): Promise<PluginIdentity> {
    const plugin = await this.findOne(id);
    const ext = externalId.trim();
    if (!ext || ext.length > 256) throw new BadRequestException('Invalid id');
    if (data.haPerson !== undefined) {
      if (!isAdmin) throw new ForbiddenException('Only an admin links a Home Assistant person');
      if (data.haPerson && !HA_PERSON.test(data.haPerson)) throw new BadRequestException('Invalid Home Assistant person');
    }
    if (data.userId) {
      if (!(await this.userRepo.exists({ where: { id: data.userId } }))) throw new BadRequestException('User not found');
      if (!(await this.visibleTo(plugin, data.userId))) throw new BadRequestException('That user does not see this plugin');
    }
    let row = await this.identityRepo.findOne({ where: { pluginId: id, externalId: ext } });
    if (!row) row = this.identityRepo.create({ pluginId: id, externalId: ext, userId: null, authorized: false, displayName: null });
    if (data.userId !== undefined) row.userId = data.userId || null;
    if (data.authorized !== undefined) row.authorized = data.authorized;
    if (data.displayName !== undefined) row.displayName = data.displayName?.trim().slice(0, 128) || null;
    if (data.haPerson !== undefined) row.haPerson = data.haPerson || null;
    const saved = await this.identityRepo.save(row);
    await this.audit?.record({ actorId, action: 'plugin.identity', resource: plugin.name, outcome: 'ok', ctx: { externalId: ext, userId: saved.userId, authorized: saved.authorized, haPerson: saved.haPerson } });
    return saved;
  }

  /**
   * The people the plugin knows, from its people script (manifest `people`), run as the plugin's owner and kept a
   * minute; most recently seen first. `available: false` when it declares none, is not active, or the script fails:
   * the card then takes ids typed by hand. Arkimede never asks the plugin who is who: the owner links them.
   */
  async knownPeople(id: string, refresh = false): Promise<{ available: boolean; people: KnownPerson[] }> {
    const plugin = await this.findOne(id);
    const ref = plugin.manifest?.people;
    if (!ref || plugin.status !== 'active') return { available: false, people: [] };
    const cached = this.knownCache.get(plugin.id);
    if (!refresh && cached && Date.now() - cached.at < PEOPLE_CACHE_MS) return { available: true, people: cached.people };
    const skillId = await this.skillId(plugin, ref.skill);
    if (!skillId) return { available: false, people: [] };
    try {
      const r = await this.skills.invoke(skillId, ref.script, {}, PEOPLE_TIMEOUT_MS, plugin.ownerId);
      const list = (r.output as any)?.people;
      if (!r.success || !Array.isArray(list)) throw new Error(r.success ? 'no "people" array in the output' : 'the script failed');
      const people = knownPeopleFrom(list);
      this.knownCache.set(plugin.id, { at: Date.now(), people });
      return { available: true, people };
    } catch (err) {
      this.logger.warn(`plugin ${plugin.name}: people script: ${(err as Error).message}`);
      return { available: false, people: [] };
    }
  }

  /**
   * The Home Assistant person one of the plugin's people is: the linked account's (if it still sees the plugin), else
   * the one linked to the id. Null when neither.
   */
  async haPersonOf(plugin: Plugin, externalId: string): Promise<string | null> {
    const row = await this.identityRepo.findOne({ where: { pluginId: plugin.id, externalId } });
    if (!row) return null;
    if (row.userId && (await this.visibleTo(plugin, row.userId))) {
      const own = (await this.userRepo.findOne({ where: { id: row.userId }, select: { id: true, haPerson: true } }))?.haPerson;
      if (own) return own;
    }
    return row.haPerson ?? null;
  }

  async removeIdentity(id: string, identityId: string): Promise<void> {
    await this.identityRepo.delete({ id: identityId, pluginId: id });
  }

  /** The user an identity of the plugin is linked to, if they still see the plugin. */
  async linkedUser(plugin: Plugin, externalId: string): Promise<{ userId: string | null; authorized: boolean; displayName: string | null }> {
    const row = await this.identityRepo.findOne({ where: { pluginId: plugin.id, externalId } });
    if (!row) return { userId: null, authorized: false, displayName: null };
    const userId = row.userId && (await this.visibleTo(plugin, row.userId)) ? row.userId : null;
    return { userId, authorized: row.authorized, displayName: row.displayName };
  }

  // ── Trust ────────────────────────────────────────────────────────────────

  async trustedKeys(): Promise<TrustedKey[]> {
    const admin = await this.keyRepo.find();
    return [...officialKeys(), ...admin.map((k) => ({ id: k.keyId, level: k.level, publicKey: k.publicKey }))];
  }

  async trustSettings(): Promise<{ allowUnsigned: boolean; keys: Array<{ id: string | null; keyId: string; level: string; publicKey: string; official: boolean }> }> {
    const admin = await this.keyRepo.find({ order: { createdAt: 'ASC' } });
    return {
      allowUnsigned: await this.allowUnsigned(),
      keys: [
        ...officialKeys().map((k) => ({ id: null, keyId: k.id, level: k.level, publicKey: k.publicKey, official: true })),
        ...admin.map((k) => ({ id: k.id, keyId: k.keyId, level: k.level, publicKey: k.publicKey, official: false })),
      ],
    };
  }

  async addTrustedKey(data: { keyId: string; level: 'verified' | 'community'; publicKey: string }, actorId: string): Promise<void> {
    const keyId = data.keyId?.trim();
    if (!keyId || keyId.length > 128) throw new BadRequestException('Invalid key id');
    if (!['verified', 'community'].includes(data.level)) throw new BadRequestException('Invalid level');
    if (!validPublicKey(data.publicKey)) throw new BadRequestException('Not an ed25519 public key');
    if (officialKeys().some((k) => k.id === keyId) || (await this.keyRepo.exists({ where: { keyId } }))) throw new BadRequestException('A key with this id exists');
    await this.keyRepo.save(this.keyRepo.create({ keyId, level: data.level, publicKey: data.publicKey.trim(), addedBy: actorId }));
    await this.audit?.record({ actorId, action: 'plugin.trust_key', resource: keyId, outcome: 'ok', ctx: { level: data.level } });
  }

  async removeTrustedKey(id: string, actorId: string): Promise<void> {
    await this.keyRepo.delete({ id });
    await this.audit?.record({ actorId, action: 'plugin.untrust_key', resource: id, outcome: 'ok' });
  }

  async allowUnsigned(): Promise<boolean> {
    return (await this.configRepo.findOne({ where: { id: CONFIG_ID }, select: { id: true, pluginsAllowUnsigned: true } }))?.pluginsAllowUnsigned ?? false;
  }

  async setAllowUnsigned(on: boolean, actorId: string): Promise<void> {
    await this.configRepo.update(CONFIG_ID, { pluginsAllowUnsigned: on });
    await this.audit?.record({ actorId, action: 'plugin.allow_unsigned', resource: 'app_config', outcome: 'ok', ctx: { on } });
  }

  // ── Contributions ────────────────────────────────────────────────────────

  private async createContributions(
    plugin: Plugin, pkg: PluginPackage, dir: string, flowsOn: Map<string, boolean>,
    networks: Map<string, { grantedNetworks: string[]; networkMode: Skill['networkMode'] }> = new Map(),
  ): Promise<void> {
    const shared = { scope: plugin.scope, teamId: plugin.scope === 'team' ? plugin.teamId : null };
    for (const s of pkg.skills) {
      const zip = new AdmZip();
      zip.addLocalFolder(path.join(dir, s.dir));
      const created = await this.skills.uploadAndCreate(plugin.ownerId, zip.toBuffer());
      await this.skillRepo.update(created.id, { pluginId: plugin.id, ...shared, isApproved: false, ...(networks.get(s.name) ?? {}) });
      // Org-wide: the skills' approval, which also opens their network domains (egress).
      if (plugin.scope === 'org') await this.skills.approve(created.id);
    }
    await this.syncMcp(plugin, pkg.manifest);
    for (const f of pkg.flows) {
      const d = f.definition;
      await this.flows.create(plugin.ownerId, {
        name: String(d.name).slice(0, 120),
        description: typeof d.description === 'string' ? d.description : null,
        definition: d.definition && typeof d.definition === 'object' ? d.definition : { nodes: [], edges: [] },
        trigger: d.trigger && typeof d.trigger === 'object' ? d.trigger : { type: 'manual' },
        inputSchema: Array.isArray(d.inputSchema) ? d.inputSchema : [],
        exposeAsTool: d.exposeAsTool === true,
        enabled: flowsOn.get(String(d.name).slice(0, 120)) ?? false,
        ...shared,
        pluginId: plugin.id,
      });
    }
    this.startDaemonsWhenReady(plugin);
  }

  /**
   * Creates or updates the plugin's MCP servers from the manifest and the settings: `${KEY}` of a secret setting goes
   * in as an MCP secret (`{{secret.KEY}}`), the others as plain text. A server whose settings are missing stays off.
   */
  private async syncMcp(plugin: Plugin, manifest: PluginManifest): Promise<void> {
    const values = await this.settingValues(plugin);
    const secretKeys = new Set(manifest.settings.filter((s) => s.secret).map((s) => s.key));
    const existing = new Map((await this.mcpRepo.find({ where: { pluginId: plugin.id } })).map((m) => [m.name, m]));
    for (const m of manifest.contributes.mcp) {
      const name = `${plugin.name}-${m.name}`;
      const secrets: Record<string, string> = {};
      let missing = false;
      const fill = (v: string) => v.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, key: string) => {
        if (values[key] === undefined || values[key] === '') missing = true;
        if (secretKeys.has(key)) {
          secrets[key] = values[key] ?? '';
          return `{{secret.${key}}}`;
        }
        return values[key] ?? '';
      });
      const url = fill(m.url);
      const headers = Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k, fill(v)]));
      const enabled = !missing && plugin.status === 'active';
      const row = existing.get(name);
      if (row) {
        await this.mcpRepo.update(row.id, { url, headers, transport: m.transport, description: m.description ?? null, enabled });
        if (Object.keys(secrets).length) await this.mcp.upsertSecrets(row.id, secrets);
        existing.delete(name);
      } else {
        const created = await this.mcp.create(plugin.ownerId, {
          name, description: m.description, transport: m.transport, url, headers,
          scope: plugin.scope, teamId: plugin.scope === 'team' ? plugin.teamId : null,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        }, true, 'admin');
        await this.mcpRepo.update(created.id, { pluginId: plugin.id, enabled });
      }
    }
    // Servers the manifest no longer has.
    for (const row of existing.values()) await this.mcp.remove(row.id, row.userId, true);
  }

  private async removeContributions(plugin: Plugin): Promise<void> {
    await this.stopDaemons(plugin);
    for (const f of await this.flowRepo.find({ where: { pluginId: plugin.id }, select: { id: true } })) await this.flows.remove(f.id);
    for (const m of await this.mcpRepo.find({ where: { pluginId: plugin.id } })) await this.mcp.remove(m.id, m.userId, true);
    for (const s of await this.skillRepo.find({ where: { pluginId: plugin.id } })) await this.skills.remove(s.id, s.ownerId);
  }

  /** Starts the plugin's daemons once its skills are installed (in the background: installing can take minutes). */
  private startDaemonsWhenReady(plugin: Plugin): void {
    const daemons = plugin.manifest?.contributes.daemons ?? [];
    if (!daemons.length) return;
    void (async () => {
      const until = Date.now() + SKILLS_READY_TIMEOUT_MS;
      for (;;) {
        const fresh = await this.repo.findOne({ where: { id: plugin.id } });
        if (!fresh || fresh.status !== 'active') return;
        const skills = await this.skillRepo.find({ where: { pluginId: plugin.id }, relations: { scripts: true } });
        const needed = new Set(daemons.map((d) => d.skill));
        const pending = skills.filter((s) => needed.has(s.name) && s.status !== 'ready');
        if (pending.some((s) => s.status === 'error')) {
          await this.repo.update(plugin.id, { statusDetail: `Skill ${pending.find((s) => s.status === 'error')!.name} failed to install: daemons not started` });
          return;
        }
        if (!pending.length) {
          for (const d of daemons) {
            const skill = skills.find((s) => s.name === d.skill);
            const script = skill?.scripts?.find((x) => bareScript(x.filename) === bareScript(d.script));
            if (!skill || !script) continue;
            await this.daemons.start(skill.ownerId, skill.id, script.filename)
              .catch((err) => this.logger.warn(`plugin ${plugin.name}: daemon ${d.skill}/${d.script} not started: ${(err as Error).message}`));
          }
          return;
        }
        if (Date.now() > until) {
          await this.repo.update(plugin.id, { statusDetail: 'Skills still installing: daemons not started' });
          return;
        }
        await new Promise((r) => setTimeout(r, SKILLS_READY_POLL_MS).unref?.());
      }
    })().catch((err) => this.logger.warn(`plugin ${plugin.name}: daemons: ${(err as Error).message}`));
  }

  private async stopDaemons(plugin: Plugin): Promise<void> {
    const skillIds = (await this.skillRepo.find({ where: { pluginId: plugin.id }, select: { id: true } })).map((s) => s.id);
    if (!skillIds.length) return;
    const running = (await this.daemons.findAll(plugin.ownerId)).filter((d) => skillIds.includes(d.skillId) && ['starting', 'running', 'restarting'].includes(d.status));
    for (const d of running) await this.daemons.stop(d.id, plugin.ownerId).catch(() => undefined);
  }

  // ── Files ────────────────────────────────────────────────────────────────

  /** Where a copy's package is: `current` (running) or `pending` (waiting for approval). */
  dir(pluginId: string, which: 'current' | 'pending'): string {
    return path.join(this.base, pluginId, which);
  }

  private extract(zip: AdmZip, dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    zip.extractAllTo(dir, true);
  }

  /** Reads an extracted package back (the same checks as at install). */
  private readDir(dir: string): PluginPackage {
    if (!fs.existsSync(dir)) throw new NotFoundException('Plugin package not found on disk');
    const zip = new AdmZip();
    zip.addLocalFolder(dir);
    return readPluginPackage(zip.toBuffer());
  }

  /** A file of a running plugin's package, confined to its folder; null when missing. */
  packageFile(pluginId: string, rel: string): string | null {
    const root = path.resolve(this.dir(pluginId, 'current'));
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return null;
    try {
      const real = fs.realpathSync(file);
      return real.startsWith(fs.realpathSync(root) + path.sep) && fs.statSync(real).isFile() ? real : null;
    } catch {
      return null;
    }
  }

  private async dropOldEvents(): Promise<void> {
    try {
      await this.eventRepo.delete({ createdAt: LessThan(new Date(Date.now() - EVENT_RETENTION_DAYS * 86_400_000)) });
    } catch (err) {
      this.logger.warn(`old plugin events not dropped: ${(err as Error).message}`);
    }
  }

  /** The plugins that subscribed to `type` and may receive it (active, approved subscription). */
  async subscribers(type: string): Promise<Plugin[]> {
    const active = await this.repo.find({ where: { status: 'active' } });
    return active.filter((p) => p.grants?.subscribes.includes(type) && p.manifest?.subscribes.includes(type) && p.manifest.handlers.events);
  }

  /** The id of a plugin's skill by name (for routes and handlers). */
  async skillId(plugin: Plugin, name: string): Promise<string | null> {
    return (await this.skillRepo.findOne({ where: { pluginId: plugin.id, name }, select: { id: true } }))?.id ?? null;
  }

  /** Kv bytes used (storage quota). */
  async storageUsed(pluginId: string): Promise<number> {
    const r = await this.kvRepo.createQueryBuilder('k').select('COALESCE(SUM(k.bytes), 0)', 'sum').where('k.pluginId = :pluginId', { pluginId }).getRawOne();
    return Number(r?.sum ?? 0);
  }
}

/** A people script's list, checked: ids and names trimmed and bounded, duplicates dropped, most recently seen first. */
export function knownPeopleFrom(list: unknown[]): KnownPerson[] {
  const seen = new Set<string>();
  const out: KnownPerson[] = [];
  for (const p of list.slice(0, MAX_KNOWN_PEOPLE)) {
    const id = typeof (p as any)?.id === 'string' ? (p as any).id.trim() : '';
    if (!id || id.length > 256 || seen.has(id)) continue;
    seen.add(id);
    const name = typeof (p as any).name === 'string' ? (p as any).name.trim().slice(0, 128) || null : null;
    const at = typeof (p as any).lastSeen === 'string' ? Date.parse((p as any).lastSeen) : NaN;
    out.push({ id, name, lastSeen: Number.isNaN(at) ? null : new Date(at).toISOString() });
  }
  return out.sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '') || (a.name ?? a.id).localeCompare(b.name ?? b.id));
}
