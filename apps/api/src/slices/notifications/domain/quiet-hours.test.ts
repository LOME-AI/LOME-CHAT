import { describe, it, expect } from 'vitest';
import { isWithinQuietHours, localMinutesOfDay } from './quiet-hours.js';

// A fixed UTC instant: 2026-01-15T12:00:00Z (winter, no NY DST).
const NOON_UTC = new Date('2026-01-15T12:00:00Z');

describe('localMinutesOfDay', () => {
  it('places a UTC instant into a western zone', () => {
    // New York in January is UTC-5 → 07:00 → 420 minutes.
    expect(localMinutesOfDay(NOON_UTC, 'America/New_York')).toBe(7 * 60);
  });

  it('places a UTC instant into an eastern zone', () => {
    // Tokyo is UTC+9 → 21:00 → 1260 minutes.
    expect(localMinutesOfDay(NOON_UTC, 'Asia/Tokyo')).toBe(21 * 60);
  });

  it('resolves a half-hour-offset zone', () => {
    // Kolkata is UTC+5:30 → 17:30 → 1050 minutes.
    expect(localMinutesOfDay(NOON_UTC, 'Asia/Kolkata')).toBe(17 * 60 + 30);
  });

  it('follows daylight saving for the same zone across the year', () => {
    // New York in July is UTC-4 (EDT) → 08:00 → 480 minutes.
    const summer = new Date('2026-07-15T12:00:00Z');
    expect(localMinutesOfDay(summer, 'America/New_York')).toBe(8 * 60);
  });

  it('reports midnight as minute zero, never 1440', () => {
    // 05:00Z is 00:00 in New York (UTC-5).
    const midnightNy = new Date('2026-01-15T05:00:00Z');
    expect(localMinutesOfDay(midnightNy, 'America/New_York')).toBe(0);
  });
});

describe('isWithinQuietHours', () => {
  it('suppresses inside a same-day window', () => {
    // Window 06:00–08:00 NY; noon-UTC is 07:00 NY → inside.
    expect(isWithinQuietHours(NOON_UTC, 6 * 60, 8 * 60, 'America/New_York')).toBe(true);
  });

  it('does not suppress before a same-day window opens', () => {
    // Window 08:00–09:00 NY; 07:00 NY → before.
    expect(isWithinQuietHours(NOON_UTC, 8 * 60, 9 * 60, 'America/New_York')).toBe(false);
  });

  it('treats the window start as inclusive', () => {
    // 07:00 NY exactly at the 07:00 start → inside.
    expect(isWithinQuietHours(NOON_UTC, 7 * 60, 8 * 60, 'America/New_York')).toBe(true);
  });

  it('treats the window end as exclusive', () => {
    // 07:00 NY exactly at the 07:00 end → outside.
    expect(isWithinQuietHours(NOON_UTC, 6 * 60, 7 * 60, 'America/New_York')).toBe(false);
  });

  it('suppresses in the late arm of a cross-midnight window', () => {
    // Window 22:00–06:00 NY; 21:00 Tokyo is not it — use a late-night NY instant.
    // 2026-01-16T03:00:00Z → 22:00 NY (Jan 15) → inside the 22:00–06:00 window.
    const lateNight = new Date('2026-01-16T03:00:00Z');
    expect(isWithinQuietHours(lateNight, 22 * 60, 6 * 60, 'America/New_York')).toBe(true);
  });

  it('suppresses in the early arm of a cross-midnight window', () => {
    // 2026-01-16T10:00:00Z → 05:00 NY → inside the 22:00–06:00 window.
    const earlyMorning = new Date('2026-01-16T10:00:00Z');
    expect(isWithinQuietHours(earlyMorning, 22 * 60, 6 * 60, 'America/New_York')).toBe(true);
  });

  it('does not suppress in the daytime gap of a cross-midnight window', () => {
    // Noon-UTC → 07:00 NY → outside the 22:00–06:00 window.
    expect(isWithinQuietHours(NOON_UTC, 22 * 60, 6 * 60, 'America/New_York')).toBe(false);
  });

  it('never suppresses for a zero-length window', () => {
    // Degenerate start === end → empty window, no suppression.
    expect(isWithinQuietHours(NOON_UTC, 7 * 60, 7 * 60, 'America/New_York')).toBe(false);
  });

  it('evaluates the window in the stored zone, not UTC', () => {
    // Same instant, 20:00–06:00 window: in Tokyo it is 21:00 → inside…
    expect(isWithinQuietHours(NOON_UTC, 20 * 60, 6 * 60, 'Asia/Tokyo')).toBe(true);
    // …while in New York the same instant is 07:00 → outside.
    expect(isWithinQuietHours(NOON_UTC, 20 * 60, 6 * 60, 'America/New_York')).toBe(false);
  });
});
