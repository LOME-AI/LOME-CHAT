/**
 * The user-selectable windows for the public usage-stats page. Single source
 * of truth for the builder cron, the wire schema's window keys, and the
 * marketing UI's window selector — adding a window is exactly one new entry
 * in WINDOW_DAYS; trend bucket and delta availability derive from its length.
 */
const WINDOW_DAYS = {
  '7d': 7,
  '30d': 30,
  all: null,
} as const;

export type UsageStatsWindowKey = keyof typeof WINDOW_DAYS;

export const USAGE_STATS_TREND_BUCKETS = ['day', 'month'] as const;

export type UsageStatsTrendBucket = (typeof USAGE_STATS_TREND_BUCKETS)[number];

export interface UsageStatsWindow {
  readonly key: UsageStatsWindowKey;
  /** Window length in days; null means all-time (unbounded). */
  readonly days: number | null;
  readonly trendBucket: UsageStatsTrendBucket;
  /** All-time has no prior equal-length window, so no deltas exist for it. */
  readonly hasDelta: boolean;
}

function trendBucketFor(days: number | null): UsageStatsTrendBucket {
  return days !== null && days <= 31 ? 'day' : 'month';
}

export const USAGE_STATS_WINDOW_KEYS = Object.keys(WINDOW_DAYS) as [
  UsageStatsWindowKey,
  ...UsageStatsWindowKey[],
];

export const USAGE_STATS_WINDOWS: readonly UsageStatsWindow[] = USAGE_STATS_WINDOW_KEYS.map(
  (key) => {
    const days = WINDOW_DAYS[key];
    return { key, days, trendBucket: trendBucketFor(days), hasDelta: days !== null };
  }
);
