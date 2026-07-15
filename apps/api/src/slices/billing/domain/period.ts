/**
 * Period key for the free-tier daily allowance (and the trial daily cap):
 * UTC-keyed rows, upserted at charge time. Rollover is a new key by
 * construction — reading a fresh period needs no mutation and there are no
 * reset jobs. Group budgets are durable/cumulative, not period-keyed.
 *
 * `utcDayKey` (the `allowance_spending.day` format) is the shared UTC-calendar-day
 * helper; re-exported here so the billing period key and its callers keep one
 * import path.
 */
export { utcDayKey } from '@hushbox/shared';
