// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {render} from 'ink';
import React from 'react';
import type {CliConfig} from '../config.js';
import type {Chat} from '../types.js';
import App from './App.js';
import {dbg} from './debug.js';

export async function runTui(cfg: CliConfig, initialChat: Chat): Promise<void> {
    dbg(`runTui: rendering (stdin isTTY=${String(process.stdin.isTTY)})`);
    const heartbeat = process.env.ARKIMEDE_DEBUG
        ? setInterval(() => dbg('heartbeat: event loop alive'), 1000)
        : null;
    const {waitUntilExit} = render(<App cfg={cfg} initialChat={initialChat} />, {exitOnCtrlC: true});
    dbg('runTui: render() returned');
    try {
        await waitUntilExit();
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        dbg('runTui: exited');
    }
}
