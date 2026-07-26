import { describe, it, expect } from 'vitest';

import { MAX_VIDEO_DURATION_SECONDS } from '../constants.js';

import {
  HUSHBOX_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  TOTAL_FEE_RATE,
  CHARACTERS_PER_KILOBYTE,
  KILOBYTES_PER_GIGABYTE,
  MONTHLY_COST_PER_GB,
  MONTHS_PER_YEAR,
  STORAGE_YEARS,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_COST_PER_1K_CHARS,
  MEDIA_MONTHLY_COST_PER_GB,
  MEDIA_STORAGE_COST_PER_BYTE,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  MAX_MODEL_AGE_MS,
  MIN_PRICE_PER_1K_TOKENS_NANO,
  TOP_CONTEXT_PERCENTILE,
} from './constants.js';

describe('Fee Structure', () => {
  describe('HUSHBOX_FEE_RATE', () => {
    it('is 0.05 (5%)', () => {
      expect(HUSHBOX_FEE_RATE).toBe(0.05);
    });

    it('is a positive number less than 1', () => {
      expect(HUSHBOX_FEE_RATE).toBeGreaterThan(0);
      expect(HUSHBOX_FEE_RATE).toBeLessThan(1);
    });
  });

  describe('CREDIT_CARD_FEE_RATE', () => {
    it('is 0.045 (4.5%)', () => {
      expect(CREDIT_CARD_FEE_RATE).toBe(0.045);
    });

    it('is a positive number less than 1', () => {
      expect(CREDIT_CARD_FEE_RATE).toBeGreaterThan(0);
      expect(CREDIT_CARD_FEE_RATE).toBeLessThan(1);
    });
  });

  describe('PROVIDER_FEE_RATE', () => {
    it('is 0.055 (5.5% AI provider overhead)', () => {
      expect(PROVIDER_FEE_RATE).toBe(0.055);
    });

    it('is a non-negative number less than 1', () => {
      expect(PROVIDER_FEE_RATE).toBeGreaterThanOrEqual(0);
      expect(PROVIDER_FEE_RATE).toBeLessThan(1);
    });
  });

  describe('TOTAL_FEE_RATE', () => {
    it('is sum of all individual fees', () => {
      expect(TOTAL_FEE_RATE).toBe(HUSHBOX_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE);
    });

    it('equals 0.15 (15%)', () => {
      expect(TOTAL_FEE_RATE).toBeCloseTo(0.15, 10);
    });
  });
});

describe('Storage Fee Constants', () => {
  describe('base constants', () => {
    it('defines CHARACTERS_PER_KILOBYTE as 1000', () => {
      expect(CHARACTERS_PER_KILOBYTE).toBe(1000);
    });

    it('defines KILOBYTES_PER_GIGABYTE as 1000000', () => {
      expect(KILOBYTES_PER_GIGABYTE).toBe(1_000_000);
    });

    it('defines MONTHLY_COST_PER_GB as 0.5', () => {
      expect(MONTHLY_COST_PER_GB).toBe(0.5);
    });

    it('defines MONTHS_PER_YEAR as 12', () => {
      expect(MONTHS_PER_YEAR).toBe(12);
    });

    it('defines STORAGE_YEARS as 50', () => {
      expect(STORAGE_YEARS).toBe(50);
    });
  });

  describe('STORAGE_COST_PER_CHARACTER', () => {
    it('derives from base constants', () => {
      const expectedCostPerCharacter =
        (MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) /
        (CHARACTERS_PER_KILOBYTE * KILOBYTES_PER_GIGABYTE);

      expect(STORAGE_COST_PER_CHARACTER).toBe(expectedCostPerCharacter);
    });

    it('equals $0.0000003 per character', () => {
      expect(STORAGE_COST_PER_CHARACTER).toBeCloseTo(0.000_000_3, 10);
    });

    it('calculates to $0.0003 per 1k characters', () => {
      const costPer1kChars = STORAGE_COST_PER_CHARACTER * 1000;
      expect(costPer1kChars).toBeCloseTo(0.0003, 10);
    });

    it('allows 16k+ 200-character messages for $1', () => {
      const dollarsAvailable = 1;
      const charsPerMessage = 200;
      const totalChars = dollarsAvailable / STORAGE_COST_PER_CHARACTER;
      const messageCount = totalChars / charsPerMessage;

      expect(messageCount).toBeGreaterThan(16_000);
    });
  });

  describe('STORAGE_COST_PER_1K_CHARS', () => {
    it('equals STORAGE_COST_PER_CHARACTER * 1000', () => {
      expect(STORAGE_COST_PER_1K_CHARS).toBe(STORAGE_COST_PER_CHARACTER * 1000);
    });

    it('equals $0.0003', () => {
      expect(STORAGE_COST_PER_1K_CHARS).toBeCloseTo(0.0003, 10);
    });
  });
});

describe('Media Storage Cost Constants', () => {
  describe('MEDIA_MONTHLY_COST_PER_GB', () => {
    it('is 0.03 ($0.03/GB/month)', () => {
      expect(MEDIA_MONTHLY_COST_PER_GB).toBe(0.03);
    });

    it('is positive', () => {
      expect(MEDIA_MONTHLY_COST_PER_GB).toBeGreaterThan(0);
    });
  });

  describe('MEDIA_STORAGE_COST_PER_BYTE', () => {
    it('derives from base constants', () => {
      const expected =
        (MEDIA_MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) / (1000 * 1_000_000);
      expect(MEDIA_STORAGE_COST_PER_BYTE).toBe(expected);
    });

    it('is positive and very small', () => {
      expect(MEDIA_STORAGE_COST_PER_BYTE).toBeGreaterThan(0);
      expect(MEDIA_STORAGE_COST_PER_BYTE).toBeLessThan(0.000_001);
    });

    it('costs about $0.018 per MB', () => {
      const costPerMB = MEDIA_STORAGE_COST_PER_BYTE * 1_000_000;
      expect(costPerMB).toBeCloseTo(0.018, 3);
    });

    it('costs about $0.072 per 4MB image', () => {
      const costPer4MB = MEDIA_STORAGE_COST_PER_BYTE * 4_000_000;
      expect(costPer4MB).toBeCloseTo(0.072, 2);
    });
  });
});

describe('ESTIMATED_IMAGE_BYTES', () => {
  it('is 8 MB', () => {
    expect(ESTIMATED_IMAGE_BYTES).toBe(8_000_000);
  });

  it('is a positive integer', () => {
    expect(Number.isInteger(ESTIMATED_IMAGE_BYTES)).toBe(true);
    expect(ESTIMATED_IMAGE_BYTES).toBeGreaterThan(0);
  });
});

describe('ESTIMATED_VIDEO_BYTES_PER_SECOND', () => {
  it('is 5_000_000 (~5 MB/s worst-case 1080p)', () => {
    expect(ESTIMATED_VIDEO_BYTES_PER_SECOND).toBe(5_000_000);
  });

  it('is a positive integer', () => {
    expect(Number.isInteger(ESTIMATED_VIDEO_BYTES_PER_SECOND)).toBe(true);
    expect(ESTIMATED_VIDEO_BYTES_PER_SECOND).toBeGreaterThan(0);
  });

  it('produces worst-case 40MB for 8-second clip', () => {
    expect(ESTIMATED_VIDEO_BYTES_PER_SECOND * MAX_VIDEO_DURATION_SECONDS).toBe(40_000_000);
  });
});

describe('catalog admission', () => {
  describe('MIN_PRICE_PER_1K_TOKENS_NANO', () => {
    it('is $0.0002 per 1,000 combined tokens', () => {
      expect(MIN_PRICE_PER_1K_TOKENS_NANO).toBe(200_000n);
    });

    it('is 200 nano-USD per single token', () => {
      expect(MIN_PRICE_PER_1K_TOKENS_NANO / 1000n).toBe(200n);
    });
  });

  describe('MAX_MODEL_AGE_MS', () => {
    it('is two years', () => {
      expect(MAX_MODEL_AGE_MS).toBe(2 * 365 * 24 * 60 * 60 * 1000);
    });
  });

  describe('TOP_CONTEXT_PERCENTILE', () => {
    it('exempts the top 5% of context lengths', () => {
      expect(TOP_CONTEXT_PERCENTILE).toBe(0.95);
    });
  });
});
