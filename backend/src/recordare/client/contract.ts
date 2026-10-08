// GENERATED from recordare packages/client/src/contract.ts @ 4bd90f7 — do not edit here: change the library and run
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
/** The conversation a read happens in: Recordare resolves who will see the answer from it (viewer context). */
export const CONVERSATION_HEADER = 'X-Recordare-Conversation';

/** Largest message content Recordare accepts (UTF-8 bytes). */
export const MAX_CONTENT_BYTES = 64 * 1024;
/** Largest number of messages in one ingest request. */
export const MAX_MESSAGES_PER_REQUEST = 500;

/** A personal memory, or one shared by everyone using the account (an entity: a home device, a robot, a place). */
export type MemoryKind = 'human' | 'entity';

/** `GET api/v1/me`: who a request acts for. */
export interface Me {
  ownerId: string;
  displayName: string | null;
  kind: MemoryKind;
  /** The person's consent, given by the Recordare admin: until then ingest stores nothing. */
  episodicEnabled: boolean;
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
  kind?: MemoryKind;
}

export type ParticipantIdentity = { externalUserId: string } | { channel: string; externalId: string };

export interface IngestParticipant {
  /** The conversation-local reference messages use in `authorRef`. */
  ref: string;
  role: 'owner' | 'assistant' | 'other';
  displayName?: string;
  /** A verified identity on the platform: lets Recordare link the participant to a known person. */
  identity?: ParticipantIdentity;
}

/** Where a conversation comes from (`mcp_tool` is the service's own, never sent by a client). */
export type ConversationSource = 'chat' | 'voice' | 'import_chat' | 'import_social' | 'import_email' | 'import_notes' | 'interview';

export interface IngestConversation {
  /** The platform's own stable id of the conversation. */
  externalId: string;
  source?: ConversationSource;
  channel?: string;
  title?: string;
  participants?: IngestParticipant[];
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
  conversationId: string | null;
  accepted: number;
  duplicates: number;
  conflicts: string[];
  /** false = consent not given yet: nothing was stored. */
  stored: boolean;
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
  authorRole: string;
  supportCount: number;
  recordedAt: string;
}

/** `POST api/v1/context`: the memories relevant to the message a host is about to answer (WORK_PLAN 5.7). */
export interface MemoryContext {
  /** A fenced `<memory-context>` block to append to the prompt, or null (nothing relevant, not owner-only, or off). */
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
