/**
 * @file datetime.util.ts
 *
 * Utility to format the current instant in an IANA timezone as an ISO 8601
 * string *with offset* (e.g. `2026-06-08T18:51:00+02:00`).
 *
 * It gives the agent an absolute, unambiguous time reference: without it the model
 * does not know "what time it is now" and, for relative requests ("in 3 minutes",
 * "tomorrow at 8"), it hallucinates a timestamp — typically in the past, and a
 * one-shot automation with a past `runAt` is never registered.
 */

/** Default timezone applied when none is specified. Override via env. */
export const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Europe/Rome';

/**
 * Formats `date` as ISO 8601 with offset, in the IANA timezone `tz`.
 * Example: `isoWithOffset(new Date(), 'Europe/Rome')` → `2026-06-08T18:51:00+02:00`.
 * On an invalid timezone it falls back to the UTC ISO (`...Z`) without throwing.
 */
export function isoWithOffset(date: Date = new Date(), tz: string = DEFAULT_TIMEZONE): string {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value])) as Record<string, string>;
    // Offset = (wall-clock time in the tz interpreted as UTC) − real instant.
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    const offsetMin = Math.round((asUTC - date.getTime()) / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const oh = String(Math.floor(abs / 60)).padStart(2, '0');
    const om = String(abs % 60).padStart(2, '0');
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${oh}:${om}`;
  } catch {
    return date.toISOString();
  }
}
