// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import type {CliConfig} from '../config.js';
import type {LoginResponse, UserProfile} from '../types.js';
import {apiFetch} from './http.js';

export const authApi = {
    login: (cfg: CliConfig, email: string, password: string) =>
        apiFetch<LoginResponse>(cfg, '/api/auth/login', {method: 'POST', body: {email, password}}),

    /** Server-side logout is an audit record only; the JWT is stateless. */
    logout: async (cfg: CliConfig): Promise<void> => {
        try {
            await apiFetch<void>(cfg, '/api/auth/logout', {method: 'POST'});
        } catch {
            // Best effort: dropping the token locally is what actually logs out.
        }
    },

    me: (cfg: CliConfig) => apiFetch<UserProfile>(cfg, '/api/users/me'),
};
