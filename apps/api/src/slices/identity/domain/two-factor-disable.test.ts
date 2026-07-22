import { describe, expect, it } from 'vitest';
import { disable2faFinishBodySchema, disable2faInitBodySchema } from './two-factor-disable.js';

const keArray = (length: number): number[] => Array.from({ length }, () => 0);

/**
 * The 1024-element cap on the OPAQUE KE arrays bounds parse cost. Legacy left
 * 2FA-disable uncapped; this cap is consistent DoS-hardening (fail-fast
 * doctrine), matching the delete-account parity value, not a legacy-parity
 * restoration.
 */
describe('2FA-disable KE-array cap', () => {
  it('accepts a ke1 array of exactly 1024 elements', () => {
    expect(disable2faInitBodySchema.safeParse({ ke1: keArray(1024) }).success).toBe(true);
  });

  it('rejects a ke1 array of 1025 elements', () => {
    expect(disable2faInitBodySchema.safeParse({ ke1: keArray(1025) }).success).toBe(false);
  });

  it('accepts a ke3 array of exactly 1024 elements', () => {
    const body = {
      ke3: keArray(1024),
      code: '123456',
      disable2FASessionId: crypto.randomUUID(),
    };
    expect(disable2faFinishBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a ke3 array of 1025 elements', () => {
    const body = {
      ke3: keArray(1025),
      code: '123456',
      disable2FASessionId: crypto.randomUUID(),
    };
    expect(disable2faFinishBodySchema.safeParse(body).success).toBe(false);
  });
});
