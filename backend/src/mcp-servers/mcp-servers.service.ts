// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file mcp-servers.service.ts
 *
 * Service for managing MCP servers:
 *   - CRUD on McpServer and McpServerSecret
 *   - Loading tools from http/sse servers with an MCP initialize + tools/list call
 *   - Proxying tool calls to http/sse, local (direct) or remote (bridge) servers
 *   - Building a LangChain DynamicStructuredTool for each MCP tool
 *
 * Transport types:
 *   http   → backend calls the remote endpoint via POST JSON-RPC
 *   sse    → like http but response as Server-Sent Events
 *   local  → backend spawns the stdio process directly (same machine)
 *   remote → stdio process on the user's machine, proxied via the Electron bridge
 *
 * "local" processes are managed by LocalMcpProcess: they persist in memory,
 * auto-restart on crash, and are stopped at onModuleDestroy.
 *
 * "remote" tools are managed by the client-side Electron bridge:
 * the bridge connects to the McpBridgeGateway (WebSocket) and notifies
 * the available tools. The service keeps them in an in-memory Map.
 */
import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy,} from '@nestjs/common';
import {promises as fsp} from 'fs';
import {join, resolve} from 'path';
import {InjectRepository} from '@nestjs/typeorm';
import {In, Repository} from 'typeorm';
import {DynamicStructuredTool} from '@langchain/core/tools';
import {z} from 'zod';
import {McpServer, McpServerScope, McpTransport} from './mcp-server.entity';
import {TeamsService} from '../teams/teams.service';
import {McpServerSecret} from './mcp-server-secret.entity';
import {decrypt, encrypt} from '../custom-tools/crypto.utils';
import {HttpHostPolicy} from '../common/ssrf-guard';
import {AppConfigEntity} from '../app-config/app-config.entity';
import {
  isSessionError, mcpInitialize, mcpRpc, McpHttpSession, McpHttpTarget, withLegacySseSession,
} from './mcp-http-client';
import {AuditService} from '../audit/audit.service';
import {LocalMcpProcess} from './local-mcp-process';

// ── MCP types ─────────────────────────────────────────────────────────────────

interface McpToolParam {
  type: string;
  description?: string;
  enum?: string[];
}

interface McpToolInputSchema {
  type: 'object';
  properties?: Record<string, McpToolParam>;
  required?: string[];
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema: McpToolInputSchema;
}

interface McpToolsListResult {
  tools: McpTool[];
}

interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** What a remote server offers: tools plus (when it declares the capability) resources. */
interface McpCatalog {
  tools: McpTool[];
  resources: McpResource[];
  templates: McpResourceTemplate[];
}

// ── Bridge registry ───────────────────────────────────────────────────────────

/**
 * In-memory registry of the tools offered by the active bridges.
 * Key: userId, Value: Map<serverConfigId, McpTool[]>
 *
 * Updated by the McpBridgeGateway when the bridge connects
 * and notifies the available tools.
 */
export type BridgeToolsRegistry = Map<string, Map<string, McpTool[]>>;

export interface BridgeSession {
  /** Function to send a tool call to the bridge and await the response */
  callTool: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<string>;
}

export interface CreateMcpServerDto {
  name: string;
  description?: string;
  transport: 'http' | 'sse' | 'local' | 'remote';
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
  secrets?: Record<string, string>;
  loadOnFirst?: boolean;
  scope?: McpServerScope;
  teamId?: string | null;
}

export interface UpdateMcpServerDto extends Partial<CreateMcpServerDto> {
  enabled?: boolean;
}

@Injectable()
export class McpServersService implements OnModuleDestroy {
  /** Registry of tools announced by the active bridges (transport 'remote'). Updated by McpBridgeGateway. */
  readonly bridgeTools: BridgeToolsRegistry = new Map();
  /** Active bridge sessions. Key: userId. Updated by McpBridgeGateway. */
  readonly bridgeSessions: Map<string, BridgeSession> = new Map();
  private readonly logger = new Logger(McpServersService.name);
  /**
   * Active local MCP processes (transport 'local').
   * Key: serverId. They persist for the whole module lifetime and auto-restart.
   */
  private readonly localProcesses = new Map<string, LocalMcpProcess>();
  /**
   * In-progress start promise (anti race-condition).
   * Prevents two concurrent requests to the same server from creating two separate processes.
   * Key: serverId. Removed as soon as the process reaches 'running' or 'error'.
   */
  private readonly startingProcesses = new Map<string, Promise<void>>();

  constructor(
    @InjectRepository(McpServer)
    private readonly serverRepo: Repository<McpServer>,
    @InjectRepository(McpServerSecret)
    private readonly secretRepo: Repository<McpServerSecret>,
    @InjectRepository(AppConfigEntity)
    private readonly appConfigRepo: Repository<AppConfigEntity>,
    private readonly teams: TeamsService,
    private readonly audit: AuditService,
  ) {}

  private static readonly LIST_SELECT = {
    id: true, name: true, description: true,
    transport: true, url: true, command: true, args: true,
    headers: true, env: true, enabled: true, loadOnFirst: true, userId: true,
    scope: true, teamId: true, createdAt: true, updatedAt: true,
    secrets: { id: true, serverId: true, keyName: true },
  } as const;

  /** OR-conditions for servers VISIBLE to a user: own + org + team-of-user. */
  private visibilityWhere(
    userId: string,
    teamIds: string[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown>[] {
    const where: Record<string, unknown>[] = [
      { ...extra, userId },
      { ...extra, scope: 'org' },
    ];
    if (teamIds.length) where.push({ ...extra, scope: 'team', teamId: In(teamIds) });
    return where;
  }

  /**
   * Validates a requested scope/team against the actor's rights (mirrors the
   * agents rule): org → admin only; team → admin or a member of that team;
   * personal → always allowed. Returns the normalized {scope, teamId}.
   */
  private async resolveScope(
    user: { id: string; role: string },
    scope: McpServerScope | undefined,
    teamId: string | null | undefined,
    current?: { scope: McpServerScope; teamId: string | null },
  ): Promise<{ scope: McpServerScope; teamId: string | null }> {
    const nextScope = scope ?? current?.scope ?? 'personal';
    if (nextScope === current?.scope && (scope === undefined)) {
      return { scope: current.scope, teamId: current.teamId };
    }
    if (nextScope === 'org') {
      if (user.role !== 'admin') {
        throw new ForbiddenException('Only admins can share an MCP server org-wide.');
      }
      return { scope: 'org', teamId: null };
    }
    if (nextScope === 'team') {
      const tid = teamId ?? current?.teamId ?? null;
      if (!tid) throw new BadRequestException('teamId is required for scope=team');
      if (user.role !== 'admin' && !(await this.teams.isMember(tid, user.id))) {
        throw new ForbiddenException('You can only share an MCP server with a team you belong to.');
      }
      return { scope: 'team', teamId: tid };
    }
    return { scope: 'personal', teamId: null };
  }

  /** Loads a server the user may MANAGE (owner or admin) or throws 404. */
  private async findManageable(id: string, userId: string, isAdmin: boolean): Promise<McpServer> {
    const server = await this.serverRepo.findOne({ where: { id } });
    if (!server || (!isAdmin && server.userId !== userId)) {
      throw new NotFoundException(`MCP server "${id}" not found`);
    }
    return server;
  }

  /**
   * Anti-SSRF policy for http/sse MCP servers, read from app_config. Permissive
   * default (allow private hosts — self-hosted MCP servers live on LAN/localhost;
   * metadata/link-local always blocked) if the row is missing.
   */
  private async getHostPolicy(): Promise<HttpHostPolicy> {
    const cfg = await this.appConfigRepo.findOne({ where: { id: 1 } }).catch(() => null);
    return {
      allowPrivateHosts: cfg?.mcpAllowPrivateHosts ?? true,
      allowlist: Array.isArray(cfg?.mcpHostAllowlist) ? cfg!.mcpHostAllowlist : [],
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log(`Stopping ${this.localProcesses.size} local MCP processes...`);
    const stops = Array.from(this.localProcesses.values()).map((p) => p.stop());
    await Promise.allSettled(stops);
    this.localProcesses.clear();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateMcpServerDto, isAdmin = false, role = 'user'): Promise<McpServer> {
    if (dto.transport === 'http' || dto.transport === 'sse') {
      if (!dto.url) throw new BadRequestException('url is required for transport http/sse');
    }
    if (dto.transport === 'local' || dto.transport === 'remote') {
      if (!dto.command) throw new BadRequestException('command is required for transport local/remote');
    }
    // Security: transport 'local' = spawning processes IN the backend container
    // (with its secrets/credentials) → reserved for admins.
    if (dto.transport === 'local' && !isAdmin) {
      await this.audit.record({
        actorId: userId, action: 'mcp.create', resource: dto.name,
        outcome: 'denied', ctx: { transport: 'local', reason: 'not_admin' },
      });
      throw new ForbiddenException(
        "Transport 'local' runs processes on the backend and is reserved for administrators.",
      );
    }

    const { scope, teamId } = await this.resolveScope({ id: userId, role }, dto.scope, dto.teamId);

    const server = this.serverRepo.create({
      userId,
      name:        dto.name,
      description: dto.description ?? null,
      transport:   dto.transport,
      url:         dto.url ?? null,
      command:     dto.command ?? null,
      args:        dto.args ?? null,
      headers:     dto.headers ?? null,
      env:         dto.env ?? null,
      enabled:     true,
      loadOnFirst: dto.loadOnFirst ?? true,
      scope,
      teamId,
    });

    const saved = await this.serverRepo.save(server);

    if (dto.secrets && Object.keys(dto.secrets).length > 0) {
      await this.upsertSecrets(saved.id, dto.secrets);
    }

    this.logger.log(`MCP server created: "${dto.name}" transport=${dto.transport} (user: ${userId})`);
    await this.audit.record({
      actorId: userId, action: 'mcp.create', resource: dto.name,
      outcome: 'ok', ctx: { transport: dto.transport, serverId: saved.id },
    });
    return this.findOne(saved.id, userId);
  }

  /** Servers VISIBLE to the user (own + team + org). */
  async findAll(userId: string): Promise<McpServer[]> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    return this.serverRepo.find({
      where: this.visibilityWhere(userId, teamIds),
      relations: { secrets: true },
      order: { createdAt: 'DESC' },
      select: McpServersService.LIST_SELECT,
    });
  }

  /** A single server VISIBLE to the user (own + team + org). Used for read/test/status. */
  async findOne(id: string, userId: string): Promise<McpServer> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    const server = await this.serverRepo.findOne({
      where: this.visibilityWhere(userId, teamIds, { id }),
      relations: { secrets: true },
      select: McpServersService.LIST_SELECT,
    });
    if (!server) throw new NotFoundException(`MCP server "${id}" not found`);
    return server;
  }

  async update(id: string, userId: string, dto: UpdateMcpServerDto, isAdmin = false, role = 'user'): Promise<McpServer> {
    const server = await this.findManageable(id, userId, isAdmin);
    const oldTransport = server.transport;

    // Security: if the resulting transport is 'local' (new or unchanged, including
    // changes to command/args of an existing local one) → reserved for admins.
    const resultingTransport = dto.transport ?? oldTransport;
    if (resultingTransport === 'local' && !isAdmin) {
      await this.audit.record({
        actorId: userId, action: 'mcp.update', resource: server.name,
        outcome: 'denied', ctx: { transport: 'local', reason: 'not_admin', serverId: id },
      });
      throw new ForbiddenException(
        "Transport 'local' runs processes on the backend and is reserved for administrators.",
      );
    }

    if (dto.name        !== undefined) server.name        = dto.name;
    if (dto.description !== undefined) server.description = dto.description ?? null;
    if (dto.url         !== undefined) server.url         = dto.url ?? null;
    if (dto.command     !== undefined) server.command     = dto.command ?? null;
    if (dto.args        !== undefined) server.args        = dto.args ?? null;
    if (dto.headers     !== undefined) server.headers     = dto.headers ?? null;
    if (dto.env         !== undefined) server.env         = dto.env ?? null;
    if (dto.enabled     !== undefined) server.enabled     = dto.enabled;
    if (dto.loadOnFirst !== undefined) server.loadOnFirst = dto.loadOnFirst;

    if (dto.scope !== undefined || dto.teamId !== undefined) {
      const { scope, teamId } = await this.resolveScope(
        { id: userId, role }, dto.scope, dto.teamId, { scope: server.scope, teamId: server.teamId },
      );
      server.scope  = scope;
      server.teamId = teamId;
    }

    // Handle transport change
    if (dto.transport !== undefined && dto.transport !== oldTransport) {
      server.transport = dto.transport;

      // Stop the local process when switching from 'local' to another transport
      if (oldTransport === 'local') {
        const localProc = this.localProcesses.get(id);
        if (localProc) {
          await localProc.stop();
          this.localProcesses.delete(id);
          this.startingProcesses.delete(id);
          this.logger.log(`[${server.name}] Local process stopped due to transport change → ${dto.transport}`);
        }
      }

      // Reset the fields incompatible with the new transport
      if (dto.transport === 'local' || dto.transport === 'remote') {
        server.url     = null;
        server.headers = null;
      } else {
        // http / sse
        server.command = null;
        server.args    = null;
        server.env     = null;
      }
    }

    await this.serverRepo.save(server);

    if (dto.secrets) {
      await this.upsertSecrets(id, dto.secrets);
    }

    return this.findOne(id, userId);
  }

  async remove(id: string, userId: string, isAdmin = false): Promise<void> {
    const server = await this.findManageable(id, userId, isAdmin);
    // Stop the local process if present
    const localProc = this.localProcesses.get(id);
    if (localProc) {
      await localProc.stop();
      this.localProcesses.delete(id);
    }
    this.startingProcesses.delete(id);
    this.remoteDiscovery.delete(id);
    await this.serverRepo.remove(server);
    this.logger.log(`MCP server deleted: "${server.name}" (user: ${userId})`);
    await this.audit.record({
      actorId: userId, action: 'mcp.delete', resource: server.name,
      outcome: 'ok', ctx: { serverId: id, transport: server.transport },
    });
  }

  // ── Secrets ───────────────────────────────────────────────────────────────

  /** Owner/admin-guarded secret upsert (the public API path). */
  async upsertSecretsChecked(
    serverId: string, secrets: Record<string, string>, userId: string, isAdmin = false,
  ): Promise<void> {
    await this.findManageable(serverId, userId, isAdmin);
    await this.upsertSecrets(serverId, secrets);
  }

  async upsertSecrets(serverId: string, secrets: Record<string, string>): Promise<void> {
    // New credentials may fix a failing server: drop any discovery backoff.
    this.remoteDiscovery.delete(serverId);
    for (const [keyName, plaintext] of Object.entries(secrets)) {
      if (!plaintext) continue;
      const encryptedValue = encrypt(plaintext);
      const existing = await this.secretRepo.findOne({ where: { serverId, keyName } });
      if (existing) {
        existing.encryptedValue = encryptedValue;
        await this.secretRepo.save(existing);
      } else {
        await this.secretRepo.save(
          this.secretRepo.create({ serverId, keyName, encryptedValue }),
        );
      }
    }
  }

  async getSecretKeys(serverId: string, userId: string, isAdmin = false): Promise<string[]> {
    // Secrets belong to the owner's configuration — only owner/admin may see the keys.
    await this.findManageable(serverId, userId, isAdmin);
    const secrets = await this.secretRepo.find({ where: { serverId } });
    return secrets.map((s) => s.keyName);
  }

  async removeSecret(serverId: string, keyName: string, userId: string, isAdmin = false): Promise<void> {
    await this.findManageable(serverId, userId, isAdmin);
    await this.secretRepo.delete({ serverId, keyName });
  }

  // ── Template interpolation ───────────────────────────────────────────────

  /**
   * Loads all the user's enabled MCP tools and returns them as
   * LangChain DynamicStructuredTool.
   *
   * - http/sse  → calls the remote server (POST JSON-RPC)
   * - local     → uses LocalMcpProcess (stdio process started by the backend)
   * - remote    → uses the Electron bridge (McpBridgeGateway)
   */
  async loadToolsForUser(
    userId: string,
    opts: { flatOnly?: boolean } = {},
  ): Promise<DynamicStructuredTool[]> {
    // flatOnly (chat): excludes servers with loadOnFirst=false (usable only via agent).
    const teamIds = await this.teams.teamIdsForUser(userId);
    const extra = opts.flatOnly
      ? { enabled: true, loadOnFirst: true }
      : { enabled: true };
    const servers = await this.serverRepo.find({
      where: this.visibilityWhere(userId, teamIds, extra),
    });

    if (servers.length === 0) return [];

    // Servers are loaded concurrently (one slow server must not add up with the
    // others); per-server lists are concatenated in the original order so the
    // tool set stays stable across requests (prompt-cache friendly).
    const perServer = await Promise.all(servers.map(async (server) => {
      const allTools: DynamicStructuredTool[] = [];
      try {
        const serverSlug = server.name.toLowerCase().replace(/\W+/g, '_');

        // ── http / sse ────────────────────────────────────────────────────
        if (server.transport === 'http' || server.transport === 'sse') {
          const secrets  = await this.loadSecrets(server.id);
          const { tools: mcpTools, resources, templates } = await this.discoverRemoteCatalog(server, secrets);

          for (const mcpTool of mcpTools) {
            const schema   = this.buildZodSchema(mcpTool);
            const toolName = `mcp_${serverSlug}_${mcpTool.name}`;

            allTools.push(new DynamicStructuredTool<any>({
              name:        toolName,
              description: mcpTool.description ?? mcpTool.name,
              schema,
              func: async (args: Record<string, unknown>) => {
                this.logger.log(`MCP ${server.transport} "${toolName}": ${JSON.stringify(args).slice(0, 200)}`);
                try {
                  const raw = await this.callRemoteMcpTool(server, secrets, mcpTool.name, args);
                  return await this.sanitizeMcpResult(raw, userId);
                } catch (err: any) {
                  this.logger.error(`MCP "${toolName}" error: ${err.message}`);
                  return `MCP error: ${err.message}`;
                }
              },
            }));
          }

          // Resources (read-only context the server exposes) are surfaced to the
          // agent as one extra tool per server, since the agent only calls tools.
          if (resources.length || templates.length) {
            const toolName = `mcp_${serverSlug}_read_resource`;
            if (allTools.some((t) => t.name === toolName)) {
              this.logger.warn(`MCP server "${server.name}": tool name ${toolName} already taken, resources not exposed`);
            } else {
              allTools.push(this.buildReadResourceTool(server, secrets, toolName, resources, templates, userId));
            }
          }

          this.logger.log(
            `MCP server "${server.name}" (${server.transport}): ${mcpTools.length} tools loaded` +
            (resources.length || templates.length ? `, ${resources.length} resources + ${templates.length} templates` : ''),
          );

        // ── local: direct stdio process ────────────────────────────────
        } else if (server.transport === 'local') {
          const mcpTools = await this.ensureLocalProcess(server);

          for (const mcpTool of mcpTools) {
            const schema   = this.buildZodSchema(mcpTool as any);
            const toolName = `mcp_${serverSlug}_${mcpTool.name}`;
            const procRef  = this.localProcesses.get(server.id)!;

            allTools.push(new DynamicStructuredTool<any>({
              name:        toolName,
              description: mcpTool.description ?? mcpTool.name,
              schema,
              func: async (args: Record<string, unknown>) => {
                this.logger.log(`MCP local "${toolName}": ${JSON.stringify(args).slice(0, 200)}`);
                if (procRef.status !== 'running') {
                  return `Local MCP server not running (status: ${procRef.status}). Check the backend logs.`;
                }
                try {
                  return await this.sanitizeMcpResult(await procRef.callTool(mcpTool.name, args), userId);
                } catch (err: any) {
                  this.logger.error(`MCP local "${toolName}" error: ${err.message}`);
                  return `Local MCP error: ${err.message}`;
                }
              },
            }));
          }

          this.logger.log(`MCP server "${server.name}" (local): ${mcpTools.length} tool`);

        // ── remote: tools via Electron bridge ─────────────────────────────
        } else if (server.transport === 'remote') {
          const userBridgeTools = this.bridgeTools.get(userId);
          const serverTools     = userBridgeTools?.get(server.id) ?? [];
          const bridgeSession   = this.bridgeSessions.get(userId);

          for (const mcpTool of serverTools) {
            const schema   = this.buildZodSchema(mcpTool);
            const toolName = `mcp_${serverSlug}_${mcpTool.name}`;

            allTools.push(new DynamicStructuredTool<any>({
              name:        toolName,
              description: mcpTool.description ?? mcpTool.name,
              schema,
              func: async (args: Record<string, unknown>) => {
                this.logger.log(`MCP remote "${toolName}" via bridge`);
                if (!bridgeSession) {
                  return 'Bridge not connected. Start the Electron bridge to use remote servers.';
                }
                try {
                  return await this.sanitizeMcpResult(
                    await bridgeSession.callTool(server.id, mcpTool.name, args), userId,
                  );
                } catch (err: any) {
                  return `Bridge error: ${err.message}`;
                }
              },
            }));
          }

          if (serverTools.length > 0) {
            this.logger.log(`MCP server "${server.name}" (remote): ${serverTools.length} tools from bridge`);
          }
        }
      } catch (err: any) {
        this.logger.warn(`Error loading tools for MCP server "${server.name}": ${err.message}`);
      }
      return allTools;
    }));

    return perServer.flat();
  }

  private interpolate(template: string, secrets: Record<string, string>): string {
    return template.replace(/\{\{([\w.]+)\}\}/g, (match, path: string) => {
      if (path.startsWith('secret.')) {
        return secrets[path.slice(7)] ?? match;
      }
      if (path.startsWith('env.')) {
        return process.env[path.slice(4)] ?? match;
      }
      return match;
    });
  }

  private interpolateHeaders(
    headers: Record<string, string> | null,
    secrets: Record<string, string>,
  ): Record<string, string> {
    if (!headers) return {};
    return Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k, this.interpolate(v, secrets)]),
    );
  }

  // ── Loading MCP tools (http/sse) ───────────────────────────────────────

  private async loadSecrets(serverId: string): Promise<Record<string, string>> {
    const secrets = await this.secretRepo.find({ where: { serverId } });
    const result: Record<string, string> = {};
    for (const s of secrets) {
      try {
        result[s.keyName] = decrypt(s.encryptedValue);
      } catch (err: any) {
        this.logger.warn(`Unable to decrypt secret "${s.keyName}" for server "${serverId}": ${err.message}`);
      }
    }
    return result;
  }

  /**
   * Connection test for a configured MCP server (owner only): performs the real
   * handshake and tool discovery, returning the tool list or the precise error —
   * the same path the agent uses, but surfaced to the UI instead of a warn log.
   */
  async testServer(id: string, userId: string): Promise<{
    ok: boolean;
    transport: McpTransport;
    tools: { name: string; description?: string }[];
    /** Resources and URI templates (exposed to the agent via read_resource). */
    resources?: { uri: string; name?: string; template?: boolean }[];
    latencyMs: number;
    sessionMode?: 'streamable' | 'plain' | 'legacy-sse';
    error?: string;
  }> {
    const teamIds = await this.teams.teamIdsForUser(userId);
    const server = await this.serverRepo.findOne({
      where: this.visibilityWhere(userId, teamIds, { id }),
    });
    if (!server) {
      throw new NotFoundException(`MCP server "${id}" not found`);
    }
    const startedAt = Date.now();
    const done = (partial: {
      ok: boolean;
      tools?: { name: string; description?: string }[];
      resources?: { resources: McpResource[]; templates: McpResourceTemplate[] };
      sessionMode?: 'streamable' | 'plain' | 'legacy-sse';
      error?: string;
    }) => ({
      ok: partial.ok,
      transport: server.transport,
      tools: (partial.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
      ...(partial.resources && (partial.resources.resources.length || partial.resources.templates.length)
        ? { resources: [
            ...partial.resources.resources.map((r) => ({ uri: r.uri, name: r.name })),
            ...partial.resources.templates.map((t) => ({ uri: t.uriTemplate, name: t.name, template: true })),
          ] }
        : {}),
      latencyMs: Date.now() - startedAt,
      ...(partial.sessionMode ? { sessionMode: partial.sessionMode } : {}),
      ...(partial.error ? { error: partial.error } : {}),
    });

    try {
      if (server.transport === 'sse') {
        const secrets = await this.loadSecrets(server.id);
        const target  = await this.buildHttpTarget(server, secrets);
        const result = await withLegacySseSession(
          target,
          async (client) => {
            const rpc = (method: string) => client.request(method, {}, 10_000);
            const listed: McpToolsListResult = await rpc('tools/list');
            const resources = client.serverCapabilities?.resources ? await this.listResources(rpc) : undefined;
            return { tools: listed?.tools ?? [], resources };
          },
          { clientName: process.env.APP_NAME ?? 'arkimede' },
        );
        // A successful test clears any discovery backoff: the next chat probes live.
        this.remoteDiscovery.delete(server.id);
        return done({ ok: true, tools: result.tools, resources: result.resources, sessionMode: 'legacy-sse' });
      }
      if (server.transport === 'http') {
        const secrets = await this.loadSecrets(server.id);
        const target  = await this.buildHttpTarget(server, secrets);
        // Always a fresh handshake: a test must exercise the full path.
        this.httpSessions.delete(server.id);
        const session = await this.getOrInitHttpSession(server, target, { forceNew: true });
        const result: McpToolsListResult = await mcpRpc(target, session, 'tools/list', {}, { timeoutMs: 10_000 });
        const resources = session.capabilities?.resources
          ? await this.listResources((method) => mcpRpc(target, session, method, {}, { timeoutMs: 10_000 }))
          : undefined;
        this.remoteDiscovery.delete(server.id);
        return done({
          ok: true,
          tools: result?.tools ?? [],
          resources,
          sessionMode: session.sessionId ? 'streamable' : 'plain',
        });
      }
      if (server.transport === 'local') {
        const tools = await this.ensureLocalProcess(server);
        return done({ ok: true, tools });
      }
      // remote: tools come from the Electron bridge registry
      const bridgeTools = this.bridgeTools.get(userId)?.get(server.id) ?? [];
      if (!this.bridgeSessions.get(userId)) {
        return done({ ok: false, error: 'Bridge not connected' });
      }
      return done({ ok: true, tools: bridgeTools });
    } catch (err: any) {
      return done({ ok: false, error: err?.message ?? String(err) });
    }
  }

  /** Cached streamable-HTTP sessions per server (TTL; invalidated on session errors). */
  private readonly httpSessions = new Map<string, { session: McpHttpSession; at: number }>();
  private static readonly HTTP_SESSION_TTL_MS = 5 * 60_000;

  /** Resolves URL/headers/policy for an http/sse server (secrets interpolated). */
  private async buildHttpTarget(server: McpServer, secrets: Record<string, string>): Promise<McpHttpTarget> {
    return {
      url: this.interpolate(server.url!, secrets),
      headers: this.interpolateHeaders(server.headers, secrets),
      policy: await this.getHostPolicy(),
    };
  }

  /** Returns a cached session for the server or performs a fresh MCP handshake. */
  private async getOrInitHttpSession(
    server: McpServer,
    target: McpHttpTarget,
    opts: { forceNew?: boolean } = {},
  ): Promise<McpHttpSession> {
    const cached = this.httpSessions.get(server.id);
    if (
      !opts.forceNew &&
      cached &&
      Date.now() - cached.at < McpServersService.HTTP_SESSION_TTL_MS
    ) {
      return cached.session;
    }
    const session = await mcpInitialize(target, { clientName: process.env.APP_NAME ?? 'arkimede' });
    this.httpSessions.set(server.id, { session, at: Date.now() });
    return session;
  }

  /**
   * Sends a JSON-RPC request to a remote MCP server, per transport:
   *   - `http` → streamable-HTTP POST client with cached session (handshake on
   *     first use, one re-initialize + retry when the server reports the session
   *     as expired/unknown — 400/404);
   *   - `sse`  → legacy HTTP+SSE transport (event stream + endpoint POSTs, one
   *     short-lived session per call).
   */
  private async httpRpc(
    server: McpServer,
    secrets: Record<string, string>,
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<any> {
    const target = await this.buildHttpTarget(server, secrets);
    if (server.transport === 'sse') {
      return withLegacySseSession(
        target,
        (client) => client.request(method, params, opts.timeoutMs ?? 15_000),
        { clientName: process.env.APP_NAME ?? 'arkimede' },
      );
    }
    const session = await this.getOrInitHttpSession(server, target);
    try {
      return await mcpRpc(target, session, method, params, opts);
    } catch (err: any) {
      if (!isSessionError(err)) throw err;
      this.httpSessions.delete(server.id);
      const fresh = await this.getOrInitHttpSession(server, target, { forceNew: true });
      return mcpRpc(target, fresh, method, params, opts);
    }
  }

  /**
   * Calls the remote MCP server (http/sse) to get the tool list.
   * Runs the MCP handshake (initialize → notifications/initialized) and
   * tools/list over the streamable-HTTP client.
   */
  private async fetchMcpTools(server: McpServer, secrets: Record<string, string>): Promise<McpTool[]> {
    const result: McpToolsListResult = await this.httpRpc(server, secrets, 'tools/list', {}, { timeoutMs: 10_000 });
    return result?.tools ?? [];
  }

  private static readonly EMPTY_CATALOG: McpCatalog = { tools: [], resources: [], templates: [] };

  /**
   * tools/list plus, only when the server declares the `resources` capability
   * in its initialize result, resources/list and resources/templates/list.
   * Servers without the capability cost exactly what they did before.
   */
  private async fetchMcpCatalog(server: McpServer, secrets: Record<string, string>): Promise<McpCatalog> {
    if (server.transport === 'sse') {
      // Legacy transport: one session per exchange → do the whole discovery in one.
      const target = await this.buildHttpTarget(server, secrets);
      return withLegacySseSession(target, async (client) => {
        const rpc = (method: string) => client.request(method, {}, 10_000);
        const tools: McpTool[] = (await rpc('tools/list'))?.tools ?? [];
        const res = client.serverCapabilities?.resources
          ? await this.listResources(rpc)
          : { resources: [], templates: [] };
        return { tools, ...res };
      }, { clientName: process.env.APP_NAME ?? 'arkimede' });
    }
    const tools = await this.fetchMcpTools(server, secrets);
    const capabilities = this.httpSessions.get(server.id)?.session.capabilities;
    const res = capabilities?.resources
      ? await this.listResources((method) => this.httpRpc(server, secrets, method, {}, { timeoutMs: 10_000 }))
      : { resources: [], templates: [] };
    return { tools, ...res };
  }

  /** resources/list + resources/templates/list; each is optional on the server side. */
  private async listResources(
    rpc: (method: string) => Promise<any>,
  ): Promise<{ resources: McpResource[]; templates: McpResourceTemplate[] }> {
    const [resources, templates] = await Promise.all([
      rpc('resources/list').then((r) => r?.resources ?? [], () => []),
      rpc('resources/templates/list').then((r) => r?.resourceTemplates ?? [], () => []),
    ]);
    return {
      resources: resources.filter((r: any) => typeof r?.uri === 'string'),
      templates: templates.filter((t: any) => typeof t?.uriTemplate === 'string'),
    };
  }

  /** Max resources/templates listed in the read_resource tool description. */
  private static readonly RESOURCE_LIST_MAX = 40;

  /**
   * One tool per server that reads any of its resources by URI. The description
   * lists the concrete resources and the URI templates (the model fills the
   * {placeholders}), so the agent can discover what to read without a round trip.
   */
  private buildReadResourceTool(
    server: McpServer,
    secrets: Record<string, string>,
    toolName: string,
    resources: McpResource[],
    templates: McpResourceTemplate[],
    userId: string,
  ): DynamicStructuredTool {
    const line = (uri: string, name?: string, description?: string) => {
      const text = [name, description].filter(Boolean).join(': ').replace(/\s+/g, ' ').slice(0, 200);
      return `- ${uri}${text ? ` — ${text}` : ''}`;
    };
    const max = McpServersService.RESOURCE_LIST_MAX;
    const sections = [
      `Reads a resource (read-only data) from the MCP server "${server.name}"` +
        (server.description ? ` (${server.description})` : '') + '.',
    ];
    if (resources.length) {
      sections.push('Resources:\n' + resources.slice(0, max).map((r) => line(r.uri, r.name, r.description)).join('\n') +
        (resources.length > max ? `\n… (${resources.length - max} more)` : ''));
    }
    if (templates.length) {
      sections.push('URI templates (replace each {placeholder} with a value):\n' +
        templates.slice(0, max).map((t) => line(t.uriTemplate, t.name, t.description)).join('\n'));
    }

    return new DynamicStructuredTool<any>({
      name: toolName,
      description: sections.join('\n\n'),
      schema: z.object({
        uri: z.string().describe('URI of the resource to read, from the list above or built from a URI template'),
      }),
      func: async ({ uri }: { uri: string }) => {
        this.logger.log(`MCP ${server.transport} "${toolName}": ${uri}`);
        try {
          const result = await this.httpRpc(server, secrets, 'resources/read', { uri }, { timeoutMs: 30_000 });
          return await this.sanitizeMcpResult(this.renderResourceContents(result), userId);
        } catch (err: any) {
          this.logger.error(`MCP "${toolName}" error: ${err.message}`);
          return `MCP error: ${err.message}`;
        }
      },
    });
  }

  /** resources/read result → text: text contents verbatim, binary blobs omitted. */
  private renderResourceContents(result: any): string {
    const contents: any[] = Array.isArray(result?.contents) ? result.contents : [];
    if (!contents.length) return 'Empty resource';
    const many = contents.length > 1;
    return contents.map((c) => {
      const body = typeof c?.text === 'string'
        ? c.text
        : `[binary resource omitted${c?.mimeType ? ` (${c.mimeType})` : ''}]`;
      return many ? `### ${c?.uri ?? ''}\n${body}` : body;
    }).join('\n\n');
  }

  /**
   * Discovery state per remote (http/sse) server: the last tool list obtained
   * and a backoff window after failures. Lets an intermittently offline server
   * (e.g. a device that is often switched off) cost nothing on the request path.
   */
  private readonly remoteDiscovery = new Map<string, {
    version: number;
    catalog?: McpCatalog;
    failures: number;
    retryAt: number;
    probing: boolean;
  }>();
  private static readonly DISCOVERY_BACKOFF_MIN_MS = 30_000;
  private static readonly DISCOVERY_BACKOFF_MAX_MS = 5 * 60_000;

  /**
   * tools/list with failure backoff:
   *   - healthy server → live discovery, as before;
   *   - server that just failed → no network until the backoff expires; the
   *     last known tool list (if any) is exposed, so calls fail fast with a
   *     clear error and the tool set stays stable;
   *   - backoff expired → re-probe in the background, request not delayed.
   * The state is reset when the server config changes (updatedAt).
   */
  private async discoverRemoteCatalog(server: McpServer, secrets: Record<string, string>): Promise<McpCatalog> {
    const version = server.updatedAt?.getTime() ?? 0;
    let state = this.remoteDiscovery.get(server.id);
    if (state && state.version !== version) {
      this.remoteDiscovery.delete(server.id);
      state = undefined;
    }

    if (state && state.failures > 0) {
      if (Date.now() >= state.retryAt && !state.probing) {
        state.probing = true;
        void this.fetchAndRecord(server, secrets, version)
          .catch(() => undefined)
          .finally(() => { const s = this.remoteDiscovery.get(server.id); if (s) s.probing = false; });
      }
      return state.catalog ?? McpServersService.EMPTY_CATALOG;
    }

    try {
      return await this.fetchAndRecord(server, secrets, version);
    } catch (err: any) {
      if (!state?.catalog) throw err;
      this.logger.warn(`MCP server "${server.name}" unreachable (${err.message}): using the last known tool list`);
      return state.catalog;
    }
  }

  /** Live tools/list; records success (fresh list) or failure (next backoff step). */
  private async fetchAndRecord(server: McpServer, secrets: Record<string, string>, version: number): Promise<McpCatalog> {
    const prev = this.remoteDiscovery.get(server.id);
    try {
      const catalog = await this.fetchMcpCatalog(server, secrets);
      if (prev?.failures) this.logger.log(`MCP server "${server.name}" reachable again`);
      this.remoteDiscovery.set(server.id, { version, catalog, failures: 0, retryAt: 0, probing: false });
      return catalog;
    } catch (err) {
      const failures = (prev?.failures ?? 0) + 1;
      const delay = Math.min(
        McpServersService.DISCOVERY_BACKOFF_MAX_MS,
        McpServersService.DISCOVERY_BACKOFF_MIN_MS * 2 ** (failures - 1),
      );
      this.remoteDiscovery.set(server.id, {
        version, catalog: prev?.catalog, failures, retryAt: Date.now() + delay, probing: prev?.probing ?? false,
      });
      this.logger.debug(`MCP server "${server.name}": discovery failed (${failures}x), next probe in ${Math.round(delay / 1000)}s`);
      throw err;
    }
  }

  // ── Build LangChain tools ─────────────────────────────────────────────────

  /**
   * Calls a tool on a remote MCP server (http/sse).
   */
  // ── MCP result sanitization ──────────────────────────────────────────────

  /** Cap on the MCP result text returned to the LLM (guards the context). */
  private static readonly MCP_RESULT_MAX_CHARS = 20_000;

  /**
   * Renders MCP content blocks into LLM-safe text: text blocks pass through,
   * image blocks are saved as per-user files and replaced with a download
   * link, anything else is stringified with a hard cap. Keeps base64 blobs
   * out of the model context and of the persisted toolCalls.
   */
  private async renderMcpContent(content: any[], userId: string): Promise<string> {
    const parts: string[] = [];
    for (const b of content) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b?.type === 'image' && typeof b.data === 'string') {
        parts.push(await this.saveMcpImage(b.data, b.mimeType, userId));
      } else if (b != null) {
        parts.push(JSON.stringify(b).slice(0, 500));
      }
    }
    return parts.join('\n');
  }

  /** MCP content block types (spec): anything else is not a block list. */
  private static readonly MCP_BLOCK_TYPES = ['text', 'image', 'audio', 'resource', 'resource_link'];

  /**
   * True only for a genuine MCP content-block array. A tool may legitimately
   * return JSON with its OWN `content` array (records, rows, documents): that
   * payload must pass through untouched, not be rendered as blocks (which would
   * silently truncate each element).
   */
  private isMcpContentBlocks(value: unknown): value is any[] {
    return Array.isArray(value) && value.length > 0 && value.every(
      (b: any) => b != null && McpServersService.MCP_BLOCK_TYPES.includes(b.type),
    );
  }

  /**
   * Safety net applied to every MCP tool result, whatever the transport:
   * extracts the content blocks from stringified results (bridge/local
   * pre-serialize them), strips residual base64 runs and caps the length.
   */
  private async sanitizeMcpResult(raw: string, userId: string): Promise<string> {
    let text = raw ?? '';
    try {
      const parsed = JSON.parse(text);
      const content = Array.isArray(parsed) ? parsed : parsed?.content;
      if (this.isMcpContentBlocks(content)) text = await this.renderMcpContent(content, userId);
    } catch { /* plain text — keep as is */ }
    // Residual base64 runs (inside JSON or free text) never reach the LLM.
    text = text.replace(/[A-Za-z0-9+/=]{2048,}/g, '[binary data omitted]');
    const max = McpServersService.MCP_RESULT_MAX_CHARS;
    return text.length > max
      ? `${text.slice(0, max)}… [truncated — ${text.length} chars total]`
      : text;
  }

  /**
   * Saves a base64 image from an MCP result and returns a Markdown link to it.
   *
   * The file goes FLAT into the caller's own output dir — the same per-user root
   * and layout as the skill outputs — because that is what the message pipeline
   * tracks: it resolves a `?rel=` back to `<SKILLS_OUTPUT_DIR>/<userId>/<name>`,
   * registers the file (access-aware download by id) and attaches it to the
   * assistant message. In a subdir the file exists but no chip/attachment is
   * produced, so the image is unreachable from the chat.
   */
  private async saveMcpImage(b64: string, mimeType: string | undefined, userId: string): Promise<string> {
    try {
      const ext  = (mimeType?.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const dir  = resolve(join(process.env.SKILLS_OUTPUT_DIR ?? './uploads/skills-output', userId || '_shared'));
      await fsp.mkdir(dir, { recursive: true });
      const name = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await fsp.writeFile(join(dir, name), Buffer.from(b64, 'base64'));
      return `[${name}](/api/files/raw?rel=${encodeURIComponent(name)})`;
    } catch (err: any) {
      this.logger.warn(`MCP image not saved: ${err.message}`);
      return '[image omitted]';
    }
  }

  private async callRemoteMcpTool(
    server: McpServer,
    secrets: Record<string, string>,
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<string> {
    const result = await this.httpRpc(
      server, secrets, 'tools/call',
      { name: toolName, arguments: toolArgs },
      { timeoutMs: 30_000 },
    );
    if (!result) return 'No result';

    // The MCP result is an array of content blocks: return it structured, the
    // caller sanitizes it (text extracted, images saved as per-user files —
    // the old text-only join silently dropped image blocks).
    if (Array.isArray(result.content)) {
      return JSON.stringify({ content: result.content });
    }

    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  /**
   * Converts an McpTool into a Zod schema for LangChain.
   */
  private buildZodSchema(mcpTool: McpTool): z.ZodObject<z.ZodRawShape> {
    const schema = mcpTool.inputSchema;
    if (!schema?.properties) return z.object({});

    const shape: z.ZodRawShape = {};
    const required = new Set(schema.required ?? []);

    for (const [name, param] of Object.entries(schema.properties)) {
      let field: z.ZodTypeAny;

      if (param.enum) {
        field = z.enum(param.enum as [string, ...string[]]);
      } else if (param.type === 'number' || param.type === 'integer') {
        field = z.number();
      } else if (param.type === 'boolean') {
        field = z.boolean();
      } else if (param.type === 'array') {
        field = z.array(z.unknown());
      } else if (param.type === 'object') {
        field = z.record(z.unknown());
      } else {
        field = z.string();
      }

      if (param.description) {
        field = field.describe(param.description);
      }

      shape[name] = required.has(name) ? field : field.optional();
    }

    return z.object(shape);
  }

  /**
   * Ensures the LocalMcpProcess for the specified server is started and running.
   *
   * Handles three scenarios:
   *   1. Process not yet created (first start after backend boot)
   *   2. Process in 'stopped' state with no active restart timer (permanent crash)
   *   3. Start already in progress from a concurrent request → waits on the same Promise
   *
   * @returns The process's tool list (empty if the start fails within 15s)
   */
  private async ensureLocalProcess(server: McpServer): Promise<{ name: string; description?: string; inputSchema: Record<string, unknown> }[]> {
    const existing = this.localProcesses.get(server.id);

    // Process present and working → reuse immediately
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      return existing.tools;
    }

    // Start already in progress from a concurrent request → wait without duplicating
    const inFlight = this.startingProcesses.get(server.id);
    if (inFlight) {
      await inFlight;
      return this.localProcesses.get(server.id)?.tools ?? [];
    }

    // Create (or recreate) the process
    const secrets = await this.loadSecrets(server.id);
    const env     = this.interpolateEnvRecord(server.env, secrets);

    const proc = new LocalMcpProcess(
      server.id,
      server.name,
      server.command!,
      server.args ?? [],
      env,
      this.logger,
    );

    this.localProcesses.set(server.id, proc);

    // Register the start Promise for concurrent requests
    const startPromise = proc.start()
      .catch((err: Error) => {
        this.logger.error(`[${server.name}] LocalMcpProcess start failed: ${err.message}`);
      })
      .finally(() => {
        this.startingProcesses.delete(server.id);
      });

    this.startingProcesses.set(server.id, startPromise);

    // Wait up to 15s for the process to become 'running' (or 'error')
    await this.waitForRunning(proc, 15_000);

    return proc.tools;
  }

  /** Waits for the process to reach the 'running' state within the timeout. */
  private waitForRunning(proc: LocalMcpProcess, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (proc.status === 'running') { resolve(); return; }

      const deadline = setTimeout(resolve, timeoutMs);
      const check    = setInterval(() => {
        if (proc.status === 'running' || proc.status === 'error') {
          clearInterval(check);
          clearTimeout(deadline);
          resolve();
        }
      }, 200);
    });
  }

  /** Interpolates the server's environment variables ({{secret.KEY}}, {{env.VAR}}). */
  private interpolateEnvRecord(
    envRecord: Record<string, string> | null,
    secrets:   Record<string, string>,
  ): Record<string, string> {
    if (!envRecord) return {};
    return Object.fromEntries(
      Object.entries(envRecord).map(([k, v]) => [k, this.interpolate(v, secrets)]),
    );
  }
}
