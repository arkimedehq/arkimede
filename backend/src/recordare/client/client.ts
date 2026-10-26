// GENERATED from recordare packages/client/src/client.ts @ 42a6729 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {
  CONVERSATION_HEADER, type Digest, type Episode, type EpisodeDetail, type EpisodeQuery, type ExportJob, type Fact, type FactDetail,
  type HolderIdentities, type IngestRequest, type IngestResult, type RoomRequest, type RoomResult, type LearnSource, type LinkCode, type LearnSourceResult, MAX_MESSAGES_PER_REQUEST, type Me, type MemorySettings,
  type MeSettings, type MemoryContext, type Note, type NoteChange, type NoteDetail, type PlanStatus, type Precision, type Source,
  SOURCE_PART_BYTES, type Usage,
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
 * Recordare for one platform (docs/INTEGRATION.md): who a user is, their settings, the conversations
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

  /** The memory behind `user` (auto-provisioned when the client allows it), its mode and gender. */
  me(user: string): Promise<Me> {
    return this.http.request<Me>('GET', 'api/v1/me', { user });
  }

  /** The memory's settings from the platform: the name (keep it in sync on every rename), the mode and the gender. */
  async updateMe(user: string, settings: MeSettings): Promise<void> {
    try {
      await this.http.request('PATCH', 'api/v1/me', { user, body: settings });
    } catch (err) {
      if (err instanceof RecordareHttpError && err.status === 409) throw new MemoryNotEmptyError();
      throw err;
    }
  }

  /** A one-time code for the holder to send from a channel (D51; personal memories only, else 409). */
  linkCode(user: string): Promise<LinkCode> {
    return this.http.request<LinkCode>('POST', 'api/v1/me/link-codes', { user });
  }

  /** The identities that speak as the memory's "I" and the claims waiting for confirmation (D51). */
  holderIdentities(user: string): Promise<HolderIdentities> {
    return this.http.request<HolderIdentities>('GET', 'api/v1/me/identities', { user });
  }

  /** Confirms a claim: that channel identity is the holder from now on. */
  async confirmHolderClaim(user: string, id: string): Promise<void> {
    await this.http.request('POST', `api/v1/me/identities/pending/${encodeURIComponent(id)}/confirm`, { user });
  }

  /** Rejects a claim (not the holder). */
  async rejectHolderClaim(user: string, id: string): Promise<void> {
    await this.http.request('DELETE', `api/v1/me/identities/pending/${encodeURIComponent(id)}`, { user });
  }

  /** Unlinks one of the holder's identities. */
  async unlinkHolderIdentity(user: string, id: string): Promise<void> {
    await this.http.request('DELETE', `api/v1/me/identities/${encodeURIComponent(id)}`, { user });
  }

  /**
   * Sends messages of one conversation, split into requests of at most MAX_MESSAGES_PER_REQUEST. Idempotent: Recordare
   * deduplicates on each message's externalId. Recordare always stores (D50): the on/off switch is the platform's.
   */
  async ingest(user: string, req: IngestRequest): Promise<IngestResult> {
    const total: IngestResult = { conversationId: null, accepted: 0, duplicates: 0, conflicts: [] };
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
    }
    return total;
  }

  /**
   * Sends a room transcript to the memories of the people present (continuous listening), split into requests of at
   * most MAX_MESSAGES_PER_REQUEST; needs a client key (not a personal token). Idempotent like `ingest`.
   */
  async ingestRoom(req: RoomRequest): Promise<RoomResult> {
    const total = new Map<string, RoomResult['recipients'][number]>();
    for (let i = 0; i < req.messages.length; i += MAX_MESSAGES_PER_REQUEST) {
      const last = i + MAX_MESSAGES_PER_REQUEST >= req.messages.length;
      const part = await this.http.request<RoomResult>('POST', 'api/v1/ingest/room', {
        body: { ...req, messages: req.messages.slice(i, i + MAX_MESSAGES_PER_REQUEST), hints: req.hints && last ? req.hints : undefined },
      });
      for (const r of part.recipients) {
        const t = total.get(r.user);
        if (!t) total.set(r.user, { ...r, conflicts: [...r.conflicts] });
        else {
          t.conversationId = r.conversationId ?? t.conversationId;
          t.accepted += r.accepted;
          t.duplicates += r.duplicates;
          t.conflicts.push(...r.conflicts);
        }
      }
    }
    return { recipients: [...total.values()] };
  }

  /**
   * The memories relevant to `query` (the message about to be answered) as a fenced block to append to the prompt — or
   * null. Append it at the end of the system prompt (it changes every turn: keep the stable part first for prompt
   * caching); never store it as a chat message.
   */
  context(user: string, conversation: string, query: string): Promise<MemoryContext> {
    return this.http.request<MemoryContext>('POST', 'api/v1/context', { user, body: { query }, headers: { [CONVERSATION_HEADER]: conversation } });
  }

  /**
   * Stores the turn and returns the memory context for it in one round trip (needs the `ingest` and `read` scopes):
   * the context is computed for the ingested conversation, from `query` or else the turn's last user message.
   */
  contextWithTurn(user: string, turn: IngestRequest, query?: string): Promise<MemoryContext> {
    return this.http.request<MemoryContext>('POST', 'api/v1/context', { user, body: { ingest: turn, ...(query ? { query } : {}) } });
  }

  /** The conversation ended (session closed, /new): extraction runs now. A conversation Recordare never had is done. */
  async endConversation(user: string, conversation: string): Promise<void> {
    await this.gone(this.http.request('POST', `api/v1/ingest/conversations/${enc(conversation)}/end`, { user }));
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

  // ── Learned sources (WORK_PLAN 8.9, D49): text the agent learns — the client turns files into text ─────────────

  /**
   * The agent learns a text. A big one is sent in parts (at paragraph boundaries, `partBytes` each); any size works.
   * Sending the same `externalId` again replaces the source; the same first part again is a duplicate.
   */
  async learnSource(user: string, source: LearnSource, partBytes = SOURCE_PART_BYTES): Promise<LearnSourceResult> {
    const [first = '', ...rest] = splitParts(source.text, partBytes);
    let result = await this.http.request<LearnSourceResult>('POST', 'api/v1/ingest/sources', { user, body: { ...source, text: first, final: rest.length === 0 } });
    if (result.duplicate) return result;
    for (const [i, text] of rest.entries()) {
      result = await this.http.request<LearnSourceResult>('POST', `api/v1/ingest/sources/${enc(source.externalId)}/parts`,
        { user, body: { part: i + 1, text, final: i === rest.length - 1 } });
    }
    return result;
  }

  /** The agent forgets a source (its text and passages; episodes keep a "forgotten source" marker). One it never had counts as done. */
  async forgetSource(user: string, externalId: string): Promise<void> {
    await this.http.request('DELETE', `api/v1/ingest/sources/${enc(externalId)}`, { user });
  }

  /** What the agent learned, newest first. */
  sources(user: string): Promise<Source[]> {
    return this.http.request('GET', 'api/v1/sources', { user });
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

  /**
   * The person forgets a period (days or months, inclusive): its episodes and raw messages (`keepRaw`: kept but hidden
   * and never extracted again), with what only they supported. Returns how much went.
   */
  forgetPeriod(user: string, period: { from: string; to: string; keepRaw?: boolean }): Promise<{ episodes: number; messages: number; facts: number; notes: number }> {
    return this.http.request('POST', 'api/v1/forget', { user, body: period });
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

  /** The person writes an episode in the platform's UI (stated, theirs). Returns its id. */
  async addEpisode(user: string, episode: { content: string; kind?: 'event' | 'plan'; occurredAt?: string; occurredUntil?: string;
    datePrecision?: Exclude<Precision, 'unknown' | 'minute'>; place?: string; people?: string[] }): Promise<string> {
    return (await this.http.request<{ id: string }>('POST', 'api/v1/episodes', { user, body: episode })).id;
  }

  /** The person writes a note in the platform's UI (stated, theirs). Returns its id. */
  async addNote(user: string, note: { content: string; category?: Note['category'] }): Promise<string> {
    return (await this.http.request<{ id: string }>('POST', 'api/v1/notes', { user, body: note })).id;
  }

  fact(user: string, id: string): Promise<FactDetail> {
    return this.http.request('GET', `api/v1/facts/${enc(id)}`, { user });
  }

  note(user: string, id: string): Promise<NoteDetail> {
    return this.http.request('GET', `api/v1/notes/${enc(id)}`, { user });
  }

  /** The person corrects a current fact (`value` null: not known any more); the wrong one stays in its history. */
  async correctFact(user: string, id: string, fix: { value: string | null; validFrom?: string; datePrecision?: Exclude<Precision, 'unknown' | 'minute'> }): Promise<string> {
    return (await this.http.request<{ id: string }>('POST', `api/v1/facts/${enc(id)}/corrections`, { user, body: fix })).id;
  }

  /** The person corrects a current note; the wrong one stays as `corrected`. */
  async correctNote(user: string, id: string, fix: { content: string; category?: Note['category'] }): Promise<string> {
    return (await this.http.request<{ id: string }>('POST', `api/v1/notes/${enc(id)}/corrections`, { user, body: fix })).id;
  }

  /** The notes change feed, for a platform keeping a copy: pass `next` back as `since`; `more` when the page was full. */
  noteChanges(user: string, query: { since?: number; limit?: number } = {}): Promise<{ items: NoteChange[]; next: number; more: boolean }> {
    return this.http.request('GET', `api/v1/notes/changes${qs(query)}`, { user });
  }

  settings(user: string): Promise<MemorySettings> {
    return this.http.request('GET', 'api/v1/settings', { user });
  }

  /** Needs `memory_settings`: the memory's personal token (never a client key); pass `user` empty with it. */
  updateSettings(user: string, patch: { locale?: string; timezone?: string; qualityProfile?: MemorySettings['qualityProfile'] }): Promise<MemorySettings> {
    return this.http.request('PATCH', 'api/v1/settings', { user, body: patch });
  }

  /** LLM calls and tokens spent on the memory between two local days (default: the last 30). */
  usage(user: string, query: { from?: string; to?: string } = {}): Promise<Usage> {
    return this.http.request('GET', `api/v1/usage${qs(query)}`, { user });
  }

  /** Starts a full export (needs `export`: the memory's personal token); poll `exportJob`, then `exportArchive`. */
  startExport(user: string): Promise<ExportJob> {
    return this.http.request('POST', 'api/v1/exports', { user });
  }

  exportJob(user: string, id: string): Promise<ExportJob> {
    return this.http.request('GET', `api/v1/exports/${enc(id)}`, { user });
  }

  /** The finished export: one JSON archive (`format: "recordare-export/1"`). */
  exportArchive(user: string, id: string): Promise<Record<string, unknown>> {
    return this.http.request('GET', `api/v1/exports/${enc(id)}/archive`, { user });
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

/** A text in parts of at most `maxBytes` UTF-8 bytes, cut at paragraph boundaries (inside a long paragraph: at a space, else between characters). */
export function splitParts(text: string, maxBytes: number): string[] {
  const size = (t: string) => Buffer.byteLength(t, 'utf8');
  if (size(text) <= maxBytes) return [text];
  const parts: string[] = [];
  let current = '';
  const push = (piece: string) => {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (size(joined) <= maxBytes) { current = joined; return; }
    if (current) parts.push(current);
    current = piece;
  };
  for (const paragraph of text.split(/\n\s*\n/)) {
    let rest = paragraph;
    while (size(rest) > maxBytes) {
      let end = rest.length;
      while (end > 0 && size(rest.slice(0, end)) > maxBytes) end = Math.floor(end * 0.9);
      const space = rest.lastIndexOf(' ', end);
      let cut = space > end / 2 ? space : end;
      if (/[\uD800-\uDBFF]/.test(rest.charAt(cut - 1))) cut--; // never between the halves of a surrogate pair
      push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) push(rest);
  }
  if (current) parts.push(current);
  return parts;
}
