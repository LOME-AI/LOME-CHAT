import { describe, it, expect } from 'vitest';
import {
  DEV_PASSWORD,
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
  MAX_CONVERSATION_MEMBERS,
  PRIVACY_POLICY_EFFECTIVE_DATE,
  TERMS_OF_SERVICE_EFFECTIVE_DATE,
  BILLING_CONTACT_EMAIL,
  PRIVACY_CONTACT_EMAIL,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  MIN_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_DURATION_SECONDS,
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

describe('MAX_CONVERSATION_MEMBERS', () => {
  it('equals 100', () => {
    expect(MAX_CONVERSATION_MEMBERS).toBe(100);
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
