// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One tool executed during an invocation (same shape family as Message.toolCalls). */
export interface InvocationToolCall {
  name: string;
  input?: any;
  output?: any;
  ok?: boolean;
  durationMs?: number;
}

/**
 * Log of agent invocations coming from OUTSIDE the chat UI (OpenAI-compatible
 * shim: chat completions and audio routes; future headless surfaces can reuse
 * it with their own `origin`). Chat traffic is NOT logged here — it is already
 * fully persisted as Chat/Message rows.
 *
 * Previews are truncated at write time; rows expire via the retention sweep in
 * InvocationsService (INVOCATION_LOG_RETENTION_DAYS).
 */
@Entity('agent_invocations')
export class AgentInvocation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @CreateDateColumn()
  createdAt: Date;

  /** Caller identity (the user the JWT/api-key resolves to). */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  /** Surface that produced the call (e.g. 'voice' = OpenAI-compat shim). */
  @Column({ type: 'varchar', length: 30 })
  origin: string;

  /** Route within the surface: 'chat' | 'transcription' | 'speech'. */
  @Column({ type: 'varchar', length: 30 })
  route: string;

  /** Resolved model/agent slug (chat) or voice id (speech). */
  @Column({ type: 'varchar', length: 120, nullable: true })
  model: string | null;

  /** Display prefix of the ak_ key used, null when authenticated via JWT. */
  @Column({ type: 'varchar', length: 40, nullable: true })
  apiKeyPrefix: string | null;

  /** Truncated preview of the user input (text, or a file summary for audio). */
  @Column({ type: 'text', nullable: true })
  inputPreview: string | null;

  /** Truncated preview of the produced output. */
  @Column({ type: 'text', nullable: true })
  outputPreview: string | null;

  /** Tools executed by the pipeline during the invocation (chat route only). */
  @Column({ type: 'jsonb', nullable: true })
  toolCalls: InvocationToolCall[] | null;

  @Column({ type: 'int', nullable: true })
  inputTokens: number | null;

  @Column({ type: 'int', nullable: true })
  outputTokens: number | null;

  @Column({ type: 'int', nullable: true })
  durationMs: number | null;

  @Column({ type: 'varchar', length: 10, default: 'ok' })
  status: 'ok' | 'error';

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
