import { describe, expect, it } from 'vitest';
import { accountDeletedEmail } from './account-deleted.js';
import { accountLockedEmail } from './account-locked.js';
import { chargebackLockEmail } from './chargeback-lock.js';
import { passwordChangedEmail } from './password-changed.js';
import { twoFactorDisabledEmail } from './two-factor-disabled.js';
import { twoFactorEnabledEmail } from './two-factor-enabled.js';
import { welcomeEmail } from './welcome.js';

// Byte-level pins on the rendered HTML of the templates below. Each of them
// renders through the shared base wrapper, so an edit there reaches every
// template at once; these snapshots are where that lands instead of in a
// delivered email. Re-record only against a source change you can point at.
describe('email template html is byte-stable', () => {
  it('welcome', () => {
    expect(welcomeEmail({ userName: 'Sam' }).html).toMatchSnapshot();
  });

  it('password-changed', () => {
    expect(passwordChangedEmail({ userName: 'Sam' }).html).toMatchSnapshot();
  });

  it('two-factor-enabled', () => {
    expect(twoFactorEnabledEmail({ userName: 'Sam' }).html).toMatchSnapshot();
  });

  it('two-factor-disabled', () => {
    expect(twoFactorDisabledEmail({ userName: 'Sam' }).html).toMatchSnapshot();
  });

  it('account-locked (login lockout)', () => {
    expect(accountLockedEmail({ userName: 'Sam', lockoutMinutes: 15 }).html).toMatchSnapshot();
  });

  it('account-deleted', () => {
    expect(accountDeletedEmail({}).html).toMatchSnapshot();
  });

  it('chargeback-lock', () => {
    expect(chargebackLockEmail({ userName: 'Sam' }).html).toMatchSnapshot();
  });
});
