// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Collects the pipeline's tool events into InvocationToolCall records for the
 * invocation log (same onToolCall/onToolResult pairing as the chat SSE flow in
 * messages.controller.ts; truncation happens in InvocationsService at write time).
 * Shared by the external entry points (OpenAI-compatible shim, Wyoming).
 */
import type { InvocationToolCall } from './invocation.entity';

export function makeToolCollector() {
  const records: (InvocationToolCall & { startedAt: number })[] = [];
  return {
    records,
    onToolCall: (toolCall: any) => {
      records.push({ name: toolCall?.name ?? '', input: toolCall?.input, startedAt: Date.now() });
    },
    onToolResult: (toolName: string, result: any, status?: 'success' | 'error', input?: any) => {
      const record = records.find((r) => r.name === toolName && r.output === undefined);
      if (record) {
        record.output = result;
        record.ok = status !== 'error';
        record.durationMs = Date.now() - record.startedAt;
        // The complete input is only known when the call ends (args arrive as deltas).
        if (input !== undefined) record.input = input;
      }
    },
  };
}
