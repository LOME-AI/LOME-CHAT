import { describe, it, expect } from 'vitest';
import { formatTime } from './format-time.js';

describe('formatTime', () => {
  it('renders minute precision by default', () => {
    expect(formatTime('2026-07-13T12:34:56.789Z')).toBe('2026-07-13 12:34');
  });

  it('renders second precision when asked', () => {
    expect(formatTime('2026-07-13T12:34:56.789Z', 'second')).toBe('2026-07-13 12:34:56');
  });
});
