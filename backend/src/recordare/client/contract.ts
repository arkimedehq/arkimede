// GENERATED from recordare packages/client/src/contract.ts @ 42a6729 — do not edit here: change the library and run
// packages/client/scripts/sync-to.sh again.
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Recordare's client contract (docs/API.md): headers, limits and the shapes a client sends and receives. Hand-written so
 * the library has no dependency on the service; the service's own type test (service/test/conformance) fails the build
 * when these drift from its zod schemas.
 */

/** The client's user the request acts for (with a client key). */
export const USER_HEADER = 'X-Recordare-User';
/** The conversation a read or write happens in: evidence of MCP writes, the current turn left out of recall (D50: no viewer filter). */
export const CONVERSATION_HEADER = 'X-Recordare-Conversation';

/** Largest message content Recordare accepts (UTF-8 bytes). */
export const MAX_CONTENT_BYTES = 64 * 1024;
/** Largest number of messages in one ingest request. */
export const MAX_MESSAGES_PER_REQUEST = 500;

/**
 * A personal memory (the account holder is "I": what arrives without a declared identity is the memory's own), or an
 * entity's (a home device, a robot, a place: what arrives undeclared is "someone"'s) — D50.
 */
export type MemoryMode = 'personal' | 'entity';
/** The grammatical gender of the memory's first person in gendered languages (default masculine). */
export type MemoryGender = 'masculine' | 'feminine' | 'neutral';

/** `GET api/v1/me`: who a request acts for. */
export interface Me {
  memoryId: string;
  displayName: string | null;
  mode: MemoryMode;
  gender: MemoryGender;
  /** Recordare Atlas, when installed: link it for the platform's admins only (it shows every person's activity). */
  atlasUrl?: string;
  via: string;
  scopes: string[];
}

/** `PATCH api/v1/me`: the person's settings from their platform. */
export interface MeSettings {
  /** Follows the platform's profile: send it again whenever the user renames themselves. */
  displayName?: string;
  /** Accepted only while the memory is empty (else MemoryNotEmptyError). */
  mode?: MemoryMode;
  /** From the account's profile; changes any time. */
  gender?: MemoryGender;
}

export type ParticipantIdentity = { externalUserId: string } | { channel: string; externalId: string };

export interface IngestParticipant {
  /** The conversation-local reference messages use in `authorRef`. */
  ref: string;
  role: 'holder' | 'assistant' | 'other';
  displayName?: string;
  /**
   * The participant's id on the platform (its user id) or on a channel: Recordare links it to a contact of this memory
   * (created on first sight) — never to another memory.
   */
  identity?: ParticipantIdentity;
}

/**
 * Where a conversation comes from (`mcp_tool` is the service's own, never sent by a client). `document`: a document
 * given to the agent; `perception`: what a device perceives; `ambient`: continuous listening.
 */
export type ConversationSource = 'chat' | 'voice' | 'import_chat' | 'import_social' | 'import_email' | 'import_notes' | 'interview'
  | 'document' | 'perception' | 'ambient';

export interface IngestConversation {
  /** The platform's own stable id of the conversation. */
  externalId: string;
  source?: ConversationSource;
  channel?: string;
  title?: string;
  /** A one-to-one chat (true) or a group (false), when the platform knows: a link code is never accepted in a group (D51). */
  direct?: boolean;
  participants?: IngestParticipant[];
}

/** A one-time code the holder sends from a channel to link that identity to themselves (D51; ten minutes, one use). */
export interface LinkCode { code: string; expiresAt: string }

/** The identities that speak as the memory's "I", and the claims waiting for the holder's confirmation (D51). */
export interface HolderIdentities {
  linked: Array<{ id: string; channel: string | null; client: string | null; externalId: string; linkedAt: string }>;
  pending: Array<{ id: string; channel: string | null; client: string | null; externalId: string; displayName: string | null; claimedAt: string }>;
}

export interface IngestMessage {
  /** The platform's own stable id: Recordare deduplicates on it, so a resend never duplicates. */
  externalId: string;
  /** System prompts are never sent (they may carry secrets). */
  role: 'user' | 'assistant' | 'tool' | 'other';
  toolName?: string;
  authorRef?: string;
  /** At most MAX_CONTENT_BYTES (see clipUtf8). */
  content: string;
  /** ISO 8601 with offset. */
  sentAt: string;
  /** Replace the stored content of an existing message (an edit). */
  upsert?: boolean;
  /** The agent's own content (knowledge given to it, its perceptions, a document); `user` or `other` messages only. */
  own?: boolean;
}

export interface IngestRequest {
  conversation: IngestConversation;
  messages: IngestMessage[];
  hints?: {
    /** Extract now instead of waiting for the conversation to go idle. */
    conversationEnded?: boolean;
  };
}

export interface IngestResult {
  /** null only when no message was sent. */
  conversationId: string | null;
  accepted: number;
  duplicates: number;
  conflicts: string[];
}

/** One voice of a room transcript (continuous listening, `ingestRoom`). */
export interface RoomSpeaker {
  /** The transcript-local reference messages use in `speakerRef`. */
  ref: string;
  displayName?: string;
  /** The platform's user id of a speaker with an account: in their own memory their words are theirs. */
  user?: string;
  /** Otherwise (or as well) a channel identity, e.g. a voice profile: a contact in every recipient's memory. */
  identity?: ParticipantIdentity;
}

/**
 * What a home device heard in a room (WORK_PLAN 6.5 (4)), fanned out by Recordare to the memories of `recipients` (the
 * platform's user ids of the people present whose memory is on — the platform's switch, D50): each gets it as an
 * `ambient` conversation with the same external id, so edits and deletions go through the per-user calls.
 */
export interface RoomRequest {
  conversation: { externalId: string; channel?: string; title?: string };
  speakers: RoomSpeaker[];
  recipients: string[];
  messages: Array<{
    externalId: string;
    /** Missing when the device could not tell who spoke: "someone" in every memory. */
    speakerRef?: string;
    content: string;
    /** ISO 8601 with offset. */
    sentAt: string;
    upsert?: boolean;
  }>;
  hints?: { conversationEnded?: boolean };
}

export interface RoomResult {
  /** One per recipient, in the request's order; `conversationId` is that memory's conversation. */
  recipients: Array<{ user: string; conversationId: string | null; accepted: number; duplicates: number; conflicts: string[] }>;
}

// ── The diary: read / write API for host UIs (API.md §4) ─────────────────────────────────────────────────────────

export type PlanStatus = 'open' | 'confirmed' | 'cancelled' | 'rescheduled' | 'unresolved';
export type Precision = 'minute' | 'day' | 'month' | 'year' | 'approximate' | 'unknown';

export interface Episode {
  id: string;
  kind: 'event' | 'plan' | 'state_change';
  content: string;
  /** Local date (YYYY-MM-DD, or YYYY-MM / YYYY by precision). */
  occurredAt: string | null;
  occurredUntil: string | null;
  datePrecision: Precision;
  timeExpression: string | null;
  place: string | null;
  planStatus?: PlanStatus;
  importance: number;
  valence: number | null;
  feelings: string[];
  opinion: string | null;
  people: string[];
  origin: string;
  authorRole: string;
  inferred: boolean;
  corrected: boolean;
  recordedAt: string;
}

export interface EpisodeDetail extends Episode {
  /** The messages behind it; text only from the client's own conversations (`otherClient` otherwise). */
  evidence: Array<{ messageId?: string; conversation?: string; role: string; author?: string | null; sentAt: string; text?: string; kind: string; otherClient?: true }>;
  /** Earlier, wrong versions this one corrected (newest first). */
  history: Array<{ id: string; content: string; occurredAt: string | null; recordedAt: string }>;
  planEvents?: Array<{ patch: string; note: string | null; at: string }>;
  confirmedBy?: Episode | null;
  rescheduledTo?: Episode | null;
}

export interface EpisodeQuery {
  from?: string;
  to?: string;
  kind?: Episode['kind'];
  planStatus?: PlanStatus;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface Digest { id: string; level: 'day' | 'month'; periodStart: string; periodEnd: string; content: string; writtenAt: string }

export interface Fact {
  id: string;
  /** Entity memories: the person the fact is about. */
  about?: string;
  key: string;
  value: string | null;
  status: string;
  validFrom: string | null;
  validTo: string | null;
  pending: boolean;
  inferred: boolean;
  history: Array<{ id: string; value: string | null; from: string | null; to: string | null; status: string }>;
}

export interface Note {
  id: string;
  category: 'preference' | 'habit' | 'value' | 'relationship' | 'knowledge' | 'profile' | 'constraint';
  content: string;
  pinned: boolean;
  pending: boolean;
  inferred: boolean;
  /** A recurring pattern the memory drew from its episodes (inferred, never pending; WORK_PLAN 5.4). */
  pattern: boolean;
  authorRole: string;
  supportCount: number;
  recordedAt: string;
}

/** The messages behind a fact or a note; text only from the client's own conversations (`otherClient` otherwise). */
export type ItemEvidence = Array<{ messageId?: string; conversation?: string; role: string; author?: string | null; sentAt: string; text?: string; otherClient?: true }>;

export interface FactDetail extends Fact {
  authorRole: string;
  /** The fact this one corrected (a correction by the person). */
  corrects: string | null;
  recordedAt: string;
  evidence: ItemEvidence;
  /** Episodes the fact was drawn from. */
  episodeIds: string[];
}

export interface NoteDetail extends Note {
  status: 'current' | 'superseded' | 'corrected';
  supersedes: string | null;
  corrects: string | null;
  evidence: ItemEvidence;
  episodeIds: string[];
}

/** One entry of the notes change feed; `note` is the note as it is now, null once forgotten. */
export interface NoteChange {
  seq: number;
  noteId: string;
  change: 'created' | 'updated' | 'corrected' | 'confirmed' | 'forgotten' | 'retired';
  at: string;
  /** For `updated` / `corrected`: the note this one took the place of (a copy of it should follow), else null. */
  replaces: string | null;
  note: (Note & { status: string }) | null;
}

export interface MemorySettings {
  locale: string;
  timezone: string;
  /** null: the installation default (`effectiveQualityProfile`). */
  qualityProfile: 'economy' | 'balanced' | 'full' | null;
  effectiveQualityProfile: 'economy' | 'balanced' | 'full';
}

export interface UsageTotals { calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number; failed: number }

export interface Usage extends UsageTotals {
  from: string;
  to: string;
  byPrompt: Array<UsageTotals & { prompt: string }>;
  byDay: Array<UsageTotals & { day: string }>;
}

export interface ExportJob { id: string; status: 'running' | 'done' | 'failed'; createdAt: string; finishedAt: string | null; bytes: number | null }

/** Size of the parts `learnSource` sends a big text in (UTF-8 bytes; the service's default request limit is 16 MB). */
export const SOURCE_PART_BYTES = 4 * 1024 * 1024;

export type SourceKind = 'document' | 'page' | 'note' | 'book' | 'own_text';

/** `POST api/v1/ingest/sources` (WORK_PLAN 8.9, D49): a text the agent learns — the client turns files into text. */
export interface LearnSource {
  /** The client's own id for the source: sending it again replaces it (a new version). */
  externalId: string;
  title: string;
  kind?: SourceKind;
  author?: string;
  uri?: string;
  language?: string;
  learnedAt?: string;
  /** Who gave it: "me" (the memory's self), "someone", or a person by name. Default "me". */
  providedBy?: 'me' | 'someone' | { name: string };
  /** The conversation it was learned in: its extraction then tells of it. */
  conversation?: { externalId: string };
  text: string;
}

export interface LearnSourceResult {
  sourceId: string;
  status: 'receiving' | 'indexing' | 'ready';
  parts: number;
  passages: number;
  duplicate: boolean;
}

/** `GET api/v1/sources`: a learned source (the Diary's "what I learned"). */
export interface Source {
  id: string;
  externalId: string;
  title: string;
  kind: string;
  author: string | null;
  uri: string | null;
  providedBy: { kind: 'self' } | { kind: 'someone' } | { kind: 'contact'; name: string };
  learnedAt: string;
  status: 'receiving' | 'indexing' | 'ready';
  chars: number;
  passages: number;
  episodeIds: string[];
}

/** `POST api/v1/context`: the memories relevant to the message a host is about to answer (WORK_PLAN 5.7). */
export interface MemoryContext {
  /** A fenced `<memory-context>` block to append to the prompt, or null (nothing relevant, or off). */
  block: string | null;
  items: number;
}

/**
 * Cuts text to at most `maxBytes` UTF-8 bytes without splitting a character, ending with `marker` so a reader (and the
 * memory engine) knows the text was cut. The marker counts within the limit.
 */
export function clipUtf8(text: string, maxBytes = MAX_CONTENT_BYTES, marker = ' …[truncated]'): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  // Step back over continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + marker;
}
