// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import type {CliConfig} from '../config.js';
import type {Message, MessageAttachment, StreamHandlers} from '../types.js';
import {ApiError, apiFetch, apiUrl, buildHeaders} from './http.js';

export const messagesApi = {
    list: (cfg: CliConfig, chatId: string) =>
        apiFetch<Message[]>(cfg, `/api/chats/${chatId}/messages`),

    /**
     * Send a message and consume the SSE response (POST + streamed body, same
     * protocol the web frontend uses). Events arrive as `data: {json}` lines
     * keyed by `type`; the stream always terminates with a `done` event.
     * Aborting the signal closes the connection, which stops generation
     * server-side — there is no separate stop endpoint.
     */
    stream: async (
        cfg: CliConfig,
        chatId: string,
        content: string,
        handlers: StreamHandlers,
        signal?: AbortSignal,
        attachments: MessageAttachment[] = [],
    ): Promise<void> => {
        const response = await fetch(apiUrl(cfg, `/api/chats/${chatId}/messages/stream`), {
            method: 'POST',
            headers: buildHeaders(cfg, {'Content-Type': 'application/json'}),
            body: JSON.stringify({content, attachments}),
            signal,
        });

        if (!response.ok || !response.body) {
            throw new ApiError(`HTTP ${response.status} ${response.statusText}`, response.status);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const dispatch = (line: string) => {
            if (!line.startsWith('data: ')) return;
            let event: any;
            try {
                event = JSON.parse(line.slice(6));
            } catch {
                return;
            }
            switch (event.type) {
                case 'chunk':
                    handlers.onChunk?.(event.content);
                    break;
                case 'tool_call':
                    handlers.onToolCall?.(event.toolCall);
                    break;
                case 'tool_result':
                    handlers.onToolResult?.(event.name, event.ok, event.input);
                    break;
                case 'file':
                    handlers.onFile?.(event.name, event.rel, event.downloadUrl);
                    break;
                case 'agent_step':
                    handlers.onAgentStep?.(event);
                    break;
                case 'memory_proposal':
                    handlers.onMemoryProposal?.(event.proposals);
                    break;
                case 'error':
                    handlers.onError?.(event.message, event.code);
                    break;
                case 'done':
                    handlers.onDone?.(event.messageId, event.inputTokens, event.outputTokens);
                    break;
                // 'connected' and 'agent_team_start' are handshake/no-op for the CLI.
            }
        };

        while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) dispatch(line);
        }
        buffer += decoder.decode();
        if (buffer) dispatch(buffer);
    },
};
