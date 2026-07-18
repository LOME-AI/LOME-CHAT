import { describe, expect, it } from 'vitest';
import { cassetteModeFor } from './mode.js';

describe('cassetteModeFor', () => {
  it('returns record (record-on-miss)', () => {
    expect(cassetteModeFor()).toBe('record');
  });
});
