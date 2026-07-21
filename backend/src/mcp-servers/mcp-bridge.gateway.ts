/**
 * @file mcp-bridge.gateway.ts
 *
 * Socket.IO WebSocket Gateway for communication with the Electron bridge.
 *
 * The Electron bridge:
 *   1. Connects to the /mcp-bridge namespace
 *   2. Authenticates with JWT in the handshake (query.token)
 *   3. Sends "tools:register" with the tool list for each local server
 *   4. Listens for "tool:call" from the server
 *   5. Responds with "tool:result"
 *
 * Message protocol:
 *
 *   Bridge → Server:
 *     tools:register  { serverId, tools: McpTool[] }
 *     server:status   { serverId, status: 'running'|'stopped'|'error', error?: string }
 *
 *   Server → Bridge:
 *     config          { servers: McpServerConfig[] }   (after authentication)
 *     tool:call       { callId, serverId, toolName, args }
 *
 *   Bridge → Server (response):
 *     tool:result     { callId, result: string, error?: string }
 */
import {
  WebSocketGateway, WebSocketServer,
  SubscribeMessage, OnGatewayConnection, OnGatewayDisconnect,
  MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Logger, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Namespace, Socket } from 'socket.io';
import { McpServersService } from './mcp-servers.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { McpServer } from './mcp-server.entity';

interface PendingCall {
  resolve: (result: string) => void;
  reject:  (err: Error)    => void;
  timer:   NodeJS.Timeout;
}

@WebSocketGateway({
  namespace:  '/mcp-bridge',
  cors:       { origin: '*' },
  transports: ['websocket', 'polling'],
})
export class McpBridgeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Namespace;

  private readonly logger = new Logger(McpBridgeGateway.name);

  /** callId → callbacks for calls awaiting a response from the bridge */
  private readonly pendingCalls = new Map<string, PendingCall>();

  /** userId → socketId (one bridge per user) */
  private readonly userSockets = new Map<string, string>();

  constructor(
    @Inject(JwtService)
    private readonly jwtService:    JwtService,
    @Inject(ConfigService)
    private readonly cfg:           ConfigService,
    @Inject(McpServersService)
    private readonly mcpService:    McpServersService,
    @InjectRepository(McpServer)
    private readonly serverRepo:    Repository<McpServer>,
  ) {}

  // ── Connection / disconnection ──────────────────────────────────────────

  async handleConnection(socket: Socket) {
    const token = socket.handshake.query.token as string | undefined
                  ?? socket.handshake.auth?.token as string | undefined;

    if (!token) {
      this.logger.warn(`Bridge: connection refused — no token (socket ${socket.id})`);
      socket.disconnect(true);
      return;
    }

    let userId: string;
    try {
      const payload = this.jwtService.verify<{ sub: string }>(token, {
        secret: this.cfg.get<string>('JWT_SECRET'),
      });
      userId = payload.sub;
    } catch {
      this.logger.warn(`Bridge: invalid JWT token (socket ${socket.id})`);
      socket.disconnect(true);
      return;
    }

    // One bridge per user — disconnect any previous one
    const existingSocketId = this.userSockets.get(userId);
    if (existingSocketId && existingSocketId !== socket.id) {
      this.server.sockets.get(existingSocketId)?.disconnect(true);
    }

    socket.data.userId = userId;
    this.userSockets.set(userId, socket.id);

    // Register the bridge session in the service
    this.mcpService.bridgeSessions.set(userId, {
      callTool: (serverId, toolName, args) =>
        this.dispatchToolCall(userId, serverId, toolName, args),
    });

    this.logger.log(`Bridge connected: user ${userId} (socket ${socket.id})`);

    // Send the configuration of the enabled local servers
    await this.sendConfig(socket, userId);
  }

  handleDisconnect(socket: Socket) {
    const userId = socket.data.userId as string | undefined;
    if (!userId) return;

    if (this.userSockets.get(userId) === socket.id) {
      this.userSockets.delete(userId);
      this.mcpService.bridgeSessions.delete(userId);
      this.mcpService.bridgeTools.delete(userId);
    }

    this.logger.log(`Bridge disconnected: user ${userId} (socket ${socket.id})`);
  }

  // ── Messages from the bridge ───────────────────────────────────────────────────

  @SubscribeMessage('tools:register')
  handleToolsRegister(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { serverId: string; tools: any[] },
  ) {
    const userId = socket.data.userId as string;
    if (!userId || !data?.serverId) return;

    if (!this.mcpService.bridgeTools.has(userId)) {
      this.mcpService.bridgeTools.set(userId, new Map());
    }
    this.mcpService.bridgeTools.get(userId)!.set(data.serverId, data.tools ?? []);

    this.logger.log(
      `Bridge: user ${userId}, server ${data.serverId} → ${data.tools?.length ?? 0} tools registered`,
    );
  }

  @SubscribeMessage('server:status')
  handleServerStatus(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { serverId: string; status: string; error?: string },
  ) {
    const userId = socket.data.userId as string;
    this.logger.log(
      `Bridge status: user ${userId}, server ${data?.serverId} → ${data?.status}` +
      (data?.error ? ` (${data.error})` : ''),
    );
  }

  @SubscribeMessage('tool:result')
  handleToolResult(
    @ConnectedSocket() _socket: Socket,
    @MessageBody() data: { callId: string; result?: string; error?: string },
  ) {
    const pending = this.pendingCalls.get(data.callId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingCalls.delete(data.callId);

    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve(data.result ?? '');
    }
  }

  // ── Send config to the bridge ────────────────────────────────────────────────

  private async sendConfig(socket: Socket, userId: string): Promise<void> {
    // The bridge handles only servers with 'remote' transport
    // (stdio process on the user's machine, not the backend's)
    const servers = await this.serverRepo.find({
      where: { userId, enabled: true, transport: 'remote' as any },
    });

    const config = servers.map((s) => ({
      id:      s.id,
      name:    s.name,
      command: s.command,
      args:    s.args ?? [],
      env:     s.env ?? {},
    }));

    socket.emit('config', { servers: config });
    this.logger.log(`Bridge config sent: ${config.length} remote servers for user ${userId}`);
  }

  // ── Dispatch tool call to the bridge ────────────────────────────────────

  private dispatchToolCall(
    userId:   string,
    serverId: string,
    toolName: string,
    args:     Record<string, unknown>,
  ): Promise<string> {
    const socketId = this.userSockets.get(userId);
    if (!socketId) {
      return Promise.reject(new Error('Bridge not connected'));
    }

    return new Promise<string>((resolve, reject) => {
      const callId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error('Timeout: bridge did not respond within 30s'));
      }, 30_000);

      this.pendingCalls.set(callId, { resolve, reject, timer });

      this.server.sockets.get(socketId)?.emit('tool:call', {
        callId,
        serverId,
        tool: toolName,   // the bridge uses "tool" as the key
        args,
      });
    });
  }

  // ── Public utility ──────────────────────────────────────────────────────

  /** Sends the updated config to the user's bridge (called after server update/delete). */
  async pushConfigUpdate(userId: string): Promise<void> {
    const socketId = this.userSockets.get(userId);
    if (!socketId) return;

    const socket = this.server.sockets.get(socketId);
    if (socket) {
      await this.sendConfig(socket, userId);
    }
  }

  isBridgeConnected(userId: string): boolean {
    return this.userSockets.has(userId);
  }
}
