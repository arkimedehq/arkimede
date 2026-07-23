// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import type {CliConfig} from '../config.js';
import type {Chat, Message} from '../types.js';
import {apiFetch} from './http.js';

export const chatsApi = {
    list: (cfg: CliConfig) => apiFetch<Chat[]>(cfg, '/api/chats'),

    get: (cfg: CliConfig, chatId: string) =>
        apiFetch<Chat & { messages?: Message[] }>(cfg, `/api/chats/${chatId}`),

    create: (cfg: CliConfig, title?: string) =>
        apiFetch<Chat>(cfg, '/api/chats', {method: 'POST', body: title ? {title} : {}}),

    rename: (cfg: CliConfig, chatId: string, title: string) =>
        apiFetch<Chat>(cfg, `/api/chats/${chatId}/title`, {method: 'PATCH', body: {title}}),

    remove: (cfg: CliConfig, chatId: string) =>
        apiFetch<{ deleted: boolean }>(cfg, `/api/chats/${chatId}`, {method: 'DELETE'}),
};
