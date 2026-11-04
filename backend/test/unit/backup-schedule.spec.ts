// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import { describe, it, expect } from 'vitest';
import { isValidBackupSchedule, DEFAULT_BACKUP_SCHEDULE } from '../../src/backup/backup-schedule';

describe('host backup schedule (cron)', () => {
  it.each([
    DEFAULT_BACKUP_SCHEDULE, '0 */6 * * *', '30 1,13 * * *', '0 3 * * 1-5', '0 4 1 * *',
    '0 22 * * 0', '0 22 * * 7', '45 0-23/4 * 1-12 *', '0,30 9 * * *',
  ])('accepts %s', (e) => expect(isValidBackupSchedule(e)).toBe(true));

  it.each([
    '* 2 * * *', '*/15 * * * *', '60 2 * * *', '0 24 * * *', '0 2 0 * *', '0 2 * 13 *', '0 2 * * 8',
    '0 2 * *', '0 2 * * * *', '@daily', '0 2 * * MON', '0 5-3 * * *', '0 2/3 * * *', '0 */0 * * *', '',
  ])('rejects %s', (e) => expect(isValidBackupSchedule(e)).toBe(false));
});
