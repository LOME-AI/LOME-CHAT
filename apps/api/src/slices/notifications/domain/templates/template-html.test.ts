import { describe, expect, it } from 'vitest';
import { accountDeletedEmail } from './account-deleted.js';
import { accountLockedEmail } from './account-locked.js';
import { chargebackLockEmail } from './chargeback-lock.js';
import { passwordChangedEmail } from './password-changed.js';
import { twoFactorDisabledEmail } from './two-factor-disabled.js';
import { twoFactorEnabledEmail } from './two-factor-enabled.js';
import { welcomeEmail } from './welcome.js';

// Characterization snapshots pinning the rendered HTML of every template
// refactored onto the `heading()`/`paragraph()` builder helpers. The snapshots
// are captured from the pre-refactor markup, so the refactor is proven
// byte-identical: any drift in the rendered HTML fails here.
describe('template html is byte-stable across the builder-helper refactor', () => {
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
