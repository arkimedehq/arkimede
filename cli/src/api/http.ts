// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import type {CliConfig} from '../config.js';

export class ApiError extends Error {
    constructor(
        message: string,
        public readonly status: number,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

/** Language hint for backend i18n error messages, derived from the shell locale. */
function acceptLanguage(): string {
    const lang = process.env.LC_ALL || process.env.LANG || '';
    return lang.toLowerCase().startsWith('it') ? 'it' : 'en';
}

export function buildHeaders(cfg: CliConfig, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
        'Accept-Language': acceptLanguage(),
        ...extra,
    };
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    return headers;
}

export function apiUrl(cfg: CliConfig, pathname: string): string {
    return `${cfg.baseUrl.replace(/\/$/, '')}${pathname}`;
}

async function parseErrorMessage(response: Response): Promise<string> {
    try {
        const body = (await response.json()) as { message?: string | string[] };
        if (Array.isArray(body.message)) return body.message.join('; ');
        if (body.message) return body.message;
    } catch {
        // Non-JSON error body: fall through to the status line.
    }
    return `HTTP ${response.status} ${response.statusText}`;
}

/** JSON request helper for all non-streaming endpoints. */
export async function apiFetch<T>(
    cfg: CliConfig,
    pathname: string,
    init?: { method?: string; body?: unknown },
): Promise<T> {
    const response = await fetch(apiUrl(cfg, pathname), {
        method: init?.method ?? 'GET',
        headers: buildHeaders(
            cfg,
            init?.body !== undefined ? {'Content-Type': 'application/json'} : undefined,
        ),
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    if (!response.ok) throw new ApiError(await parseErrorMessage(response), response.status);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
}
