import { describe, expect, it } from 'vitest';
import { paymentReference } from './payments.js';

describe('paymentReference', () => {
  it('renders the payment uuid as 32 hyphen-free lowercase hex digits', () => {
    const reference = paymentReference('0195f2a1-9c4d-7b3e-8f21-0a1b2c3d4e5f');
    expect(reference).toBe('0195f2a19c4d7b3e8f210a1b2c3d4e5f');
    expect(reference).toHaveLength(32);
    expect(reference).toMatch(/^[0-9a-f]{32}$/);
  });

  it('lowercases an upstream uppercase uuid so the reference is deterministic', () => {
    expect(paymentReference('0195F2A1-9C4D-7B3E-8F21-0A1B2C3D4E5F')).toBe(
      '0195f2a19c4d7b3e8f210a1b2c3d4e5f'
    );
  });

  it('re-derives the identical reference for the same payment id', () => {
    const paymentId = crypto.randomUUID();
    expect(paymentReference(paymentId)).toBe(paymentReference(paymentId));
  });

  it('throws when the payment id is not a 32-hex-digit uuid', () => {
    expect(() => paymentReference('not-a-uuid')).toThrow('32-hex');
  });
});
