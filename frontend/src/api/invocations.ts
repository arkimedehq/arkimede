// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import api from './client';

export interface InvocationToolCall {
  name: string;
  input?: any;
  output?: any;
  ok?: boolean;
  durationMs?: number;
}

export interface Invocation {
  id: string;
  createdAt: string;
  userId: string | null;
  /** Present only in the admin all-users view. */
  userEmail?: string | null;
  origin: string;
  route: 'chat' | 'transcription' | 'speech';
  model: string | null;
  apiKeyPrefix: string | null;
  inputPreview: string | null;
  outputPreview: string | null;
  toolCalls: InvocationToolCall[] | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  status: 'ok' | 'error';
  error: string | null;
}

export interface ListInvocationsParams {
  /** Admin only: every user's invocations. */
  all?: boolean;
  route?: string;
  limit?: number;
  offset?: number;
}

export const invocationsApi = {
  /** GET /api/invocations — external agent invocation log, newest first. */
  list: (params: ListInvocationsParams = {}): Promise<{ items: Invocation[]; total: number }> =>
    api.get('/invocations', {
      params: {
        ...(params.all ? { all: 1 } : {}),
        ...(params.route ? { route: params.route } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
        ...(params.offset ? { offset: params.offset } : {}),
      },
    }).then((r) => r.data),
};
