import { describe, expect, it } from 'vitest';
import { FEEDBACK_BODY_MAX_LENGTH } from './feedback.js';
import { FEEDBACK_BODY_MAX_LENGTH as BarrelMaxLength } from './index.js';

describe('FEEDBACK_BODY_MAX_LENGTH', () => {
  it('is the 4000-character feedback body cutoff', () => {
    expect(FEEDBACK_BODY_MAX_LENGTH).toBe(4000);
  });

  it('is re-exported from the package barrel', () => {
    expect(BarrelMaxLength).toBe(FEEDBACK_BODY_MAX_LENGTH);
  });
});
