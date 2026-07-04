/**
 * Period keys for budgets and the free-tier allowance: UTC-keyed rows,
 * upserted at charge time. Rollover is a new key by construction — reading a
 * fresh period needs no mutation and there are no reset jobs.
 */

/** UTC calendar day, `YYYY-MM-DD` (the allowance_spending.day format). */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC calendar month, `YYYY-MM` (the member/conversation budget format). */
export function utcMonthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
