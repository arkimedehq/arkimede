// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import fs from 'node:fs';

/** Append a line to the file named by ARKIMEDE_DEBUG; no-op when unset. */
export function dbg(message: string): void {
    const file = process.env.ARKIMEDE_DEBUG;
    if (!file) return;
    try {
        fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
        // Debugging must never break the app.
    }
}
