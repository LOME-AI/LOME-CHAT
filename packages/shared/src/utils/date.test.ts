import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getUtcMidnight, needsResetBeforeMidnight, secondsUntilNextUtcMidnight } from './date';

describe('date utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getUtcMidnight', () => {
    it('returns midnight UTC for the current day', () => {
      // Set to 2024-01-15 14:30:45.123 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:45.123Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('handles end of day correctly', () => {
      // Set to 2024-01-15 23:59:59.999 UTC
      vi.setSystemTime(new Date('2024-01-15T23:59:59.999Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('handles start of day correctly', () => {
      // Set to 2024-01-15 00:00:00.001 UTC
      vi.setSystemTime(new Date('2024-01-15T00:00:00.001Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('handles month boundaries', () => {
      // Set to 2024-02-01 05:00:00 UTC
      vi.setSystemTime(new Date('2024-02-01T05:00:00.000Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    });

    it('handles year boundaries', () => {
      // Set to 2024-01-01 12:00:00 UTC
      vi.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('secondsUntilNextUtcMidnight', () => {
    it('returns seconds remaining until next midnight', () => {
      // Current time: 2024-01-15 14:30:00 UTC → 9.5 hours = 34200 seconds
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      expect(secondsUntilNextUtcMidnight()).toBe(34_200);
    });

    it('returns full day at exactly midnight', () => {
      vi.setSystemTime(new Date('2024-01-15T00:00:00.000Z'));

      expect(secondsUntilNextUtcMidnight()).toBe(86_400);
    });

    it('returns 1 second just before midnight', () => {
      vi.setSystemTime(new Date('2024-01-15T23:59:59.000Z'));

      expect(secondsUntilNextUtcMidnight()).toBe(1);
    });

    it('handles sub-second precision by rounding up', () => {
      // 23:59:59.500 → 0.5 seconds left → ceil to 1
      vi.setSystemTime(new Date('2024-01-15T23:59:59.500Z'));

      expect(secondsUntilNextUtcMidnight()).toBe(1);
    });

    it('handles month boundaries', () => {
      // Jan 31 at 23:00:00 → 3600 seconds until Feb 1 midnight
      vi.setSystemTime(new Date('2024-01-31T23:00:00.000Z'));

      expect(secondsUntilNextUtcMidnight()).toBe(3600);
    });

    it('computes from an explicit reference instant, ignoring the wall clock', () => {
      // Wall clock sits at midnight (a full day would remain) — the passed
      // instant is noon, so the result must track the argument, not the clock.
      vi.setSystemTime(new Date('2024-01-15T00:00:00.000Z'));

      expect(secondsUntilNextUtcMidnight(new Date('2024-06-10T12:00:00.000Z'))).toBe(43_200);
    });
  });

  describe('needsResetBeforeMidnight', () => {
    it('returns true when resetAt is null', () => {
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      expect(needsResetBeforeMidnight(null)).toBe(true);
    });

    it('returns true when resetAt is before today midnight', () => {
      // Current time: 2024-01-15 14:30 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      // Reset was yesterday
      const resetAt = new Date('2024-01-14T12:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(true);
    });

    it('returns false when resetAt is today', () => {
      // Current time: 2024-01-15 14:30 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      // Reset was today at midnight
      const resetAt = new Date('2024-01-15T00:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(false);
    });

    it('returns false when resetAt is after today midnight', () => {
      // Current time: 2024-01-15 14:30 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      // Reset was today at noon
      const resetAt = new Date('2024-01-15T12:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(false);
    });

    it('returns true exactly at day boundary transition', () => {
      // Current time: 2024-01-15 00:00:00.001 UTC (just past midnight)
      vi.setSystemTime(new Date('2024-01-15T00:00:00.001Z'));

      // Reset was yesterday at midnight
      const resetAt = new Date('2024-01-14T00:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(true);
    });
  });
});
