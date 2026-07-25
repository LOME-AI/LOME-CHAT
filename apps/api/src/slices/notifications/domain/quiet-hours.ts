/**
 * Quiet-hours evaluation. A user's window is stored as local minutes-of-day
 * plus an IANA timezone; suppression is "is `now` inside [start, end) in that
 * zone". Evaluated against `Intl.DateTimeFormat` with an explicit `timeZone`,
 * which the production workerd runtime honors for arbitrary IANA zones,
 * including DST transitions and half-hour offsets. UTC offsets are deliberately
 * not used — they silently break across DST.
 */

/** Reused per zone; `Intl.DateTimeFormat` construction is comparatively costly. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached !== undefined) {
    return cached;
  }
  // `hourCycle: 'h23'` forces 00–23 so midnight reads as hour 0, never 24.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

/**
 * The local minute-of-day (0–1439) of `now` in `timezone`. Throws if the zone
 * is not a recognized IANA identifier — a fail-fast the write boundary already
 * prevents by validating the timezone at save time.
 */
export function localMinutesOfDay(now: Date, timezone: string): number {
  const parts = formatterFor(timezone).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

/**
 * Whether `now` falls inside the half-open window [start, end) evaluated in
 * `timezone`. A cross-midnight window (start > end) is the union of its two
 * arms; a zero-length window (start === end) is empty and never suppresses.
 */
export function isWithinQuietHours(
  now: Date,
  startMinutes: number,
  endMinutes: number,
  timezone: string
): boolean {
  if (startMinutes === endMinutes) {
    return false;
  }
  const nowMinutes = localMinutesOfDay(now, timezone);
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }
  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}
