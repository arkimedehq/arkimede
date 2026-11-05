// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-initiatives.service.ts
 *
 * What the user's memory decided to say on its own (Recordare D55: initiatives), delivered in Arkimede. Recordare
 * decides who, when and on which channel; Arkimede is the body that speaks. The client library's `InitiativeInbox`
 * does the receiving — each initiative handed over once, the outcome reported (channel chat), failures logged — from:
 *   - `initiative.deliver` (webhook, verified by RecordareWebhookController) → delivered now;
 *   - a presence impulse when the user opens Arkimede (first socket of the user, at most every ten minutes) → Recordare
 *     may answer with something to say now (a flexible initiative waiting for its moment);
 *   - the feed, read every RECORDARE_INITIATIVES_POLL_MS (default 15 min) and soon after start-up, catching up on lost
 *     deliveries (pushed to the chat in the last day, not delivered yet).
 * Arkimede only says how one is spoken (`speak`): an assistant message in the user's dedicated chat (externalSource
 * 'recordare'), a notification and the Socket.IO push, as scheduled automations do. "Already handed over" is durable:
 * the notification row of that initiative. A reminder the user already scheduled in Arkimede (scheduled_tasks: same
 * conversation, or around the same time with shared words) is not delivered twice: reported `done`. Only for users
 * with the memory on (episodicMemoryEnabled). Nothing here runs on a chat's request path.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InitiativeInbox, type Initiative, type InitiativeOutcome, type RecordareClient, type WebhookEvent } from '@arkimedehq/recordare-client';
import { APP_NAME } from '../config/app.config';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { onRecordareSettingsChange, recordareClient } from './recordare.config';

const POLL_MS = Number(process.env.RECORDARE_INITIATIVES_POLL_MS) || 15 * 60_000;
const FIRST_POLL_MS = 30_000;
/** A presence impulse at most this often per user (tabs, reconnects). */
const PRESENCE_EVERY_MS = 10 * 60_000;
/** A scheduled task within this of the initiative's time, sharing words with it, is the same reminder. */
const SAME_TIME_MS = 2 * 3_600_000;
export const CHAT_SOURCE = 'recordare';
export const CHAT_KEY = 'initiatives';
export const EVENT_TYPE = 'recordare_initiative';

/** Words of at least four letters, any script, folded: enough to tell two reminders about the same thing. */
export function words(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').match(/\p{L}{4,}/gu) ?? []));
}

export function sharedWords(a: string, b: string): number {
  const wb = words(b);
  return [...words(a)].filter((w) => wb.has(w)).length;
}

@Injectable()
export class RecordareInitiativesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordareInitiativesService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopListening: (() => void) | null = null;
  private stopSettings: (() => void) | null = null;
  private readonly lastPresence = new Map<string, number>();
  /** The feed cursor per user, kept across inboxes (a new client after a settings change reads on from there). */
  private readonly cursors = new Map<string, number>();
  private current: { client: RecordareClient; inbox: InitiativeInbox } | null = null;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
    private readonly gateway: NotificationsGateway,
  ) {}

  /** The client (null when Recordare is off); tests set one of their own. */
  client: () => RecordareClient | null = recordareClient;

  /** Starts listening when Recordare is configured — at start-up or later, from the admin's settings. */
  onModuleInit(): void {
    this.start();
    this.stopSettings = onRecordareSettingsChange(() => this.start());
  }

  private start(): void {
    if (this.timer || !this.client()) return;
    this.stopListening = this.gateway.onUserConnected((userId) => void this.onPresence(userId));
    const first = setTimeout(() => void this.pollFeed(), FIRST_POLL_MS);
    first.unref?.();
    this.timer = setInterval(() => void this.pollFeed(), POLL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopSettings?.();
    this.stopListening?.();
    if (this.timer) clearInterval(this.timer);
  }

  /** The inbox for the current client (a new one when the admin's settings change the client); null when off. */
  private inbox(): InitiativeInbox | null {
    const client = this.client();
    if (!client) return null;
    if (this.current?.client !== client) {
      const inbox = new InitiativeInbox({
        client,
        deliver: (user, i) => this.speak(user, i),
        users: async () => (await this.ds.query(
          `SELECT "id" FROM "users" WHERE "episodicMemoryEnabled" = true AND "recordareMemoryId" IS NOT NULL`) as Array<{ id: string }>).map((u) => u.id),
        channels: ['chat'],
        channel: 'chat',
        seen: { has: (id) => this.notified(id), add: () => {} }, // the notification written by speak() is the record
        cursors: { get: (u) => this.cursors.get(u), set: (u, s) => { this.cursors.set(u, s); } },
        log: (m) => this.logger.warn(`Recordare ${m}`),
      });
      this.current = { client, inbox };
    }
    return this.current.inbox;
  }

  /** A verified webhook event: `initiative.deliver` is delivered now; the other events are information. True when delivered. */
  async handleEvent(event: WebhookEvent): Promise<boolean> {
    return (await this.inbox()?.receive(event)) ?? false;
  }

  /** The user opened Arkimede: tell Recordare they are here (by chat); it may answer with something to say now. */
  async onPresence(userId: string, now = Date.now()): Promise<void> {
    const inbox = this.inbox();
    if (!inbox || now - (this.lastPresence.get(userId) ?? 0) < PRESENCE_EVERY_MS) return;
    this.lastPresence.set(userId, now);
    if (!(await this.enabled(userId))) return;
    try {
      await inbox.presence(userId, { channel: 'chat' });
    } catch (err) {
      this.logger.warn(`Recordare presence failed (user ${userId}): ${(err as Error).message}`);
    }
  }

  /** Lost deliveries: what Recordare pushed to the chat in the last day and Arkimede has not delivered. */
  async pollFeed(now = Date.now()): Promise<number> {
    return (await this.inbox()?.catchUp(now)) ?? 0;
  }

  /**
   * Speaks one initiative in Arkimede (the inbox calls it once per initiative, say / ask only): the outcome to report,
   * `done` for a reminder the user already scheduled, null (nothing reported) for a user with the memory off.
   */
  async speak(userId: string, i: Initiative): Promise<InitiativeOutcome | null> {
    if (!(await this.enabled(userId))) return null;
    if (await this.alreadyScheduled(userId, i)) return 'done';
    const chatId = await this.dedicatedChat(userId);
    const content = i.text.trim();
    await this.ds.getRepository(Message).save(this.ds.getRepository(Message).create({ chatId, role: 'assistant', content }));
    await this.ds.getRepository(Chat).update(chatId, { unread: true, updatedAt: new Date() });
    const title = `💭 ${APP_NAME}`;
    const payload = { title, message: content.length > 160 ? `${content.slice(0, 160)}…` : content, chatId, initiativeId: i.id };
    const notif = await this.notifications.create({ userId, source: CHAT_SOURCE, sourceId: i.id, eventType: EVENT_TYPE, payload });
    this.gateway.emitToUser(userId, 'notification', { id: notif.id, eventType: EVENT_TYPE, ...payload });
    return i.kind === 'ask' ? 'asked' : 'said';
  }

  /**
   * A reminder the user already scheduled in Arkimede (Recordare does its own work whatever the host's tools did; the
   * host deduplicates): an active one-shot task created in the conversation the initiative came from with a word in
   * common, or due within two hours of it with two words in common.
   */
  async alreadyScheduled(userId: string, i: Initiative): Promise<boolean> {
    if (i.kind !== 'say') return false;
    const tasks: Array<{ chatId: string | null; runAt: Date | null; title: string | null; instruction: string }> = await this.ds.query(
      `SELECT "chatId", "runAt", "title", "instruction" FROM "scheduled_tasks"
       WHERE "userId" = $1 AND "scheduleType" = 'scheduled' AND "status" IN ('pending', 'active')`, [userId]);
    const due = Date.parse(i.dueAt);
    return tasks.some((t) => {
      const text = `${t.title ?? ''} ${t.instruction}`;
      const sameChat = !!i.source && t.chatId === i.source.conversation;
      const sameTime = !!t.runAt && Math.abs(new Date(t.runAt).getTime() - due) <= SAME_TIME_MS;
      return (sameChat && sharedWords(i.text, text) >= 1) || (sameTime && sharedWords(i.text, text) >= 2);
    });
  }

  private async dedicatedChat(userId: string): Promise<string> {
    const repo = this.ds.getRepository(Chat);
    const found = await repo.findOne({ where: { userId, externalSource: CHAT_SOURCE, externalKey: CHAT_KEY }, select: { id: true } });
    if (found) return found.id;
    const chat = await repo.save(repo.create({ userId, title: `💭 ${APP_NAME}`, unread: true, externalSource: CHAT_SOURCE, externalKey: CHAT_KEY }));
    return chat.id;
  }

  private async enabled(userId: string): Promise<boolean> {
    const [u] = await this.ds.query(`SELECT 1 FROM "users" WHERE "id" = $1 AND "episodicMemoryEnabled" = true`, [userId]);
    return !!u;
  }

  /** Whether this initiative was already delivered (its notification exists). */
  private async notified(initiativeId: string): Promise<boolean> {
    const [row] = await this.ds.query(
      `SELECT 1 FROM "notifications" WHERE "source" = $1 AND "sourceId" = $2 LIMIT 1`, [CHAT_SOURCE, initiativeId]);
    return !!row;
  }
}
