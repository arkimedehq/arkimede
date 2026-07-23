// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import chalk from 'chalk';
import {marked} from 'marked';
import {markedTerminal} from 'marked-terminal';
import type {Message} from '../types.js';

marked.use(markedTerminal() as Parameters<typeof marked.use>[0]);

/** Render assistant Markdown for terminal display. */
export function renderMarkdown(text: string): string {
    try {
        return String(marked.parse(text)).trimEnd();
    } catch {
        return text;
    }
}

const MAX_INPUT_PREVIEW = 120;

/** Compact single-line preview of a tool input for status lines. */
export function previewInput(input: unknown): string {
    if (input === undefined || input === null) return '';
    let text: string;
    try {
        text = typeof input === 'string' ? input : JSON.stringify(input);
    } catch {
        return '';
    }
    text = text.replace(/\s+/g, ' ');
    return text.length > MAX_INPUT_PREVIEW ? `${text.slice(0, MAX_INPUT_PREVIEW)}…` : text;
}

export function formatTokens(input?: number | null, output?: number | null): string {
    return chalk.dim(`[tokens ↑${input ?? '–'} ↓${output ?? '–'}]`);
}

export function printMessage(msg: Message): void {
    const when = chalk.dim(new Date(msg.createdAt).toLocaleString());
    if (msg.role === 'user') {
        const author = msg.authorName ? ` ${msg.authorName}` : '';
        console.log(`${chalk.green.bold(`you${author}`)} ${when}`);
        console.log(msg.content.trimEnd());
    } else if (msg.role === 'assistant') {
        console.log(`${chalk.cyan.bold('assistant')} ${when}`);
        for (const call of msg.toolCalls ?? []) {
            console.log(chalk.dim(`  ${call.ok === false ? '✗' : '⚙'} ${call.name} ${previewInput(call.input)}`));
        }
        console.log(renderMarkdown(msg.content));
    } else {
        console.log(`${chalk.yellow.bold('system')} ${when}`);
        console.log(chalk.dim(msg.content.trimEnd()));
    }
    console.log();
}
