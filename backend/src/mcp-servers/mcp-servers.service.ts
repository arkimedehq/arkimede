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
import {Repository} from 'typeorm';
import {DynamicStructuredTool} from '@langchain/core/tools';
import {z} from 'zod';
import {McpServer} from './mcp-server.entity';
import {McpServerSecret} from './mcp-server-secret.entity';
import {decrypt, encrypt} from '../custom-tools/crypto.utils';
import {safeFetch} from '../common/ssrf-guard';
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
    private readonly audit: AuditService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.logger.log(`Stopping ${this.localProcesses.size} local MCP processes...`);
    const stops = Array.from(this.localProcesses.values()).map((p) => p.stop());
    await Promise.allSettled(stops);
    this.localProcesses.clear();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(userId: string, dto: CreateMcpServerDto, isAdmin = false): Promise<McpServer> {
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

  async findAll(userId: string): Promise<McpServer[]> {
    return this.serverRepo.find({
      where: { userId },
      relations: { secrets: true },
      order: { createdAt: 'DESC' },
      select: {
        id: true, name: true, description: true,
        transport: true, url: true, command: true, args: true,
        headers: true, env: true, enabled: true, loadOnFirst: true, userId: true,
        createdAt: true, updatedAt: true,
        secrets: { id: true, serverId: true, keyName: true },
      },
    });
  }

  async findOne(id: string, userId: string): Promise<McpServer> {
    const server = await this.serverRepo.findOne({
      where: { id, userId },
      relations: { secrets: true },
      select: {
        id: true, name: true, description: true,
        transport: true, url: true, command: true, args: true,
        headers: true, env: true, enabled: true, loadOnFirst: true, userId: true,
        createdAt: true, updatedAt: true,
        secrets: { id: true, serverId: true, keyName: true },
      },
    });
    if (!server) throw new NotFoundException(`MCP server "${id}" not found`);
    return server;
  }

  async update(id: string, userId: string, dto: UpdateMcpServerDto, isAdmin = false): Promise<McpServer> {
    const server = await this.findOne(id, userId);
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

  async remove(id: string, userId: string): Promise<void> {
    const server = await this.findOne(id, userId);
    // Stop the local process if present
    const localProc = this.localProcesses.get(id);
    if (localProc) {
      await localProc.stop();
      this.localProcesses.delete(id);
    }
    this.startingProcesses.delete(id);
    await this.serverRepo.remove(server);
    this.logger.log(`MCP server deleted: "${server.name}" (user: ${userId})`);
    await this.audit.record({
      actorId: userId, action: 'mcp.delete', resource: server.name,
      outcome: 'ok', ctx: { serverId: id, transport: server.transport },
    });
  }

  // ── Secrets ───────────────────────────────────────────────────────────────

  async upsertSecrets(serverId: string, secrets: Record<string, string>): Promise<void> {
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

  async getSecretKeys(serverId: string, userId: string): Promise<string[]> {
    await this.findOne(serverId, userId);
    const secrets = await this.secretRepo.find({ where: { serverId } });
    return secrets.map((s) => s.keyName);
  }

  async removeSecret(serverId: string, keyName: string, userId: string): Promise<void> {
    await this.findOne(serverId, userId);
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
    const servers = await this.serverRepo.find({
      where: opts.flatOnly ? { userId, enabled: true, loadOnFirst: true } : { userId, enabled: true },
    });

    if (servers.length === 0) return [];

    const allTools: DynamicStructuredTool[] = [];

    for (const server of servers) {
      try {
        const serverSlug = server.name.toLowerCase().replace(/\W+/g, '_');

        // ── http / sse ────────────────────────────────────────────────────
        if (server.transport === 'http' || server.transport === 'sse') {
          const secrets  = await this.loadSecrets(server.id);
          const mcpTools = await this.fetchMcpTools(server, secrets);

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

          this.logger.log(`MCP server "${server.name}" (${server.transport}): ${mcpTools.length} tools loaded`);

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
    }

    return allTools;
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
   * Calls the remote MCP server (http/sse) to get the tool list.
   * Runs: initialize → tools/list according to the MCP protocol.
   */
  private async fetchMcpTools(server: McpServer, secrets: Record<string, string>): Promise<McpTool[]> {
    const url = this.interpolate(server.url!, secrets);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.interpolateHeaders(server.headers, secrets),
    };

    // MCP initialize (safeFetch: anti-SSRF on the URL and every redirect hop)
    const initResp = await safeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          clientInfo: { name: process.env.APP_NAME ?? 'arkimede', version: '1.0.0' },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!initResp.ok) {
      throw new Error(`MCP initialize failed: ${initResp.status} ${initResp.statusText}`);
    }

    // MCP tools/list
    const listResp = await safeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!listResp.ok) {
      throw new Error(`MCP tools/list failed: ${listResp.status} ${listResp.statusText}`);
    }

    const contentType = listResp.headers.get('content-type') ?? '';
    let listData: any;

    if (contentType.includes('text/event-stream')) {
      // SSE: read the first "data:" event with the JSON-RPC response
      const text = await listResp.text();
      const match = text.match(/data:\s*(\{.*\})/);
      if (!match) throw new Error('SSE: no data event found in the tools/list response');
      listData = JSON.parse(match[1]);
    } else {
      listData = await listResp.json();
    }

    const result: McpToolsListResult = listData.result ?? listData;
    return result.tools ?? [];
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
    const url = this.interpolate(server.url!, secrets);
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.interpolateHeaders(server.headers, secrets),
    };

    // safeFetch: anti-SSRF on the URL and every redirect hop.
    const resp = await safeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      return `HTTP error ${resp.status} ${resp.statusText}`;
    }

    const contentType = resp.headers.get('content-type') ?? '';
    let data: any;

    if (contentType.includes('text/event-stream')) {
      const text = await resp.text();
      const match = text.match(/data:\s*(\{.*\})/);
      if (!match) return 'SSE: no response received';
      data = JSON.parse(match[1]);
    } else {
      data = await resp.json();
    }

    if (data.error) {
      return `MCP error: ${JSON.stringify(data.error)}`;
    }

    const result = data.result;
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
