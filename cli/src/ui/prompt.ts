// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import readline from 'node:readline';

export function createInterface(): readline.Interface {
    return readline.createInterface({input: process.stdin, output: process.stdout});
}

export function ask(rl: readline.Interface, query: string): Promise<string> {
    return new Promise((resolve) => rl.question(query, (answer) => resolve(answer.trim())));
}

/** Prompt for a secret without echoing it (password input). */
export function askHidden(query: string): Promise<string> {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        stdout.write(query);
        const wasRaw = stdin.isTTY ? stdin.isRaw : false;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        let value = '';

        const cleanup = () => {
            stdin.off('data', onData);
            if (stdin.isTTY) stdin.setRawMode(wasRaw);
            stdin.pause();
        };

        const onData = (buf: Buffer) => {
            for (const ch of buf.toString('utf8')) {
                if (ch === '\r' || ch === '\n') {
                    cleanup();
                    stdout.write('\n');
                    resolve(value);
                    return;
                }
                if (ch === '\u0003') {
                    // Ctrl+C while typing a secret aborts the whole command.
                    cleanup();
                    stdout.write('\n');
                    process.exit(130);
                }
                if (ch === '\u007f' || ch === '\b') {
                    value = value.slice(0, -1);
                    continue;
                }
                value += ch;
            }
        };

        stdin.on('data', onData);
    });
}
