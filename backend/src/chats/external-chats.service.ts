// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file external-chats.service.ts
 *
 * Opt-in persistence of conversations run by external entry points (the
 * OpenAI-compatible endpoint, the Wyoming conversation agent). Those entry
 * points stay stateless for the agent run — the context still comes from the
 * client or the entry point's own window — and, when persistence is enabled,
 * record each completed turn here as a normal chat of the acting user.
 *
 * Grouping: each entry point passes a conversation key and an idle window; the
 * turn is appended to the latest chat with that key unless it went idle or (for
 * entry points without a conversation id) the client's history no longer
 * matches it — see external-chats.util.ts.
 *
 * Focus (conversation-focus.service.ts): a turn of a focused satellite is
 * appended to the focused chat instead, and the entry point runs it with that
 * chat's history (historyOf) — the one case where a chat is read back.
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Chat } from './chats.entity';
import { Message, ToolCallRecord } from '../messages/messages.entity';
import { truncateToolValue } from '../invocations/invocations.service';
import { isCoherentContinuation, isWithinIdleWindow } from './external-chats.util';

/** Same per-value cap as the in-app chat flow (messages.controller.ts). */
const MAX_TOOL_VALUE = 8 * 1024;

/** Title length derived from the first user message (same as the in-app flow). */
const TITLE_MAX = 60;

export type ExternalChatSource = 'wyoming' | 'api';

export interface ExternalTurn {
  userId: string;
  source: ExternalChatSource;
  /** Conversation key inside the source. */
  key: string;
  /** A chat idle for longer than this is closed: the next turn opens a new one. */
  idleMs: number;
  /** The satellite the turn came from (kept on a new chat so a list can show it). */
  satellite?: string | null;
  /** Focused chat of the satellite: the turn is appended there, no grouping. */
  chatId?: string | null;
  /** Epoch ms: a chat last active before this is never continued (a focus ended since). */
  notBefore?: number | null;
  /**
   * User messages of the history the client resent with this turn, oldest first.
   * Omit when the key already identifies the conversation (no coherence check).
   */
  priorUserTexts?: string[];
  userText: string;
  answer: string;
  /** Tool events collected during the run (tool-collector.ts records). */
  toolCalls?: (Omit<ToolCallRecord, 'input'> & { input?: any })[];
  usage?: {
    inputTokens?: number; outputTokens?: number;
    cacheReadTokens?: number; cacheWriteTokens?: number;
    provider?: string; model?: string;
  } | null;
}

@Injectable()
export class ExternalChatsService {
  constructor(
    @InjectRepository(Chat) private readonly chatRepo: Repository<Chat>,
    @InjectRepository(Message) private readonly messageRepo: Repository<Message>,
  ) {}

  /** Records a completed turn; returns the chat it was appended to. */
  async recordTurn(input: ExternalTurn): Promise<string> {
    const turn = { ...input, key: input.key.slice(0, 200) };   // column width
    const chatId = (await this.focusedChat(turn)) ?? (await this.findOpenChat(turn)) ?? (await this.createChat(turn));

    // createdAt stays the DB default (as in the in-app flow): insertion order is the
    // chat order, and app-written and DB-written timestamps are not comparable.
    await this.messageRepo.save(this.messageRepo.create({
      chatId, role: 'user', content: turn.userText, authorId: turn.userId,
    }));
    const toolCalls: ToolCallRecord[] = (turn.toolCalls ?? []).map((r) => ({
      ...r, input: truncateToolValue(r.input ?? null, MAX_TOOL_VALUE), output: truncateToolValue(r.output, MAX_TOOL_VALUE),
    }));
    await this.messageRepo.save(this.messageRepo.create({
      chatId,
      role: 'assistant',
      content: turn.answer || '_(no response)_',
      toolCalls: toolCalls.length ? toolCalls : null,
      inputTokens:      turn.usage?.inputTokens      ?? null,
      outputTokens:     turn.usage?.outputTokens     ?? null,
      cacheReadTokens:  turn.usage?.cacheReadTokens  ?? null,
      cacheWriteTokens: turn.usage?.cacheWriteTokens ?? null,
      provider: turn.usage?.provider ?? null,
      model:    turn.usage?.model    ?? null,
    }));
    // New content the user has not seen yet → sidebar "unread" badge.
    await this.chatRepo.update(chatId, { updatedAt: new Date(), unread: true });
    return chatId;
  }

  /**
   * The last `max` user/assistant messages of a chat of the user, oldest first, as
   * agent history; null when the chat does not exist or is not the user's.
   */
  async historyOf(chatId: string, userId: string, max: number): Promise<{ role: 'user' | 'assistant'; content: string }[] | null> {
    const chat = await this.chatRepo.findOne({ where: { id: chatId, userId }, select: { id: true } });
    if (!chat) return null;
    const rows = await this.messageRepo.find({
      where: { chatId }, order: { createdAt: 'DESC' }, take: max, select: { role: true, content: true },
    });
    return rows.reverse()
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content ?? '' }));
  }

  /** The focused chat, if it still exists and is the user's; an empty one takes its title from the turn. */
  private async focusedChat(turn: ExternalTurn): Promise<string | null> {
    if (!turn.chatId) return null;
    const chat = await this.chatRepo.findOne({ where: { id: turn.chatId, userId: turn.userId }, select: { id: true } });
    if (!chat) return null;
    if (!(await this.messageRepo.exists({ where: { chatId: chat.id } }))) {
      await this.chatRepo.update(chat.id, { title: turn.userText.slice(0, TITLE_MAX) });
    }
    return chat.id;
  }

  /** Latest chat with the turn's key that the turn may continue, if any. */
  private async findOpenChat(turn: ExternalTurn): Promise<string | null> {
    const chat = await this.chatRepo.findOne({
      where: { userId: turn.userId, externalSource: turn.source, externalKey: turn.key },
      order: { updatedAt: 'DESC' },
      select: { id: true, updatedAt: true },
    });
    if (!chat || !isWithinIdleWindow(chat.updatedAt, turn.idleMs)) return null;
    if (turn.notBefore && new Date(chat.updatedAt).getTime() < turn.notBefore) return null;
    if (turn.priorUserTexts === undefined) return chat.id;

    const lastUser = await this.messageRepo.findOne({
      where: { chatId: chat.id, role: 'user' },
      order: { createdAt: 'DESC' },
      select: { content: true },
    });
    return isCoherentContinuation(lastUser?.content ?? null, turn.priorUserTexts) ? chat.id : null;
  }

  private async createChat(turn: ExternalTurn): Promise<string> {
    const chat = await this.chatRepo.save(this.chatRepo.create({
      userId: turn.userId,
      title: turn.userText.slice(0, TITLE_MAX),
      externalSource: turn.source,
      externalKey: turn.key,
      externalSatellite: turn.satellite ?? null,
    }));
    return chat.id;
  }
}
