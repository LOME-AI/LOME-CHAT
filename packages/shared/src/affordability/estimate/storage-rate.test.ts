import { describe, expect, it } from 'vitest';

import {
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
} from './storage-rate.js';

describe('STORAGE_COST_PER_CHARACTER_NANO', () => {
  it('is the $0.0000003/char storage rate in nano-USD', () => {
    expect(STORAGE_COST_PER_CHARACTER_NANO).toBe(300n);
  });
});

describe('MEDIA_STORAGE_COST_PER_BYTE_NANO', () => {
  it('is the $0.000000018/byte media storage rate in nano-USD', () => {
    expect(MEDIA_STORAGE_COST_PER_BYTE_NANO).toBe(18n);
  });
});
