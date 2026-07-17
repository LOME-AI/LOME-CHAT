import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isValidLuhn,
  formatCardNumber,
  formatExpiry,
  formatCvv,
  formatZip,
  validateCardNumber,
  validateExpiry,
  validateCvv,
  validateZip,
} from './card-utilities.js';

describe('isValidLuhn', () => {
  it('returns true for valid Visa card number', () => {
    expect(isValidLuhn('4111111111111111')).toBe(true);
  });

  it('returns true for valid Mastercard number', () => {
    expect(isValidLuhn('5555555555554444')).toBe(true);
  });

  it('returns true for valid Amex number', () => {
    expect(isValidLuhn('378282246310005')).toBe(true);
  });

  it('returns false for invalid card number', () => {
    expect(isValidLuhn('1234567890123456')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isValidLuhn('')).toBe(false);
  });

  it('handles card numbers with spaces', () => {
    expect(isValidLuhn('4111 1111 1111 1111')).toBe(true);
  });
});

describe('formatCardNumber', () => {
  it('formats card number with spaces every 4 digits', () => {
    expect(formatCardNumber('4111111111111111')).toBe('4111 1111 1111 1111');
  });

  it('handles partial card number', () => {
    expect(formatCardNumber('411111')).toBe('4111 11');
  });

  it('strips non-numeric characters', () => {
    expect(formatCardNumber('4111-1111-1111-1111')).toBe('4111 1111 1111 1111');
  });

  it('limits to 19 characters (16 digits + 3 spaces)', () => {
    expect(formatCardNumber('41111111111111111234')).toBe('4111 1111 1111 1111');
  });

  it('returns empty string for non-numeric input', () => {
    expect(formatCardNumber('abcd')).toBe('');
  });
});

describe('formatExpiry', () => {
  it('formats full expiry date', () => {
    expect(formatExpiry('1225')).toBe('12 / 25');
  });

  it('handles partial month input', () => {
    expect(formatExpiry('12')).toBe('12');
  });

  it('handles month and partial year', () => {
    expect(formatExpiry('123')).toBe('12 / 3');
  });

  it('strips non-numeric characters', () => {
    expect(formatExpiry('12/25')).toBe('12 / 25');
  });
});

describe('formatCvv', () => {
  it('returns digits only', () => {
    expect(formatCvv('123')).toBe('123');
  });

  it('strips non-numeric characters', () => {
    expect(formatCvv('12a3b')).toBe('123');
  });

  it('limits to 4 characters', () => {
    expect(formatCvv('12345')).toBe('1234');
  });
});

describe('formatZip', () => {
  it('returns alphanumeric characters', () => {
    expect(formatZip('12345')).toBe('12345');
  });

  it('handles Canadian postal codes', () => {
    expect(formatZip('K1A0B1')).toBe('K1A0B1');
  });

  it('strips special characters', () => {
    expect(formatZip('12345-6789')).toBe('123456789');
  });

  it('limits to 10 characters', () => {
    expect(formatZip('12345678901234')).toBe('1234567890');
  });
});

describe('validateCardNumber', () => {
  it('returns null for valid card number', () => {
    expect(validateCardNumber('4111 1111 1111 1111')).toBeNull();
  });

  it('returns error for empty card number', () => {
    expect(validateCardNumber('')).toBe('Card number is required');
  });

  it('returns error for short card number', () => {
    expect(validateCardNumber('4111')).toBe('Card number must be at least 13 digits');
  });

  it('returns error for long card number', () => {
    expect(validateCardNumber('41111111111111111234')).toBe('Card number is too long');
  });

  it('returns error for non-numeric card number', () => {
    expect(validateCardNumber('4111111111111abc')).toBe('Card number must contain only digits');
  });

  it('returns error for invalid Luhn', () => {
    expect(validateCardNumber('1234567890123456')).toBe('Invalid card number');
  });
});

describe('validateExpiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for valid future expiry', () => {
    expect(validateExpiry('12 / 25')).toBeNull();
  });

  it('returns error for empty expiry', () => {
    expect(validateExpiry('')).toBe('Expiry date is required');
  });

  it('returns error for invalid format', () => {
    expect(validateExpiry('1225')).toBe('Format: MM / YY');
  });

  it('returns error for invalid month', () => {
    expect(validateExpiry('13 / 25')).toBe('Invalid month');
  });

  it('returns error for expired card', () => {
    expect(validateExpiry('01 / 25')).toBe('Card has expired');
  });

  it('accepts current month', () => {
    expect(validateExpiry('06 / 25')).toBeNull();
  });

  it('rejects tab-separated input that is not a literal " / "', () => {
    // The format regex requires a literal space around the slash, matching the
    // formatExpiry mask. A tab-separated value fails the format check outright.
    expect(validateExpiry('12\t/\t34')).toBe('Format: MM / YY');
  });
});

describe('validateCvv', () => {
  it('returns null for valid 3-digit CVV', () => {
    expect(validateCvv('123')).toBeNull();
  });

  it('returns null for valid 4-digit CVV (Amex)', () => {
    expect(validateCvv('1234')).toBeNull();
  });

  it('returns error for empty CVV', () => {
    expect(validateCvv('')).toBe('CVV is required');
  });

  it('returns error for short CVV', () => {
    expect(validateCvv('12')).toBe('CVV must be 3-4 digits');
  });

  it('returns error for CVV longer than 4 digits', () => {
    expect(validateCvv('12345')).toBe('CVV must be 3-4 digits');
  });

  it('returns error for non-numeric CVV', () => {
    expect(validateCvv('12a')).toBe('CVV must contain only digits');
  });
});

describe('validateZip', () => {
  it('returns null for valid US zip', () => {
    expect(validateZip('12345')).toBeNull();
  });

  it('returns null for valid Canadian postal code', () => {
    expect(validateZip('K1A0B1')).toBeNull();
  });

  it('returns error for empty zip', () => {
    expect(validateZip('')).toBe('ZIP code is required');
  });

  it('returns error for short zip', () => {
    expect(validateZip('1234')).toBe('ZIP code must be 5 digits');
  });
});
