#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import chalk from 'chalk';
import {Command} from 'commander';
import {authApi} from './api/auth.js';
import {chatsApi} from './api/chats.js';
import {ApiError} from './api/http.js';
import {clearAuth, configFilePath, loadConfig, saveConfig, type CliConfig} from './config.js';
import {pickChat, runRepl} from './repl.js';
import {ask, askHidden, createInterface} from './ui/prompt.js';

function requireAuth(cfg: CliConfig): void {
    if (!cfg.token) {
        console.error(chalk.red('Not logged in. Run `arkimede login` first.'));
        process.exit(1);
    }
}

function fail(err: unknown): never {
    if (err instanceof ApiError && err.status === 401) {
        console.error(chalk.red('Unauthorized — your session may have expired. Run `arkimede login`.'));
    } else {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
    }
    process.exit(1);
}

const program = new Command();
program
    .name('arkimede')
    .description('Arkimede terminal client — login and chat from your shell')
    .version('0.1.0');

program
    .command('login')
    .description('authenticate against an Arkimede backend and store the session')
    .option('--url <baseUrl>', 'backend base URL (e.g. http://localhost:3000)')
    .option('--email <email>', 'account email')
    .action(async (opts: { url?: string; email?: string }) => {
        const cfg = loadConfig();
        if (opts.url) cfg.baseUrl = opts.url.replace(/\/$/, '');
        const rl = createInterface();
        try {
            console.log(chalk.dim(`Backend: ${cfg.baseUrl}`));
            const email = opts.email || (await ask(rl, 'Email: '));
            rl.pause();
            const password = await askHidden('Password: ');
            const {access_token, user} = await authApi.login(cfg, email, password);
            saveConfig({baseUrl: cfg.baseUrl, token: access_token, user});
            console.log(chalk.green(`Logged in as ${user.name} <${user.email}> (${user.role})`));
            console.log(chalk.dim(`Session stored in ${configFilePath()}`));
        } catch (err) {
            // On login a 401 means bad credentials, not an expired session:
            // surface the backend's own message.
            if (err instanceof ApiError) {
                console.error(chalk.red(err.message));
                process.exit(1);
            }
            fail(err);
        } finally {
            rl.close();
        }
    });

program
    .command('logout')
    .description('drop the stored session')
    .action(async () => {
        const cfg = loadConfig();
        if (cfg.token) await authApi.logout(cfg);
        clearAuth(cfg);
        console.log(chalk.green('Logged out.'));
    });

program
    .command('whoami')
    .description('show the current session and verify it against the backend')
    .action(async () => {
        const cfg = loadConfig();
        requireAuth(cfg);
        try {
            const me = await authApi.me(cfg);
            console.log(`${me.name} <${me.email}> (${me.role})`);
            console.log(chalk.dim(`Backend: ${cfg.baseUrl} — token valid`));
        } catch (err) {
            fail(err);
        }
    });

program
    .command('chats')
    .description('list your chats')
    .action(async () => {
        const cfg = loadConfig();
        requireAuth(cfg);
        try {
            const chats = await chatsApi.list(cfg);
            if (chats.length === 0) {
                console.log(chalk.dim('No chats yet. Start one with `arkimede chat --new`.'));
                return;
            }
            for (const chat of chats) {
                const when = chalk.dim(new Date(chat.updatedAt).toLocaleString());
                console.log(`${chat.title || chalk.dim('(untitled)')}  ${when}  ${chalk.dim(chat.id)}`);
            }
        } catch (err) {
            fail(err);
        }
    });

program
    .command('chat', {isDefault: true})
    .description('open the interactive chat (default command)')
    .option('--new [title]', 'start a new chat')
    .option('--last', 'resume the most recent chat')
    .option('--chat <id>', 'open a specific chat by id')
    .option('--plain', 'line-based REPL instead of the full-screen TUI')
    .action(async (opts: { new?: string | boolean; last?: boolean; chat?: string; plain?: boolean }) => {
        const cfg = loadConfig();
        requireAuth(cfg);
        // The full-screen TUI needs a real terminal (raw mode); fall back to
        // the plain REPL when stdin/stdout are piped.
        const plain = opts.plain || !process.stdin.isTTY || !process.stdout.isTTY;
        try {
            let chat;
            if (opts.new !== undefined) {
                chat = await chatsApi.create(cfg, typeof opts.new === 'string' ? opts.new : undefined);
            } else if (opts.chat) {
                chat = await chatsApi.get(cfg, opts.chat);
            } else if (opts.last || !plain) {
                // The TUI has its own chat sidebar: just open the most recent.
                const chats = await chatsApi.list(cfg);
                chat = chats[0] ?? (await chatsApi.create(cfg));
            } else {
                const rl = createInterface();
                chat = await pickChat(cfg, rl);
                rl.close();
                if (!chat) process.exit(1);
            }
            if (plain) {
                await runRepl(cfg, chat);
            } else {
                const {runTui} = await import('./tui/index.js');
                await runTui(cfg, chat);
            }
            process.exit(0);
        } catch (err) {
            fail(err);
        }
    });

program.parseAsync(process.argv).catch(fail);
