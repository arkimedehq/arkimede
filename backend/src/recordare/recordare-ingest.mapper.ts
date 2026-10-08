// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * @file recordare-ingest.mapper.ts
 *
 * Arkimede chat + messages → body of Recordare `POST api/v1/ingest/messages`
 * (Recordare API §2). Pure functions (unit-tested).
 *
 * Mapping:
 *   - conversation.externalId = chat id; participants: the chat owner (role
 *     owner), the assistant, and every other user who wrote in a shared chat
 *     (role other, identity = their Arkimede user id).
 *   - message.externalId = Arkimede message id (stable → idempotent retries);
 *     the owner's turns are `user`, other humans' turns `other`, the assistant's
 *     `assistant`; each recorded tool call of an assistant message becomes a
 *     `tool` message `<messageId>:tool:<n>` (Recordare D30). `system` is never sent.
 */
import type { ToolCallRecord } from '../messages/messages.entity';
import { clipUtf8, type IngestRequest } from './client';

export { clipUtf8 };

export interface IngestChat {
  id: string;
  title: string | null;
  userId: string;
  externalSource: string | null;
}

export interface IngestMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls: ToolCallRecord[] | null;
  authorId: string | null;
  createdAt: Date;
}

/** Recordare's ingest request (the client library's contract). */
export type IngestBody = IngestRequest & { conversation: { participants: NonNullable<IngestRequest['conversation']['participants']> } };

function toolContent(tc: ToolCallRecord): string {
  const part = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v ?? null));
  return clipUtf8(`input: ${part(tc.input)}\noutput: ${part(tc.output)}${tc.ok === false ? '\n(failed)' : ''}`);
}

/**
 * @param names  display names by Arkimede user id (owner and other authors)
 * @param assistantName  the assistant's display name (APP_NAME)
 */
export function buildIngestBody(
  chat: IngestChat,
  messages: IngestMessage[],
  names: Map<string, string>,
  assistantName: string,
): IngestBody {
  const others = new Set<string>();
  const out: IngestBody['messages'] = [];
  const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

  for (const m of sorted) {
    if (m.role === 'system') continue;
    const sentAt = m.createdAt.toISOString();
    if (m.role === 'assistant') {
      (m.toolCalls ?? []).forEach((tc, i) => {
        const at = Number.isFinite(tc?.startedAt) ? new Date(tc.startedAt).toISOString() : sentAt;
        out.push({ externalId: `${m.id}:tool:${i}`, role: 'tool', toolName: String(tc?.name ?? 'tool').slice(0, 200), authorRef: 'assistant', content: toolContent(tc), sentAt: at });
      });
      if (m.content?.trim()) out.push({ externalId: m.id, role: 'assistant', authorRef: 'assistant', content: clipUtf8(m.content), sentAt });
      continue;
    }
    if (!m.content?.trim()) continue;
    const byOwner = !m.authorId || m.authorId === chat.userId;
    if (!byOwner) others.add(m.authorId!);
    out.push({
      externalId: m.id,
      role: byOwner ? 'user' : 'other',
      authorRef: byOwner ? 'owner' : `user:${m.authorId}`,
      content: clipUtf8(m.content),
      sentAt,
    });
  }

  const ownerName = names.get(chat.userId);
  return {
    conversation: {
      externalId: chat.id,
      source: chat.externalSource === 'wyoming' ? 'voice' : 'chat',
      channel: chat.externalSource ? `arkimede-${chat.externalSource}` : 'arkimede',
      ...(chat.title?.trim() ? { title: chat.title.trim().slice(0, 500) } : {}),
      participants: [
        { ref: 'owner', role: 'owner', ...(ownerName ? { displayName: ownerName.slice(0, 200) } : {}) },
        { ref: 'assistant', role: 'assistant', displayName: assistantName.slice(0, 200) },
        ...[...others].map((id) => ({
          ref: `user:${id}`, role: 'other' as const,
          ...(names.get(id) ? { displayName: names.get(id)!.slice(0, 200) } : {}),
          identity: { externalUserId: id },
        })),
      ],
    },
    messages: out,
  };
}
