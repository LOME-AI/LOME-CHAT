/**
 * Period key for the free-tier daily allowance (and the trial daily cap):
 * UTC-keyed rows, upserted at charge time. Rollover is a new key by
 * construction — reading a fresh period needs no mutation and there are no
 * reset jobs. Group budgets are durable/cumulative, not period-keyed.
 */

/** UTC calendar day, `YYYY-MM-DD` (the allowance_spending.day format). */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
