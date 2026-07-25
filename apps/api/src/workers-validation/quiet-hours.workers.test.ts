import { describe, it, expect } from 'vitest';
import {
  isWithinQuietHours,
  localMinutesOfDay,
} from '../slices/notifications/domain/quiet-hours.js';

/**
 * Validates the platform assumption quiet hours rest on: workerd resolves an
 * arbitrary IANA `timeZone` through `Intl.DateTimeFormat`, including
 * half-hour-offset zones and DST transitions. Node ships full ICU and would
 * pass regardless, so this assertion is only meaningful inside the runtime the
 * Worker actually runs on — a trimmed-ICU build or a compatibility change
 * would silently evaluate every user's window in the wrong zone, suppressing
 * or emitting notifications at the wrong local time.
 */
const WINTER = new Date('2026-01-15T12:00:00Z');
const SUMMER = new Date('2026-07-15T12:00:00Z');

describe('quiet-hours zone evaluation under workerd', () => {
  it('runs on workerd, not on the node test runtime', () => {
    // Guards the guard: without this, a misconfigured project could run these
    // zone assertions under node's full ICU and pin nothing at all.
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
  });

  it('resolves whole-hour offsets in both hemispheres', () => {
    expect(localMinutesOfDay(WINTER, 'UTC')).toBe(12 * 60);
    expect(localMinutesOfDay(WINTER, 'America/New_York')).toBe(7 * 60);
    expect(localMinutesOfDay(WINTER, 'Asia/Tokyo')).toBe(21 * 60);
    expect(localMinutesOfDay(WINTER, 'Australia/Lord_Howe')).toBe(23 * 60);
  });

  it('resolves a half-hour offset zone', () => {
    // The first case a degraded ICU build breaks: a zone whose offset is not a
    // whole number of hours.
    expect(localMinutesOfDay(WINTER, 'Asia/Kolkata')).toBe(17 * 60 + 30);
  });

  it('shifts a zone across its own DST transition', () => {
    expect(localMinutesOfDay(WINTER, 'America/New_York')).toBe(7 * 60);
    expect(localMinutesOfDay(SUMMER, 'America/New_York')).toBe(8 * 60);
  });

  it('rejects an unrecognized zone instead of silently falling back to UTC', () => {
    expect(() => localMinutesOfDay(WINTER, 'Not/AZone')).toThrow();
  });

  it('evaluates a cross-midnight window in the user’s own zone', () => {
    // 22:00–07:00 local. The same instant is inside the window in Tokyo
    // (21:00 → no) only once each zone's local clock is read correctly.
    expect(isWithinQuietHours(WINTER, 22 * 60, 7 * 60, 'Asia/Tokyo')).toBe(false);
    expect(isWithinQuietHours(WINTER, 22 * 60, 7 * 60, 'Australia/Lord_Howe')).toBe(true);
    expect(isWithinQuietHours(WINTER, 22 * 60, 7 * 60, 'Asia/Kolkata')).toBe(false);
  });
});
