// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import chalk from 'chalk';
import type readline from 'node:readline';
import {chatsApi} from './api/chats.js';
import {messagesApi} from './api/messages.js';
import {ApiError} from './api/http.js';
import type {CliConfig} from './config.js';
import type {Chat} from './types.js';
import {ask, createInterface} from './ui/prompt.js';
import {formatTokens, previewInput, printMessage, renderMarkdown} from './ui/render.js';

const HISTORY_PREVIEW = 10;

const HELP = `
Commands:
  /chats          list your chats and switch to one
  /new [title]    create a new chat and switch to it
  /history [n]    show the last n messages of this chat (default 20)
  /title <text>   rename the current chat
  /quit           exit (also /exit, Ctrl+D)
Anything else is sent as a message. Ctrl+C while the assistant is
responding stops the generation; at the prompt it exits.
`.trim();

function chatLine(chat: Chat, index?: number): string {
    const idx = index !== undefined ? chalk.dim(`${String(index).padStart(3)}. `) : '';
    const when = chalk.dim(new Date(chat.updatedAt).toLocaleString());
    return `${idx}${chat.title || chalk.dim('(untitled)')}  ${when}  ${chalk.dim(chat.id)}`;
}

/** Interactive chat picker: choose by number, or Enter/`n` for a new chat. */
export async function pickChat(cfg: CliConfig, rl: readline.Interface): Promise<Chat | null> {
    const chats = await chatsApi.list(cfg);
    if (chats.length === 0) {
        console.log(chalk.dim('No chats yet — creating a new one.'));
        return chatsApi.create(cfg);
    }
    console.log(chalk.bold('Your chats:'));
    chats.slice(0, 20).forEach((chat, i) => console.log(chatLine(chat, i + 1)));
    const answer = await ask(rl, `Pick a number, ${chalk.bold('n')} for new, or Enter for the latest: `);
    if (answer.toLowerCase() === 'n') return chatsApi.create(cfg);
    if (answer === '') return chats[0];
    const idx = Number.parseInt(answer, 10);
    if (Number.isNaN(idx) || idx < 1 || idx > Math.min(chats.length, 20)) {
        console.log(chalk.red('Invalid selection.'));
        return null;
    }
    return chats[idx - 1];
}

async function showHistory(cfg: CliConfig, chat: Chat, count: number): Promise<void> {
    const messages = await messagesApi.list(cfg, chat.id);
    if (messages.length === 0) {
        console.log(chalk.dim('(empty chat)'));
        return;
    }
    console.log();
    for (const msg of messages.slice(-count)) printMessage(msg);
}

interface StreamOutcome {
    aborted: boolean;
}

async function streamTurn(
    cfg: CliConfig,
    chat: Chat,
    content: string,
    controller: AbortController,
): Promise<StreamOutcome> {
    const out = process.stdout;
    let needsNewline = false;
    out.write(`\n${chalk.cyan.bold('assistant')}\n`);
    try {
        await messagesApi.stream(
            cfg,
            chat.id,
            content,
            {
                onChunk: (text) => {
                    out.write(text);
                    needsNewline = true;
                },
                onToolCall: (call) => {
                    if (needsNewline) out.write('\n');
                    needsNewline = false;
                    out.write(chalk.dim(`⚙ ${call.name} ${previewInput(call.input)}\n`));
                },
                onToolResult: (name, ok) => {
                    if (needsNewline) out.write('\n');
                    needsNewline = false;
                    out.write(chalk.dim(`${ok ? '✓' : chalk.red('✗')} ${name}\n`));
                },
                onFile: (name, _rel, downloadUrl) => {
                    if (needsNewline) out.write('\n');
                    needsNewline = false;
                    const link = downloadUrl ? ` → ${cfg.baseUrl}${downloadUrl}` : '';
                    out.write(chalk.dim(`📄 ${name}${link}\n`));
                },
                onAgentStep: (step) => {
                    if (needsNewline) out.write('\n');
                    needsNewline = false;
                    const role = step.role ? chalk.dim(` · ${step.role}`) : '';
                    out.write(`${chalk.magenta.bold(`[${step.agent}]`)}${role}\n`);
                    out.write(`${renderMarkdown(step.output)}\n`);
                },
                onMemoryProposal: (proposals) => {
                    if (needsNewline) out.write('\n');
                    needsNewline = false;
                    out.write(chalk.dim(`☆ ${proposals.length} memory proposal(s) — review them in the web UI\n`));
                },
                onError: (message, code) => {
                    if (needsNewline) out.write('\n');
                    needsNewline = false;
                    out.write(chalk.red(`⚠ ${code ? `[${code}] ` : ''}${message}\n`));
                },
                onDone: (_messageId, inputTokens, outputTokens) => {
                    if (needsNewline) out.write('\n');
                    needsNewline = false;
                    out.write(`${formatTokens(inputTokens, outputTokens)}\n`);
                },
            },
            controller.signal,
        );
        return {aborted: false};
    } catch (err) {
        if (needsNewline) out.write('\n');
        if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            out.write(chalk.yellow('⏹ generation stopped\n'));
            return {aborted: true};
        }
        throw err;
    }
}

export async function runRepl(cfg: CliConfig, initialChat: Chat): Promise<void> {
    let chat = initialChat;
    const rl = createInterface();
    let streaming: AbortController | null = null;

    // Queue-based input instead of rl.question(): lines typed while the
    // assistant is streaming (or piped in before the first prompt) are kept
    // and processed in order instead of being silently dropped.
    const inputQueue: string[] = [];
    let pendingResolve: ((line: string | null) => void) | null = null;
    let ended = false;

    rl.on('line', (line) => {
        if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve(line);
        } else {
            inputQueue.push(line);
        }
    });
    rl.on('close', () => {
        ended = true;
        if (pendingResolve) {
            const resolve = pendingResolve;
            pendingResolve = null;
            resolve(null);
        }
    });
    rl.on('SIGINT', () => {
        if (streaming) {
            streaming.abort();
        } else {
            rl.close();
        }
    });

    const nextLine = (): Promise<string | null> => {
        if (inputQueue.length > 0) return Promise.resolve(inputQueue.shift()!);
        if (ended) return Promise.resolve(null);
        rl.setPrompt(chalk.green('› '));
        rl.prompt();
        return new Promise((resolve) => {
            pendingResolve = resolve;
        });
    };

    console.log(chalk.bold(`\nChat: ${chat.title || '(untitled)'}`) + chalk.dim(`  ${chat.id}`));
    console.log(chalk.dim(`Connected to ${cfg.baseUrl} as ${cfg.user?.email ?? '?'} — /help for commands`));
    await showHistory(cfg, chat, HISTORY_PREVIEW);

    while (true) {
        const raw = await nextLine();
        if (raw === null) break;
        const line = raw.trim();
        if (!line) continue;

        try {
            if (line === '/quit' || line === '/exit') break;
            if (line === '/help') {
                console.log(HELP);
            } else if (line === '/chats') {
                const picked = await pickChat(cfg, rl);
                if (picked) {
                    chat = picked;
                    console.log(chalk.bold(`Switched to: ${chat.title || '(untitled)'}`) + chalk.dim(`  ${chat.id}`));
                    await showHistory(cfg, chat, HISTORY_PREVIEW);
                }
            } else if (line.startsWith('/new')) {
                const title = line.slice(4).trim() || undefined;
                chat = await chatsApi.create(cfg, title);
                console.log(chalk.bold(`New chat: ${chat.title || '(untitled)'}`) + chalk.dim(`  ${chat.id}`));
            } else if (line.startsWith('/history')) {
                const count = Number.parseInt(line.slice(8).trim(), 10);
                await showHistory(cfg, chat, Number.isNaN(count) ? 20 : count);
            } else if (line.startsWith('/title ')) {
                const title = line.slice(7).trim();
                if (title) {
                    chat = await chatsApi.rename(cfg, chat.id, title);
                    console.log(chalk.dim(`Renamed to: ${chat.title}`));
                }
            } else if (line.startsWith('/')) {
                console.log(chalk.red(`Unknown command: ${line.split(' ')[0]}`) + chalk.dim(' — /help for commands'));
            } else {
                streaming = new AbortController();
                try {
                    await streamTurn(cfg, chat, line, streaming);
                } finally {
                    streaming = null;
                }
            }
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                console.error(chalk.red('Session expired. Run `arkimede login` again.'));
                break;
            }
            console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        }
    }

    if (!ended) rl.close();
    console.log(chalk.dim('Bye.'));
}
