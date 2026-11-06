// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/** A skill's user channel (SKILL.md `user-channel`): a messaging channel the host runs with no model in between. */
import { describe, it, expect } from 'vitest';
import { parseUserChannel } from '../../src/skills/skills.service';

describe('parseUserChannel', () => {
  it('reads kind, channel, script and whom it reaches (the user only, by default)', () => {
    expect(parseUserChannel({ kind: 'messaging', channel: 'telegram', script: 'scripts/send_message.js', reaches: ['self', 'contacts', 'everyone'] }))
      .toEqual({ kind: 'messaging', channel: 'telegram', script: 'scripts/send_message.js', reaches: ['self', 'contacts'] });
    expect(parseUserChannel({ kind: 'messaging', channel: ' whatsapp ', script: 'scripts/send.py' }))
      .toEqual({ kind: 'messaging', channel: 'whatsapp', script: 'scripts/send.py', reaches: ['self'] });
  });

  it('is null when absent or malformed', () => {
    for (const raw of [undefined, null, 'telegram', { kind: 'voice', channel: 'x', script: 'y' }, { kind: 'messaging', script: 'y' }, { kind: 'messaging', channel: 'x' }]) {
      expect(parseUserChannel(raw)).toBeNull();
    }
  });
});
