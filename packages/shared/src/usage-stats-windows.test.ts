import { describe, it, expect } from 'vitest';
import { USAGE_STATS_WINDOWS, USAGE_STATS_WINDOW_KEYS } from './usage-stats-windows.js';

describe('USAGE_STATS_WINDOW_KEYS', () => {
  it('lists exactly the three window keys in display order', () => {
    expect(USAGE_STATS_WINDOW_KEYS).toEqual(['7d', '30d', 'all']);
  });
});

describe('USAGE_STATS_WINDOWS', () => {
  it('has one entry per window key, in key order', () => {
    expect(USAGE_STATS_WINDOWS.map((w) => w.key)).toEqual([...USAGE_STATS_WINDOW_KEYS]);
  });

  it('defines 7 days for the 7d window', () => {
    expect(USAGE_STATS_WINDOWS.find((w) => w.key === '7d')?.days).toBe(7);
  });

  it('defines 30 days for the 30d window', () => {
    expect(USAGE_STATS_WINDOWS.find((w) => w.key === '30d')?.days).toBe(30);
  });

  it('defines null days for the all-time window', () => {
    expect(USAGE_STATS_WINDOWS.find((w) => w.key === 'all')?.days).toBeNull();
  });

  it('derives a day trend bucket for every window of 31 days or fewer', () => {
    for (const w of USAGE_STATS_WINDOWS.filter((x) => x.days !== null && x.days <= 31)) {
      expect(w.trendBucket, `window ${w.key}`).toBe('day');
    }
  });

  it('derives a month trend bucket for the unbounded window', () => {
    for (const w of USAGE_STATS_WINDOWS.filter((x) => x.days === null)) {
      expect(w.trendBucket, `window ${w.key}`).toBe('month');
    }
  });

  it('marks deltas available exactly for bounded windows', () => {
    for (const w of USAGE_STATS_WINDOWS) {
      expect(w.hasDelta, `window ${w.key}`).toBe(w.days !== null);
    }
  });
});
