// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/**
 * Schedule of the host snapshots: a standard 5-field cron expression
 * (minute hour day-of-month month day-of-week, host local time), evaluated every minute by
 * `scripts/backup.sh tick`, which implements the same grammar in bash:
 *   `*`, `n`, `a-b`, a step `/n` after `*` or after a range, and comma lists of those;
 *   day-of-week 0-7 (0 and 7 = Sunday).
 * Names (MON, JAN) and macros (@daily) are not supported. The minute must be fixed (no `*` and
 * no step), so a full snapshot runs at most once an hour.
 */
export const DEFAULT_BACKUP_SCHEDULE = '15 2 * * *';

const FIELDS: Array<[min: number, max: number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function validItem(item: string, min: number, max: number): boolean {
  const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
  if (!m) return false;
  const [, , a, b, step] = m;
  if (step !== undefined && Number(step) < 1) return false;
  if (a === undefined) return true;                       // * or */n
  const lo = Number(a), hi = b === undefined ? lo : Number(b);
  if (step !== undefined && b === undefined) return false; // "5/10": ambiguous, not accepted
  return lo >= min && hi <= max && lo <= hi;
}

export function isValidBackupSchedule(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  if (!/^\d+(,\d+)*$/.test(parts[0])) return false;        // fixed minute(s)
  return parts.every((field, i) => field.split(',').every((it) => validItem(it, ...FIELDS[i])));
}
