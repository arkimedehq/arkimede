// GENERATED from recordare packages/client/src/client.ts @ 4bd90f7 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {
  CONVERSATION_HEADER, type Digest, type Episode, type EpisodeDetail, type EpisodeQuery, type Fact, type IngestRequest, type IngestResult,
  MAX_MESSAGES_PER_REQUEST, type Me, type MeSettings, type MemoryContext, type Note, type PlanStatus, type Precision,
} from './contract.js';
import { MemoryNotEmptyError, RecordareHttpError } from './errors.js';
import { type ClientOptions, Http } from './http.js';
import { RecordareMcp, type McpOptions } from './mcp.js';

const enc = encodeURIComponent;

/** Query string from the defined values. */
function qs(query: object): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Recordare for one platform (docs/INTEGRATION.md): who a user is and their consent, their settings, the conversations
 * the platform sends, deletions, and recall over MCP. Stateless apart from MCP sessions; a host keeps its own outbox and
 * cache (see `delivery` and `PersonDirectory`).
 */
export class RecordareClient {
  readonly http: Http;
  readonly mcp: RecordareMcp;

  constructor(options: ClientOptions & { mcp?: McpOptions }) {
    this.http = new Http(options);
    this.mcp = new RecordareMcp(this.http, options.mcp);
  }

  /** The person behind `user` (auto-provisioned when the client allows it), their consent and kind of memory. */
  me(user: string): Promise<Me> {
    return this.http.request<Me>('GET', 'api/v1/me', { user });
  }

  /** The person's settings from the platform: the name (keep it in sync on every rename) and the kind of memory. */
  async updateMe(user: string, settings: MeSettings): Promise<void> {
    try {
      await this.http.request('PATCH', 'api/v1/me', { user, body: settings });
    } catch (err) {
      if (err instanceof RecordareHttpError && err.status === 409) throw new MemoryNotEmptyError();
      throw err;
    }
  }

  /**
   * Sends messages of one conversation, split into requests of at most MAX_MESSAGES_PER_REQUEST. Idempotent: Recordare
   * deduplicates on each message's externalId. Before consent nothing is stored (`stored: false`).
   */
  async ingest(user: string, req: IngestRequest): Promise<IngestResult> {
    const total: IngestResult = { conversationId: null, accepted: 0, duplicates: 0, conflicts: [], stored: true };
    for (let i = 0; i < req.messages.length; i += MAX_MESSAGES_PER_REQUEST) {
      const last = i + MAX_MESSAGES_PER_REQUEST >= req.messages.length;
      const part = await this.http.request<IngestResult>('POST', 'api/v1/ingest/messages', {
        user,
        body: {
          conversation: req.conversation,
          messages: req.messages.slice(i, i + MAX_MESSAGES_PER_REQUEST),
          // The end-of-conversation hint belongs to the last part only.
          ...(req.hints && last ? { hints: req.hints } : {}),
        },
      });
      total.conversationId = part.conversationId ?? total.conversationId;
      total.accepted += part.accepted;
      total.duplicates += part.duplicates;
      total.conflicts.push(...part.conflicts);
      total.stored &&= part.stored;
    }
    return total;
  }

  /**
   * The memories relevant to `query` (the message about to be answered) as a fenced block to append to the prompt — or
   * null. Append it at the end of the system prompt (it changes every turn: keep the stable part first for prompt
   * caching); never store it as a chat message.
   */
  context(user: string, conversation: string, query: string): Promise<MemoryContext> {
    return this.http.request<MemoryContext>('POST', 'api/v1/context', { user, body: { query }, headers: { [CONVERSATION_HEADER]: conversation } });
  }

  /** An edited message: Recordare re-extracts what depended on it. */
  async editMessage(user: string, conversation: string, message: string, content: string): Promise<void> {
    await this.http.request('PATCH', `api/v1/ingest/conversations/${enc(conversation)}/messages/${enc(message)}`, { user, body: { content } });
  }

  /** A deleted message: Recordare forgets it and what came only from it. A message it never had counts as done. */
  async deleteMessage(user: string, conversation: string, message: string): Promise<void> {
    await this.gone(this.http.request('DELETE', `api/v1/ingest/conversations/${enc(conversation)}/messages/${enc(message)}`, { user }));
  }

  /** A deleted conversation. A conversation Recordare never had counts as done. */
  async deleteConversation(user: string, conversation: string): Promise<void> {
    await this.gone(this.http.request('DELETE', `api/v1/ingest/conversations/${enc(conversation)}`, { user }));
  }

  // ── The diary (API.md §4): what Recordare remembers, shown to the person in the platform's UI ──────────────────

  /** The timeline, newest first; pass `nextCursor` back as `cursor` for the next page. */
  episodes(user: string, query: EpisodeQuery = {}): Promise<{ items: Episode[]; nextCursor: string | null }> {
    return this.http.request('GET', `api/v1/episodes${qs(query)}`, { user });
  }

  episode(user: string, id: string): Promise<EpisodeDetail> {
    return this.http.request('GET', `api/v1/episodes/${enc(id)}`, { user });
  }

  /** The person corrects an episode: a new version replaces it (the wrong one stays in its history). */
  async correctEpisode(user: string, id: string, fix: { content?: string; occurredAt?: string; datePrecision?: Exclude<Precision, 'unknown' | 'minute'> }): Promise<string> {
    return (await this.http.request<{ id: string }>('POST', `api/v1/episodes/${enc(id)}/corrections`, { user, body: fix })).id;
  }

  /** The person forgets an episode: it is removed and never recreated. */
  async forgetEpisode(user: string, id: string): Promise<void> {
    await this.http.request('DELETE', `api/v1/episodes/${enc(id)}`, { user });
  }

  digests(user: string, query: { level?: 'day' | 'month'; from?: string; to?: string } = {}): Promise<Digest[]> {
    return this.http.request('GET', `api/v1/digests${qs(query)}`, { user });
  }

  facts(user: string, query: { key?: string; asOf?: string; includePending?: boolean } = {}): Promise<Fact[]> {
    return this.http.request('GET', `api/v1/facts${qs(query)}`, { user });
  }

  notes(user: string, query: { category?: Note['category']; pinned?: boolean; includePending?: boolean } = {}): Promise<Note[]> {
    return this.http.request('GET', `api/v1/notes${qs(query)}`, { user });
  }

  /** Plans, soonest first (open and unresolved unless a status is given). */
  plans(user: string, query: { status?: PlanStatus } = {}): Promise<Episode[]> {
    return this.http.request('GET', `api/v1/plans${qs(query)}`, { user });
  }

  async pinNote(user: string, id: string, pinned: boolean): Promise<void> {
    await this.http.request('PATCH', `api/v1/notes/${enc(id)}`, { user, body: { pinned } });
  }

  /** Removes a note or a fact. */
  async delete(user: string, what: 'notes' | 'facts', id: string): Promise<void> {
    await this.http.request('DELETE', `api/v1/${what}/${enc(id)}`, { user });
  }

  /** A pending (inferred) note or fact: confirmed it becomes the person's, rejected it is removed. */
  async decide(user: string, what: 'notes' | 'facts', id: string, decision: 'confirm' | 'reject'): Promise<void> {
    await this.http.request('POST', `api/v1/${what}/${enc(id)}/${decision}`, { user });
  }

  /** Closes the MCP sessions (on shutdown). */
  close(): Promise<void> {
    return this.mcp.close();
  }

  private async gone(p: Promise<unknown>): Promise<void> {
    try {
      await p;
    } catch (err) {
      if (!(err instanceof RecordareHttpError && err.status === 404)) throw err;
    }
  }
}
