import { describe, it, expect } from 'vitest';
import {
  DEV_PASSWORD,
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
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
  MAX_CONVERSATION_MEMBERS,
  PRIVACY_POLICY_EFFECTIVE_DATE,
  TERMS_OF_SERVICE_EFFECTIVE_DATE,
  BILLING_CONTACT_EMAIL,
  PRIVACY_CONTACT_EMAIL,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  MEDIA_MONTHLY_COST_PER_GB,
  MEDIA_STORAGE_COST_PER_BYTE,
  ESTIMATED_IMAGE_BYTES,
  MIN_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_DURATION_SECONDS,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  IMAGE_ASPECT_RATIOS,
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  MIN_PASSWORD_LENGTH,
  MIN_DEPOSIT_USD,
} from './constants.js';

describe('DEV_PASSWORD', () => {
  it('is a non-empty string', () => {
    expect(typeof DEV_PASSWORD).toBe('string');
    expect(DEV_PASSWORD.length).toBeGreaterThan(0);
  });

  it('has at least 8 characters for minimal security', () => {
    expect(DEV_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });
});

describe('DEV_EMAIL_DOMAIN', () => {
  it('is dev.hushbox.ai', () => {
    expect(DEV_EMAIL_DOMAIN).toBe('dev.hushbox.ai');
  });
});

describe('TEST_EMAIL_DOMAIN', () => {
  it('is test.hushbox.ai', () => {
    expect(TEST_EMAIL_DOMAIN).toBe('test.hushbox.ai');
  });

  it('is different from DEV_EMAIL_DOMAIN', () => {
    expect(TEST_EMAIL_DOMAIN).not.toBe(DEV_EMAIL_DOMAIN);
  });
});

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

  describe('MAX_CONVERSATION_MEMBERS', () => {
    it('equals 100', () => {
      expect(MAX_CONVERSATION_MEMBERS).toBe(100);
    });
  });
});

describe('Legal Constants', () => {
  describe('PRIVACY_POLICY_EFFECTIVE_DATE', () => {
    it('is a valid YYYY-MM-DD date string', () => {
      expect(PRIVACY_POLICY_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('parses to a valid date', () => {
      const date = new Date(PRIVACY_POLICY_EFFECTIVE_DATE);
      expect(date.toString()).not.toBe('Invalid Date');
    });
  });

  describe('TERMS_OF_SERVICE_EFFECTIVE_DATE', () => {
    it('is a valid YYYY-MM-DD date string', () => {
      expect(TERMS_OF_SERVICE_EFFECTIVE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('parses to a valid date', () => {
      const date = new Date(TERMS_OF_SERVICE_EFFECTIVE_DATE);
      expect(date.toString()).not.toBe('Invalid Date');
    });
  });

  describe('BILLING_CONTACT_EMAIL', () => {
    it('is a valid email address', () => {
      expect(BILLING_CONTACT_EMAIL).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
    });

    it('uses hushbox.ai domain', () => {
      expect(BILLING_CONTACT_EMAIL).toContain('@hushbox.ai');
    });
  });

  describe('PRIVACY_CONTACT_EMAIL', () => {
    it('is a valid email address', () => {
      expect(PRIVACY_CONTACT_EMAIL).toMatch(/^[^@]+@[^@]+\.[^@]+$/);
    });

    it('uses hushbox.ai domain', () => {
      expect(PRIVACY_CONTACT_EMAIL).toContain('@hushbox.ai');
    });

    it('is different from BILLING_CONTACT_EMAIL', () => {
      expect(PRIVACY_CONTACT_EMAIL).not.toBe(BILLING_CONTACT_EMAIL);
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

describe('MEDIA_DOWNLOAD_URL_TTL_SECONDS', () => {
  it('is 300 seconds (5 minutes)', () => {
    expect(MEDIA_DOWNLOAD_URL_TTL_SECONDS).toBe(300);
  });

  it('is a positive integer', () => {
    expect(Number.isInteger(MEDIA_DOWNLOAD_URL_TTL_SECONDS)).toBe(true);
    expect(MEDIA_DOWNLOAD_URL_TTL_SECONDS).toBeGreaterThan(0);
  });
});

describe('Video Duration Constants', () => {
  it('MIN_VIDEO_DURATION_SECONDS is 1', () => {
    expect(MIN_VIDEO_DURATION_SECONDS).toBe(1);
  });

  it('MAX_VIDEO_DURATION_SECONDS is 8', () => {
    expect(MAX_VIDEO_DURATION_SECONDS).toBe(8);
  });

  it('MIN is less than MAX', () => {
    expect(MIN_VIDEO_DURATION_SECONDS).toBeLessThan(MAX_VIDEO_DURATION_SECONDS);
  });

  it('both are positive integers', () => {
    expect(Number.isInteger(MIN_VIDEO_DURATION_SECONDS)).toBe(true);
    expect(Number.isInteger(MAX_VIDEO_DURATION_SECONDS)).toBe(true);
    expect(MIN_VIDEO_DURATION_SECONDS).toBeGreaterThan(0);
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

describe('VIDEO_ASPECT_RATIOS', () => {
  it('includes the two Veo-supported aspects', () => {
    expect(VIDEO_ASPECT_RATIOS).toEqual(['16:9', '9:16']);
  });

  it('is a non-empty readonly tuple', () => {
    expect(VIDEO_ASPECT_RATIOS.length).toBeGreaterThan(0);
  });

  it('every entry matches the W:H pattern', () => {
    for (const ratio of VIDEO_ASPECT_RATIOS) {
      expect(ratio).toMatch(/^\d+:\d+$/);
    }
  });
});

describe('VIDEO_RESOLUTIONS', () => {
  it('includes 720p, 1080p, and 4k', () => {
    expect(VIDEO_RESOLUTIONS).toEqual(['720p', '1080p', '4k']);
  });

  it('every entry is a recognised resolution token', () => {
    for (const res of VIDEO_RESOLUTIONS) {
      expect(res).toMatch(/^(\d+p|4k)$/);
    }
  });
});

describe('IMAGE_ASPECT_RATIOS', () => {
  it('includes the five Imagen-supported aspects', () => {
    expect(IMAGE_ASPECT_RATIOS).toEqual(['1:1', '4:3', '3:4', '16:9', '9:16']);
  });

  it('every entry matches the W:H pattern', () => {
    for (const ratio of IMAGE_ASPECT_RATIOS) {
      expect(ratio).toMatch(/^\d+:\d+$/);
    }
  });
});

describe('DELETE_ACCOUNT_CONFIRMATION_PHRASE', () => {
  it('is "delete my account"', () => {
    expect(DELETE_ACCOUNT_CONFIRMATION_PHRASE).toBe('delete my account');
  });

  it('is already lowercase and trimmed', () => {
    expect(DELETE_ACCOUNT_CONFIRMATION_PHRASE).toBe(
      DELETE_ACCOUNT_CONFIRMATION_PHRASE.trim().toLowerCase()
    );
  });

  describe('MIN_PASSWORD_LENGTH', () => {
    it('is 8', () => {
      expect(MIN_PASSWORD_LENGTH).toBe(8);
    });
  });

  describe('MIN_DEPOSIT_USD', () => {
    it('is $5', () => {
      expect(MIN_DEPOSIT_USD).toBe(5);
    });
  });
});
