// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

export interface AuthUser {
    id: string;
    email: string;
    name: string;
    role: 'admin' | 'user';
}

export interface LoginResponse {
    access_token: string;
    user: AuthUser;
}

/** Profile returned by GET /api/users/me; fields beyond AuthUser are optional. */
export interface UserProfile extends AuthUser {
    language?: string | null;
    systemPrompt?: string | null;
    toolLoadingStrategy?: string | null;
    toolLoadingMaxTools?: number | null;
    maxHistoryTokens?: number | null;
    showTokenCount?: boolean;
    autoMemoryEnabled?: boolean;
    createdAt?: string;
}

export interface Chat {
    id: string;
    title: string;
    projectId?: string | null;
    agentTeamId?: string | null;
    authorId?: string;
    authorName?: string;
    createdAt: string;
    updatedAt: string;
    totalInputTokens?: number;
    totalOutputTokens?: number;
}

export interface MessageAttachment {
    name: string;
    fileId: string;
    mimeType: string;
    mode?: 'embed' | 'inline' | 'attachment';
}

export interface ToolCallRecord {
    name: string;
    input?: unknown;
    output?: string;
    ok?: boolean;
    startedAt?: string;
    durationMs?: number;
}

export interface Message {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    authorId?: string;
    authorName?: string;
    attachments?: MessageAttachment[];
    toolCalls?: ToolCallRecord[];
    inputTokens?: number | null;
    outputTokens?: number | null;
    createdAt: string;
}

/** Callbacks for the SSE message stream; all optional except the terminal ones. */
export interface StreamHandlers {
    onChunk?: (content: string) => void;
    onToolCall?: (call: { name: string; input?: unknown }) => void;
    onToolResult?: (name: string, ok: boolean, input?: unknown) => void;
    onFile?: (name: string, rel?: string, downloadUrl?: string) => void;
    onAgentStep?: (step: { agent: string; role?: string | null; output: string }) => void;
    onMemoryProposal?: (proposals: { id: string; content: string }[]) => void;
    onError?: (message: string, code?: string) => void;
    onDone?: (messageId: string | null, inputTokens?: number | null, outputTokens?: number | null) => void;
}
