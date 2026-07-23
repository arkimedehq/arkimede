// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {AuthUser} from './types.js';

export interface CliConfig {
    baseUrl: string;
    token?: string;
    user?: AuthUser;
}

export const DEFAULT_BASE_URL = 'http://localhost:3000';

const configDir =
    process.env.ARKIMEDE_CONFIG_DIR || path.join(os.homedir(), '.config', 'arkimede');
const configPath = path.join(configDir, 'config.json');

export function loadConfig(): CliConfig {
    try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<CliConfig>;
        return {baseUrl: parsed.baseUrl || DEFAULT_BASE_URL, token: parsed.token, user: parsed.user};
    } catch {
        return {baseUrl: process.env.ARKIMEDE_URL || DEFAULT_BASE_URL};
    }
}

export function saveConfig(cfg: CliConfig): void {
    fs.mkdirSync(configDir, {recursive: true, mode: 0o700});
    // The file holds the JWT: keep it readable by the owner only.
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', {mode: 0o600});
    fs.chmodSync(configPath, 0o600);
}

export function clearAuth(cfg: CliConfig): CliConfig {
    const next: CliConfig = {baseUrl: cfg.baseUrl};
    saveConfig(next);
    return next;
}

export function configFilePath(): string {
    return configPath;
}
