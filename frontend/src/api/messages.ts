import type {Message} from '../store/useStore';
import {useStore} from '../store/useStore';
import api from './client';

export const messagesApi = {
    list: (chatId: string) =>
        api.get<Message[]>(`/chats/${chatId}/messages`).then((r) => r.data),

    /** Truncate/rewind: deletes the indicated message and all following ones. */
    truncateFrom: (chatId: string, messageId: string) =>
        api.delete<{ deletedCount: number }>(`/chats/${chatId}/messages/${messageId}`).then((r) => r.data),

    stream: async (
        chatId: string,
        content: string,
        attachments: { name: string; fileId: string; mimeType: string }[],
        onChunk: (chunk: string) => void,
        onToolCall: (call: any) => void,
        onDone: (messageId: string, inputTokens?: number | null, outputTokens?: number | null) => void,
        onError: (msg: string, code?: string) => void,
        signal?: AbortSignal,
        onFile?: (name: string, rel: string | undefined, downloadUrl?: string) => void,
        onToolResult?: (name: string, ok: boolean, input?: any) => void,
        onMemoryProposal?: (proposals: { id: string; content: string }[]) => void,
        onAgentStep?: (step: { agent: string; role?: string | null; output: string }) => void,
    ) => {
        const token = useStore.getState().token;

        const backendUrl = (import.meta as any).env?.VITE_BACKEND_URL as string | undefined;
        const baseUrl = backendUrl
            ? `${backendUrl.replace(/\/$/, '')}/api`
            : ((import.meta as any).env?.VITE_API_URL as string | undefined) ?? '/api';

        const response = await fetch(`${baseUrl}/chats/${chatId}/messages/stream`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({content, attachments}),
            signal,
        });

        if (!response.ok) throw new Error('Request error');

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const {value, done} = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, {stream: true});
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const event = JSON.parse(line.slice(6));
                    if (event.type === 'chunk') onChunk(event.content);
                    else if (event.type === 'tool_call') onToolCall(event.toolCall);
                    else if (event.type === 'done') onDone(event.messageId, event.inputTokens, event.outputTokens);
                    else if (event.type === 'error') onError(event.message, event.code);
                    else if (event.type === 'file' && onFile) onFile(event.name, event.rel, event.downloadUrl);
                    else if (event.type === 'tool_result' && onToolResult) onToolResult(event.name, event.ok, event.input);
                    else if (event.type === 'memory_proposal' && onMemoryProposal) onMemoryProposal(event.proposals);
                    else if (event.type === 'agent_step' && onAgentStep) onAgentStep(event);
                } catch {
                }
            }
        }
    },
};
