import { describe, expect, it } from 'vitest';

import { LANDING_CIPHER_MESSAGES } from './cipher-messages.js';

describe('LANDING_CIPHER_MESSAGES', () => {
  it('exposes a non-empty list of landing cipher messages', () => {
    expect(LANDING_CIPHER_MESSAGES.length).toBeGreaterThan(0);
  });

  it('contains only non-empty trimmed strings', () => {
    for (const message of LANDING_CIPHER_MESSAGES) {
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
      expect(message).toBe(message.trim());
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(LANDING_CIPHER_MESSAGES).size).toBe(LANDING_CIPHER_MESSAGES.length);
  });

  it('leads with the encryption promise', () => {
    expect(LANDING_CIPHER_MESSAGES[0]).toBe('Encrypted By Default');
  });
});
