// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Whom an extension is for (specs/EXTENSION_AUDIENCE.md): `personal` — it uses one person's account, data or memory
 * (a Telegram account, a mailbox, a camera plugin writing to a memory): each user installs their own copy, never shared
 * with a team or the organization; `shared` — generic (web search, a company CRM). Undeclared means shared.
 */
export type Audience = 'personal' | 'shared';

export function parseAudience(value: unknown): Audience | undefined {
  return value === 'personal' || value === 'shared' ? value : undefined;
}
