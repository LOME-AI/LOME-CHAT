/**
 * Validates a card number using the Luhn algorithm.
 * Handles card numbers with spaces or other separators.
 */
export function isValidLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replaceAll(/\D/g, '');
  if (digits.length === 0) return false;

  let sum = 0;
  let isEven = false;

  for (let index = digits.length - 1; index >= 0; index--) {
    const char = digits[index];
    /* v8 ignore next -- `index` iterates valid indices of `digits`, so `char` is never undefined; this guard is unreachable. */
    if (char === undefined) continue;
    let digit = Number.parseInt(char, 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

export function formatCardNumber(value: string): string {
  const cleaned = value.replaceAll(/\D/g, '');
  const groups = cleaned.match(/.{1,4}/g);
  return groups ? groups.join(' ').slice(0, 19) : '';
}

export function formatExpiry(value: string): string {
  const cleaned = value.replaceAll(/\D/g, '');
  if (cleaned.length >= 3) {
    return `${cleaned.slice(0, 2)} / ${cleaned.slice(2, 4)}`;
  }
  return cleaned;
}

export function formatCvv(value: string): string {
  return value.replaceAll(/\D/g, '').slice(0, 4);
}

/**
 * Formats ZIP code: alphanumeric only, max 10 characters.
 * Supports US ZIP codes and Canadian postal codes.
 */
export function formatZip(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

export function validateCardNumber(cardNumber: string): string | null {
  const cleaned = cardNumber.replaceAll(/\s/g, '');
  if (cleaned.length === 0) return 'Card number is required';
  if (cleaned.length < 13) return 'Card number must be at least 13 digits';
  if (cleaned.length > 19) return 'Card number is too long';
  if (!/^\d+$/.test(cleaned)) return 'Card number must contain only digits';
  if (!isValidLuhn(cleaned)) return 'Invalid card number';
  return null;
}

export function validateExpiry(expiry: string): string | null {
  if (expiry.length === 0) return 'Expiry date is required';
  const match = /^(\d{2}) \/ (\d{2})$/.exec(expiry);
  if (match === null) return 'Format: MM / YY';

  // The two mandatory `\d{2}` capture groups guarantee match[1] and match[2]
  // are defined; the `?? ''` fallbacks exist only to satisfy
  // noUncheckedIndexedAccess typing and are unreachable.
  /* v8 ignore next 2 */
  const monthString = match[1] ?? '';
  const yearString = match[2] ?? '';
  const month = Number.parseInt(monthString, 10);
  const year = Number.parseInt(yearString, 10);

  if (month < 1 || month > 12) return 'Invalid month';

  const now = new Date();
  const currentYear = now.getFullYear() % 100;
  const currentMonth = now.getMonth() + 1;

  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    return 'Card has expired';
  }

  return null;
}

export function validateCvv(cvv: string): string | null {
  if (cvv.length === 0) return 'CVV is required';
  if (cvv.length < 3 || cvv.length > 4) return 'CVV must be 3-4 digits';
  if (!/^\d+$/.test(cvv)) return 'CVV must contain only digits';
  return null;
}

export function validateZip(zip: string): string | null {
  if (zip.length === 0) return 'ZIP code is required';
  if (zip.length < 5) return 'ZIP code must be 5 digits';
  return null;
}
