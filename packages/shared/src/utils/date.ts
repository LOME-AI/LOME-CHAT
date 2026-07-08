/**
 * Date utilities for consistent time handling across the application.
 * Single source of truth for UTC midnight calculations and reset logic.
 */

/**
 * Get the start of the current UTC day (midnight).
 * Used for daily reset logic (free allowance, trial usage, etc.)
 *
 * @returns Date object representing 00:00:00.000 UTC of the current day
 */
export function getUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Calculate seconds remaining until the next UTC midnight.
 * Used as TTL for Redis keys that should expire at daily reset.
 *
 * @param now - Reference instant; defaults to the current wall clock. Callers
 *   that derive a period key from an injected clock pass that same clock here so
 *   the key-day and the TTL never read two different time sources.
 * @returns Number of seconds until 00:00:00.000 UTC of the next day (always >= 1)
 */
export function secondsUntilNextUtcMidnight(now: Date = new Date()): number {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  );
  return Math.ceil((tomorrow.getTime() - now.getTime()) / 1000);
}

/**
 * Check if a timestamp is before the current UTC midnight.
 * Used for lazy reset patterns - returns true if reset is needed.
 *
 * @param resetAt - The last reset timestamp, or null if never reset
 * @returns true if resetAt is null or before today's UTC midnight
 */
export function needsResetBeforeMidnight(resetAt: Date | null): boolean {
  if (resetAt === null) {
    return true;
  }
  const midnight = getUtcMidnight();
  return resetAt < midnight;
}
