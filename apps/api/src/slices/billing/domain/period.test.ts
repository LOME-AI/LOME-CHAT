import { describe, expect, it } from 'vitest';
import { utcDayKey } from './period.js';

describe('utcDayKey', () => {
  it('keys by the UTC calendar day', () => {
    expect(utcDayKey(new Date('2026-07-03T15:04:05Z'))).toBe('2026-07-03');
  });

  it('crosses the day boundary on UTC, not local time', () => {
    expect(utcDayKey(new Date('2026-07-03T23:59:59.999Z'))).toBe('2026-07-03');
    expect(utcDayKey(new Date('2026-07-04T00:00:00.000Z'))).toBe('2026-07-04');
  });
});
