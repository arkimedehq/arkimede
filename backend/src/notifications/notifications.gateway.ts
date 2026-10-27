// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file notifications.gateway.ts
 *
 * Socket.IO WebSocket Gateway for real-time push notifications to the user.
 *
 * Namespace: /notifications
 *
 * Client → server protocol:
 *   handshake: { query: { token: '<JWT>' } }
 *
 * Server → client protocol:
 *   skill_event  { type: 'skill_event', skill: string, event_type: string, payload: any }
 *   daemon_exit  { type: 'daemon_exit', daemon_id: string, skill_id: string }
 *
 * Watching (client → server, with ack): `watch` / `unwatch` { kind, id }. A socket
 * that watches `chat:<id>` receives the events emitted to that room (e.g.
 * `chat_run`, the progress of an agent run). Whether a user may watch is decided by
 * the authorizer the owning module registers for the kind (registerWatchable), so
 * this gateway stays independent of chats, projects and their access rules.
 *
 * A user can have multiple open tabs → multiple sockets for the same userId.
 * emitToUser() sends to ALL of the user's sockets (broadcast by userId).
 */
import {
  WebSocketGateway, WebSocketServer, SubscribeMessage, MessageBody, ConnectedSocket,
  OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Namespace, Socket } from 'socket.io';

@Injectable()
@WebSocketGateway({
  namespace:  '/notifications',
  cors:       { origin: '*' },
  transports: ['websocket', 'polling'],
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  private server!: Namespace;

  private readonly logger = new Logger(NotificationsGateway.name);

  /** userId → Set<socketId> — a user can have multiple open connections */
  private readonly userSockets = new Map<string, Set<string>>();
  /** socketId → userId — for reverse lookup on disconnection */
  private readonly socketUser  = new Map<string, string>();
  /** kind → may this user watch this id (registered by the module that owns the kind) */
  private readonly watchables  = new Map<string, (userId: string, id: string) => Promise<boolean>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly cfg:        ConfigService,
  ) {}

  // ── Connection ──────────────────────────────────────────────────────────────

  async handleConnection(socket: Socket): Promise<void> {
    const token = (socket.handshake.query.token as string | undefined)
               ?? (socket.handshake.auth?.token as string | undefined);

    if (!token) {
      this.logger.warn(`[notifications] Connection without token — refused (${socket.id})`);
      socket.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.cfg.get<string>('JWT_SECRET'),
      });
      const userId = payload.sub as string;

      // Register userId → socket
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(socket.id);
      this.socketUser.set(socket.id, userId);

      this.logger.log(`[notifications] User ${userId} connected (socket ${socket.id})`);
    } catch {
      this.logger.warn(`[notifications] Invalid token — connection refused (${socket.id})`);
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket): void {
    const userId = this.socketUser.get(socket.id);
    if (userId) {
      this.userSockets.get(userId)?.delete(socket.id);
      if (this.userSockets.get(userId)?.size === 0) {
        this.userSockets.delete(userId);
      }
      this.socketUser.delete(socket.id);
      this.logger.log(`[notifications] User ${userId} disconnected (socket ${socket.id})`);
    }
  }

  // ── Watching (rooms) ───────────────────────────────────────────────────────

  @SubscribeMessage('watch')
  async handleWatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { kind?: unknown; id?: unknown },
  ): Promise<{ ok: boolean }> {
    const room = await this.authorizedRoom(socket, body);
    if (!room) return { ok: false };
    await socket.join(room);
    return { ok: true };
  }

  @SubscribeMessage('unwatch')
  async handleUnwatch(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: { kind?: unknown; id?: unknown },
  ): Promise<{ ok: boolean }> {
    if (typeof body?.kind !== 'string' || typeof body?.id !== 'string') return { ok: false };
    await socket.leave(`${body.kind}:${body.id}`);
    return { ok: true };
  }

  private async authorizedRoom(socket: Socket, body: { kind?: unknown; id?: unknown }): Promise<string | null> {
    const userId = this.socketUser.get(socket.id);
    const kind = body?.kind, id = body?.id;
    if (!userId || typeof kind !== 'string' || typeof id !== 'string' || id.length > 64) return null;
    const authorize = this.watchables.get(kind);
    if (!authorize) return null;
    try {
      return (await authorize(userId, id)) ? `${kind}:${id}` : null;
    } catch {
      return null;
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Lets sockets watch `<kind>:<id>` rooms; AUTHORIZE decides, per user and id, on
   * every watch request (it should apply the same access rules as the HTTP routes).
   */
  registerWatchable(kind: string, authorize: (userId: string, id: string) => Promise<boolean>): void {
    this.watchables.set(kind, authorize);
  }

  /** Sends an event to the sockets watching `<kind>:<id>` (silent when nobody is). */
  emitToWatchers(kind: string, id: string, event: string, data: unknown): void {
    this.server?.to(`${kind}:${id}`).emit(event, data);
  }

  /**
   * Sends an event to ALL of the user's sockets.
   * No exception if the user is not connected (silent).
   */
  emitToUser(userId: string, event: string, data: unknown): void {
    const socketIds = this.userSockets.get(userId);
    if (!socketIds || socketIds.size === 0) return;

    for (const socketId of socketIds) {
      this.server.to(socketId).emit(event, data);
    }
    this.logger.debug(
      `[notifications] emitToUser userId=${userId} event=${event} sockets=${socketIds.size}`,
    );
  }

  /** Checks whether a user has at least one active connection. */
  isUserConnected(userId: string): boolean {
    return (this.userSockets.get(userId)?.size ?? 0) > 0;
  }
}
