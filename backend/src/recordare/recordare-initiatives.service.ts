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
 * Arkimede only says how one is spoken (`speak`), on the first of the initiative's acceptable channels (in order,
 * D55 §5b) that reaches the person now:
 *   - messaging: a skill that declares a user channel (SKILL.md `user-channel`, e.g. telegram-bot, telegram-account)
 *     runs its script directly, no model in between — to the user's own account, or to the person the initiative is
 *     for at their address on that channel (`for.addresses`, kept by Recordare; passed in the script's `_config`, which
 *     a model never writes). The message is also written where the reply will continue — a contact's guest chat on
 *     that channel (guest-messages.service.ts), the chat the skill uses with the user — else in the dedicated chat,
 *     with no push (it already rang on the phone);
 *   - chat: an assistant message in the user's dedicated chat (externalSource 'recordare'), a notification and the
 *     Socket.IO push, as scheduled automations do;
 *   - voice: on the voice point in the person's room — or in the room whose presence brought it — when a voice channel
 *     is registered (`setVoice`: Home Assistant, home-assistant.service.ts); the message is written in the dedicated
 *     chat and the satellite bound to it, so the spoken reply lands there.
 * With others in the room a presence answer carries only an opening ("…, I have something for you"): it is said on the
 * room's voice point, and the initiative waits for the person's "yes" (their next turn).
 * Nothing reaching the person now: nothing reported, the initiative comes back (feed, presence). "Already handed over" is durable:
 * the notification row of that initiative. A reminder the user already scheduled in Arkimede (scheduled_tasks: same
 * conversation, or around the same time with shared words) is not delivered twice: reported `done`. Only for users
 * with the memory on (episodicMemoryEnabled). Nothing here runs on a chat's request path.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  addressesOn, type Delivered, InitiativeInbox, type Initiative, type InitiativeOutcome, type PresenceImpulse, type RecordareClient,
  type WebhookEvent,
} from '@arkimedehq/recordare-client';
import { APP_NAME } from '../config/app.config';
import { Chat } from '../chats/chats.entity';
import { Message } from '../messages/messages.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { SkillsService } from '../skills/skills.service';
import { GUEST_IDLE_MS } from '../guests/guests.constants';
import { onRecordareSettingsChange, recordareClient } from './recordare.config';

const POLL_MS = Number(process.env.RECORDARE_INITIATIVES_POLL_MS) || 15 * 60_000;
const FIRST_POLL_MS = 30_000;
/**
 * How long a question waits for an answer in its chat before it counts as ignored (Recordare D55 F4: what timing v1
 * learns from), by the channel it was asked on: a satellite listens for a reply at once; a message or the chat are read
 * later. A reminder said is not checked: silence after it is normal.
 */
export const ANSWER_WINDOW_MS: Record<string, number> = { voice: 10 * 60_000, messaging: 6 * 3_600_000, chat: 12 * 3_600_000 };
/** A presence impulse at most this often per user (tabs, reconnects). */
const PRESENCE_EVERY_MS = 10 * 60_000;
/** A scheduled task within this of the initiative's time, sharing words with it, is the same reminder. */
const SAME_TIME_MS = 2 * 3_600_000;
export const CHAT_SOURCE = 'recordare';
export const CHAT_KEY = 'initiatives';
export const EVENT_TYPE = 'recordare_initiative';

/** A voice channel (Home Assistant): says a text on a voice point and binds it to a chat, so the reply lands there. */
export interface VoiceChannel {
  /**
   * Says `text` on the voice point in `areaId`, else in the room `person` (a `homeassistant` address, `person.x`) is
   * in, and binds that point to `chatId` for the reply. The point used, or null when none reaches them now.
   */
  say(userId: string, text: string, where: { areaId?: string; person?: string }, chatId: string): Promise<string | null>;
}

/** A push channel (Home Assistant's companion app): a notification on a person's phone. */
export interface PushChannel {
  /** Sends `message` to the phone of `person` (a `homeassistant` address, `person.x`); true when sent. */
  push(person: string, message: string, title?: string): Promise<boolean>;
}

/** Who is busy now (Home Assistant: a call, do-not-disturb, a Focus on the person's phone). */
export interface BusySignal {
  /** Whether `person` (a `homeassistant` address, `person.x`) is busy now. */
  busy(person: string): boolean;
}

/** Words of at least four letters, any script, folded: enough to tell two reminders about the same thing. */
export function words(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').match(/\p{L}{4,}/gu) ?? []));
}

export function sharedWords(a: string, b: string): number {
  const wb = words(b);
  return [...words(a)].filter((w) => wb.has(w)).length;
}

/** Whether a task's text is for this person: it names them, or carries one of their addresses (a Telegram id). */
export function names(text: string, person: { name: string; addresses?: Array<{ id: string }> }): boolean {
  return sharedWords(person.name, text) >= 1 || (person.addresses ?? []).some((a) => !!a.id && text.includes(a.id));
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
  private voice: VoiceChannel | null = null;
  private pushChannel: PushChannel | null = null;
  private busySignal: BusySignal | null = null;
  /** The room a presence impulse is about, while Recordare answers it (what it gives is said there). */
  private readonly places = new Map<string, string>();

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly notifications: NotificationsService,
    private readonly gateway: NotificationsGateway,
    private readonly skills: SkillsService,
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
        channels: ['chat', 'messaging', 'voice'],
        open: (user, i, opening) => this.sayOpening(user, i, opening),
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

  /**
   * The user opened Arkimede: tell Recordare they are here (by chat); it may answer with something to say now. Busy on
   * their phone (the user's Home Assistant person), the impulse says so — else nothing is said about it.
   */
  async onPresence(userId: string, now = Date.now()): Promise<void> {
    const inbox = this.inbox();
    if (!inbox || now - (this.lastPresence.get(userId) ?? 0) < PRESENCE_EVERY_MS) return;
    this.lastPresence.set(userId, now);
    if (!(await this.enabled(userId))) return;
    try {
      const person = this.busySignal ? await this.ownPerson(userId) : null;
      const busy = !!person && !!this.busySignal?.busy(person);
      await inbox.presence(userId, { channel: 'chat', ...(busy ? { busy: true } : {}) });
    } catch (err) {
      this.logger.warn(`Recordare presence failed (user ${userId}): ${(err as Error).message}`);
    }
  }

  /** Registers (or removes) the push channel (messaging when no skill reaches the person). */
  setPush(push: PushChannel | null): void {
    this.pushChannel = push;
  }

  /** Registers (or removes) who tells whether a person is busy. */
  setBusy(signal: BusySignal | null): void {
    this.busySignal = signal;
  }

  /** Registers (or removes) the voice channel. */
  setVoice(voice: VoiceChannel | null): void {
    this.voice = voice;
  }

  /**
   * A presence impulse from the room `areaId` (Home Assistant): what Recordare answers with is said there — or only an
   * opening, with others in the room. Nothing for a user with the memory off.
   */
  async roomPresence(userId: string, impulse: PresenceImpulse, areaId?: string): Promise<void> {
    const inbox = this.inbox();
    if (!inbox || !(await this.enabled(userId))) return;
    if (areaId) this.places.set(userId, areaId);
    try {
      await inbox.presence(userId, impulse);
    } catch (err) {
      this.logger.warn(`Recordare presence failed (user ${userId}, ${impulse.channel} ${impulse.place ?? ''}): ${(err as Error).message}`);
    } finally {
      if (areaId) this.places.delete(userId);
    }
  }

  /** Lost deliveries: what Recordare pushed to the chat in the last day and Arkimede has not delivered. */
  async pollFeed(now = Date.now()): Promise<number> {
    const caught = (await this.inbox()?.catchUp(now)) ?? 0;
    await this.checkAnswers(now).catch((err: Error) => this.logger.warn(`Recordare answers not checked: ${err.message}`));
    return caught;
  }

  /**
   * Questions nobody answered (Recordare D55 F4): an `ask` delivered by voice, message or chat with no message of the
   * person in its chat within the channel's window is reported `ignored` — what timing v1 learns from (where and when a
   * person lets questions go). An answered one is only marked: its `asked` already stands. Each checked once.
   */
  async checkAnswers(now = Date.now()): Promise<number> {
    const client = this.client();
    if (!client) return 0;
    const rows: Array<{ id: string; userId: string; createdAt: Date; payload: { chatId?: string; initiativeId?: string; channel?: string } }> =
      await this.ds.query(
        `SELECT "id", "userId", "createdAt", "payload" FROM "notifications"
         WHERE "source" = $1 AND "eventType" = $2 AND "createdAt" > $3 AND "payload"->>'kind' = 'ask' AND "payload"->>'answer' IS NULL`,
        [CHAT_SOURCE, EVENT_TYPE, new Date(now - 2 * 86_400_000)]);
    let ignored = 0;
    for (const r of rows) {
      const { chatId, initiativeId, channel } = r.payload;
      if (!chatId || !initiativeId) continue;
      const [reply] = await this.ds.query(
        `SELECT 1 FROM "messages" WHERE "chatId" = $1 AND "role" = 'user' AND "createdAt" > $2 LIMIT 1`, [chatId, r.createdAt]);
      const waited = now - new Date(r.createdAt).getTime();
      if (!reply && waited < (ANSWER_WINDOW_MS[channel ?? 'chat'] ?? ANSWER_WINDOW_MS.chat)) continue;
      if (!reply) {
        await client.reportInitiative(r.userId, initiativeId, 'ignored', { channel: (channel ?? 'chat') as 'chat' | 'messaging' | 'voice' });
        ignored++;
      }
      await this.ds.query(`UPDATE "notifications" SET "payload" = "payload" || $2::jsonb WHERE "id" = $1`,
        [r.id, JSON.stringify({ answer: reply ? 'answered' : 'ignored' })]);
    }
    return ignored;
  }

  /**
   * Speaks one initiative in Arkimede (the inbox calls it once per initiative, say / ask only) on the first acceptable
   * channel that reaches the person: the outcome with that channel, `done` for a reminder the user already scheduled,
   * null (nothing reported, it comes back) for a user with the memory off or when no channel reaches the person now.
   */
  async speak(userId: string, i: Initiative): Promise<Delivered | InitiativeOutcome | null> {
    if (!(await this.enabled(userId))) return null;
    if (await this.alreadyScheduled(userId, i)) return 'done';
    const outcome: InitiativeOutcome = i.kind === 'ask' ? 'asked' : 'said';
    for (const channel of i.channels?.length ? i.channels : ['chat' as const]) {
      if (channel === 'messaging') {
        const chatId = await this.sendMessage(userId, i);
        if (chatId === false) continue;
        await this.record(userId, i, chatId ?? await this.dedicatedChat(userId), false, channel);
        return { outcome, channel };
      }
      if (channel === 'chat') {
        await this.record(userId, i, await this.dedicatedChat(userId), true, channel);
        return { outcome, channel };
      }
      if (channel === 'voice') {
        const said = await this.sayByVoice(userId, i);
        if (!said) continue;
        return { outcome, channel };
      }
      // a turn is the memory context's.
    }
    return null;
  }

  /**
   * Messaging through a skill's user channel: to the person the initiative is for at their address on that channel,
   * or to the user's own account. The Arkimede chat the skill uses with them (when it says), null when it does not,
   * false when no channel reached them.
   */
  async sendMessage(userId: string, i: Initiative): Promise<string | null | false> {
    for (const ch of await this.skills.userChannels(userId)) {
      const address = i.for ? addressesOn(i, ch.channel)[0] : undefined;
      if (i.for ? !address || !ch.reaches.includes('contacts') : !ch.reaches.includes('self')) continue;
      try {
        const res = await this.skills.invoke(ch.skillId, ch.script, { text: i.text.trim() }, 30_000, userId,
          address ? { DELIVERY_ADDRESS: address } : undefined);
        const out = res.output as { success?: boolean; arkimede_chat?: unknown; error?: string } | null;
        if (!res.success || !out?.success) {
          this.logger.warn(`Recordare initiative ${i.id} not sent by ${ch.skillName}: ${out?.error ?? res.stderr ?? 'no answer'}`);
          continue;
        }
        if (typeof out.arkimede_chat === 'string') return await this.ownChat(userId, out.arkimede_chat);
        // A contact: their guest chat on this channel, where their reply will arrive.
        return address && i.for ? await this.guestChat(userId, ch.channel, address, i.for.name) : null;
      } catch (err) {
        this.logger.warn(`Recordare initiative ${i.id} not sent by ${ch.skillName}: ${(err as Error).message}`);
      }
    }
    // No skill reached them: a push on their phone (Home Assistant's companion app), recorded in the dedicated chat.
    const person = this.pushChannel ? (i.for ? addressesOn(i, 'homeassistant')[0] : await this.ownPerson(userId)) : null;
    if (person && this.pushChannel) {
      try {
        if (await this.pushChannel.push(person, i.text.trim(), `💭 ${APP_NAME}`)) return null;
      } catch (err) {
        this.logger.warn(`Recordare initiative ${i.id} not pushed: ${(err as Error).message}`);
      }
    }
    return false;
  }

  /** The user's own Home Assistant person (users.haPerson), if linked. */
  private async ownPerson(userId: string): Promise<string | null> {
    const [u] = await this.ds.query(`SELECT "haPerson" FROM "users" WHERE "id" = $1`, [userId]) as Array<{ haPerson: string | null }>;
    return u?.haPerson ?? null;
  }

  /** By voice, where the person is (or in the room whose presence brought it): the message is in the chat too. */
  private async sayByVoice(userId: string, i: Initiative): Promise<boolean> {
    if (!this.voice) return false;
    const where = { areaId: this.places.get(userId), person: i.for ? addressesOn(i, 'homeassistant')[0] : undefined };
    if (!where.areaId && !where.person) return false;
    const chatId = await this.dedicatedChat(userId);
    const point = await this.voice.say(userId, i.text.trim(), where, chatId).catch((err: Error) => {
      this.logger.warn(`Recordare initiative ${i.id} not said by voice: ${err.message}`);
      return null;
    });
    if (!point) return false;
    await this.record(userId, i, chatId, false, 'voice');
    return true;
  }

  /** Others are in the room: only the opening, there; the initiative waits for the person's "yes". */
  private async sayOpening(userId: string, i: Initiative, opening: string): Promise<void> {
    const areaId = this.places.get(userId);
    if (!this.voice || !areaId) return;
    await this.voice.say(userId, opening, { areaId }, await this.dedicatedChat(userId));
  }

  /** Writes the delivered initiative in a chat of the user, with its notification (the durable "delivered" record). */
  private async record(userId: string, i: Initiative, chatId: string, push: boolean, channel: 'chat' | 'messaging' | 'voice'): Promise<void> {
    const content = i.text.trim();
    await this.ds.getRepository(Message).save(this.ds.getRepository(Message).create({ chatId, role: 'assistant', content }));
    await this.ds.getRepository(Chat).update(chatId, { unread: true, updatedAt: new Date() });
    const title = `💭 ${APP_NAME}`;
    // The kind and the channel: a question's answer is looked for in this chat (checkAnswers).
    const payload = { title, message: content.length > 160 ? `${content.slice(0, 160)}…` : content, chatId, initiativeId: i.id, kind: i.kind, channel };
    const notif = await this.notifications.create({ userId, source: CHAT_SOURCE, sourceId: i.id, eventType: EVENT_TYPE, payload });
    if (push) this.gateway.emitToUser(userId, 'notification', { id: notif.id, eventType: EVENT_TYPE, ...payload });
  }

  /** The guest chat of a contact on a channel (as guest-messages.service.ts keys it): the open one, else a new one. */
  private async guestChat(userId: string, channel: string, externalId: string, name: string): Promise<string> {
    const repo = this.ds.getRepository(Chat);
    const open = await repo.findOne({
      where: { userId, externalSource: channel, externalKey: externalId.slice(0, 200) }, order: { updatedAt: 'DESC' }, select: { id: true, updatedAt: true },
    });
    if (open && Date.now() - new Date(open.updatedAt).getTime() < GUEST_IDLE_MS) return open.id;
    const chat = await repo.save(repo.create({ userId, title: `${name} · ${channel}`, externalSource: channel, externalKey: externalId.slice(0, 200) }));
    return chat.id;
  }

  /** A chat id a skill reported, if it is this user's (null otherwise). */
  private async ownChat(userId: string, chatId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(chatId)) return null;
    const found = await this.ds.getRepository(Chat).findOne({ where: { id: chatId, userId }, select: { id: true } });
    return found?.id ?? null;
  }

  /**
   * A reminder the user already scheduled in Arkimede (Recordare does its own work whatever the host's tools did; the
   * host deduplicates, and the explicit, confirmed task is the source of truth — its time wins): a one-shot task
   * created in the conversation the initiative came from with a word in common, or due within two hours of it with two
   * words in common — still to run, or run within two hours of the initiative's time (never said twice). It covers the
   * initiative only for the same person: one for a contact needs a task that names them (or carries one of their
   * addresses). A task that failed or was deleted covers nothing: the memory's initiative is the safety net.
   */
  async alreadyScheduled(userId: string, i: Initiative): Promise<boolean> {
    if (i.kind !== 'say') return false;
    const tasks: Array<{ id: string; chatId: string | null; runAt: Date | null; title: string | null; instruction: string; status: string; lastRunAt: Date | null }> =
      await this.ds.query(
        `SELECT "id", "chatId", "runAt", "title", "instruction", "status", "lastRunAt" FROM "scheduled_tasks"
         WHERE "userId" = $1 AND "scheduleType" = 'scheduled' AND "status" IN ('pending', 'active', 'done')`, [userId]);
    const due = Date.parse(i.dueAt);
    const near = (at: Date | null) => !!at && Math.abs(new Date(at).getTime() - due) <= SAME_TIME_MS;
    // Why each candidate (a task near the time or from the same chat) did not cover it: logged, so a reminder said twice
    // can be explained afterwards (Kinox 2026-11-06: the tasks were gone by the next day, the cause could not be told).
    const rejected: string[] = [];
    const cover = tasks.find((t) => {
      const sameChat = !!i.source && t.chatId === i.source.conversation;
      if (!sameChat && !near(t.runAt)) return false;
      const text = `${t.title ?? ''} ${t.instruction}`;
      const why = t.status === 'done' && !near(t.lastRunAt) ? 'already run long before'
        : i.for && !names(text, i.for) ? `does not name ${i.for.name}`
        : (sameChat && sharedWords(i.text, text) >= 1) || (near(t.runAt) && sharedWords(i.text, text) >= 2) ? null
        : 'too few words in common';
      if (why) rejected.push(`${t.id} (${t.status}): ${why}`);
      return !why;
    });
    if (cover) this.logger.log(`initiative ${i.id}: covered by task ${cover.id} (${cover.status}), reported done`);
    else if (rejected.length) this.logger.log(`initiative ${i.id}: not covered — ${rejected.join('; ')}`);
    else this.logger.debug(`initiative ${i.id}: no task near its time (${tasks.length} scheduled)`);
    return !!cover;
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
