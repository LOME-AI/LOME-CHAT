import { describe, expect, it } from 'vitest';
import { changePasswordFinishBodySchema, changePasswordInitBodySchema } from './password-change.js';

const keArray = (length: number): number[] => Array.from({ length }, () => 0);

/**
 * The 1024-element cap on the OPAQUE KE arrays bounds parse cost. Legacy left
 * password-change uncapped; this cap is consistent DoS-hardening (fail-fast
 * doctrine), matching the delete-account parity value, not a legacy-parity
 * restoration. Only ke1/ke3 are capped here — the registration-request/record
 * arrays are out of this task's scope.
 */
describe('password-change KE-array cap', () => {
  it('accepts a ke1 array of exactly 1024 elements', () => {
    const body = { ke1: keArray(1024), newRegistrationRequest: [1] };
    expect(changePasswordInitBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a ke1 array of 1025 elements', () => {
    const body = { ke1: keArray(1025), newRegistrationRequest: [1] };
    expect(changePasswordInitBodySchema.safeParse(body).success).toBe(false);
  });

  it('accepts a ke3 array of exactly 1024 elements', () => {
    const body = {
      ke3: keArray(1024),
      newRegistrationRecord: [1],
      newPasswordWrappedPrivateKey: 'wrapped',
      changePasswordSessionId: crypto.randomUUID(),
    };
    expect(changePasswordFinishBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a ke3 array of 1025 elements', () => {
    const body = {
      ke3: keArray(1025),
      newRegistrationRecord: [1],
      newPasswordWrappedPrivateKey: 'wrapped',
      changePasswordSessionId: crypto.randomUUID(),
    };
    expect(changePasswordFinishBodySchema.safeParse(body).success).toBe(false);
  });
});
