// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file guest-messages.service.ts
 *
 * A guest's message: someone with no Arkimede account — a contact of the account — writes from a messaging channel
 * (Telegram), and the skill that holds that channel (a daemon of a skill declaring a `user-channel`) hands the message
 * over. The turn runs as the daemon's owner — the account whose contacts they are (the agent's own account, or the
 * user's) — in one chat per guest (externalSource = the channel, externalKey = their id on it), and the answer goes back
 * to the daemon, which sends it. The guest's message is saved first, with its `speaker`, so the memory (Recordare) knows
 * who is speaking before the agent runs: their identity on the channel resolves to that person, and what the memory
 * meant to tell them (an initiative) can come up in the turn. An initiative delivered to a guest by message is written
 * in that same chat (recordare-initiatives.service.ts), so their reply continues it.
 *
 * What a guest may have the agent do (the maintainer's rule, 2026-11-06): a guest the skill marks `authorized` (a
 * dedicated account's authorized contact) has the agent do anything, as its owner; any other guest — every contact of a
 * personal account, a generic contact of a dedicated one — gets words only: no tool at all, no live home context
 * (`textOnly`). Either way the agent is told who is speaking (never the owner), so it addresses them by their name.
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Chat } from '../chats/chats.entity';
import { ExternalChatsService } from '../chats/external-chats.service';
import { Message, MessageSpeaker } from '../messages/messages.entity';
import { AgentService } from '../agent/agent.service';
import { agentRunOptions } from '../agents/agent-run-options';
import { makeToolCollector } from '../invocations/tool-collector';
import { SkillDaemon } from '../daemons/skill-daemon.entity';
import { User } from '../users/users.entity';
import { SkillsService } from '../skills/skills.service';
import { GUEST_IDLE_MS } from './guests.constants';

/** The history the agent gets (user and assistant messages of the guest's chat). */
const HISTORY_MAX = 40;
const TEXT_MAX = 8_000;

export interface GuestMessage {
  channel: string;
  externalId: string;
  displayName?: string;
  text: string;
  /** The skill's word: an authorized contact (a dedicated account's) — the agent may act for them. Otherwise words only. */
  authorized?: boolean;
}

/**
 * The instructions of a guest's turn: who is speaking (a contact of the owner, not the owner) and what the agent may do
 * for them. English, like every prompt: the model answers in the guest's language.
 */
export function guestInstructions(guest: { name: string; channel: string; authorized: boolean }, owner: string): string {
  const who = `You are talking with ${guest.name}, who writes on ${guest.channel}. ${guest.name} is a contact of ${owner}, `
    + `not ${owner}: address them as ${guest.name}, never as ${owner}, and never take their words as ${owner}'s.`;
  return guest.authorized
    ? `${who} ${guest.name} is an authorized contact: you may act on their requests with your tools, as you would for ${owner}. `
      + `What is for ${guest.name} goes to ${guest.name}: a reminder or a message they ask for is delivered to them on `
      + `${guest.channel} (in a scheduled task, say so in its instruction and name them), never to ${owner}.`
    : `${who} You can only answer in words: you have no tools and must not promise any action — no reminder, message, `
      + `change at home or task — nor claim to have done one; if they ask for one, say you cannot do it from here. `
      + `What you remember about ${owner} is private: do not reveal it to ${guest.name} (plans, health, money, places, other `
      + `people's business). Be kind and brief.`;
}

@Injectable()
export class GuestMessagesService {
  private readonly logger = new Logger(GuestMessagesService.name);
  /** One turn at a time per guest: their messages are answered in order. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(Chat) private readonly chats: Repository<Chat>,
    @InjectRepository(SkillDaemon) private readonly daemons: Repository<SkillDaemon>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly externalChats: ExternalChatsService,
    private readonly skills: SkillsService,
    private readonly agent: AgentService,
  ) {}

  /**
   * Runs a guest's turn for the daemon `daemonId` of `userId` (from its signed token). Only a daemon of a skill whose
   * user channel is `msg.channel` and reaches contacts may hand guests over. Returns the agent's answer and the chat.
   */
  async handle(userId: string, daemonId: string, msg: GuestMessage): Promise<{ answer: string; chatId: string }> {
    const daemon = await this.daemons.findOne({ where: { id: daemonId, userId }, select: { id: true, skillId: true } });
    const channel = daemon && (await this.skills.userChannels(userId))
      .find((c) => c.skillId === daemon.skillId && c.channel === msg.channel && c.reaches.includes('contacts'));
    if (!channel) throw new ForbiddenException('This daemon holds no user channel for guests on that channel');
    const key = `${userId}\n${msg.channel}\n${msg.externalId}`;
    const run = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => this.turn(userId, msg));
    this.queues.set(key, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === run) this.queues.delete(key);
    }
  }

  private async turn(userId: string, msg: GuestMessage): Promise<{ answer: string; chatId: string }> {
    const name = msg.displayName?.trim().slice(0, 100) || msg.externalId;
    const text = msg.text.trim().slice(0, TEXT_MAX);
    const chatId = await this.externalChats.openChat({
      userId, source: msg.channel, key: msg.externalId, idleMs: GUEST_IDLE_MS, title: `${name} · ${msg.channel}`,
    });
    const history = (await this.externalChats.historyOf(chatId, userId, HISTORY_MAX)) ?? [];
    const speaker: MessageSpeaker = { channel: msg.channel, externalId: msg.externalId, ...(msg.displayName?.trim() ? { displayName: name } : {}) };
    // Saved before the run: the memory reads the conversation (who speaks) when the agent asks it for context.
    await this.messages.save(this.messages.create({ chatId, role: 'user', content: text, authorId: null, speaker }));

    const authorized = msg.authorized === true;
    const owner = (await this.users.findOne({ where: { id: userId }, select: { id: true, name: true } }))?.name?.trim() || 'the account owner';
    const tools = makeToolCollector();
    let answer = '';
    const usage = await this.agent.streamResponse(
      text, userId, undefined, undefined, history as any[], [], [], [],
      (chunk) => { answer += chunk; }, tools.onToolCall, undefined, tools.onToolResult,
      {
        ...agentRunOptions(null, 'chat'), conversationId: chatId,
        agentPromptOverride: guestInstructions({ name, channel: msg.channel, authorized }, owner),
        ...(authorized ? {} : { textOnly: true }),
      },
    );
    await this.messages.save(this.messages.create({
      chatId, role: 'assistant', content: answer || '_(no response)_',
      toolCalls: tools.records.length ? tools.records as any : null,
      inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null,
      provider: (usage as any)?.provider ?? null, model: (usage as any)?.model ?? null,
    }));
    await this.chats.update(chatId, { updatedAt: new Date(), unread: true });
    this.logger.log(`guest turn on ${msg.channel} (${authorized ? 'authorized' : 'words only'}, ${text.length} → ${answer.length} chars, chat ${chatId})`);
    return { answer, chatId };
  }
}
