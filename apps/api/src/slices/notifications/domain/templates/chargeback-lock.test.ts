import { describe, it, expect } from 'vitest';
import { BILLING_CONTACT_EMAIL } from '@hushbox/shared';
import { chargebackLockEmail } from './chargeback-lock.js';

describe('chargebackLockEmail', () => {
  it('states the account is locked', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain('Account Locked');
  });

  it('references the payment dispute in both bodies', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain('dispute');
    expect(result.text).toContain('dispute');
  });

  it('directs the user to the billing support address', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain(BILLING_CONTACT_EMAIL);
    expect(result.text).toContain(BILLING_CONTACT_EMAIL);
  });

  it('carries no lockout-duration copy', () => {
    const result = chargebackLockEmail({});

    expect(result.text).not.toContain('minutes');
    expect(result.html).not.toContain('minutes');
  });

  it('greets the user by name when provided', () => {
    const result = chargebackLockEmail({ userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = chargebackLockEmail({});

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });
});
