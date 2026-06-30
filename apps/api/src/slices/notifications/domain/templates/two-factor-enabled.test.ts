import { describe, it, expect } from 'vitest';
import { twoFactorEnabledEmail } from './two-factor-enabled.js';

describe('twoFactorEnabledEmail', () => {
  it('contains the 2FA enabled title', () => {
    const result = twoFactorEnabledEmail({});

    expect(result.html).toContain('Two-Factor Authentication Enabled');
  });

  it('greets the user by name when provided', () => {
    const result = twoFactorEnabledEmail({ userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = twoFactorEnabledEmail({});

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });

  it('contains the security contact', () => {
    const result = twoFactorEnabledEmail({});

    expect(result.html).toContain('security@hushbox.ai');
    expect(result.text).toContain('security@hushbox.ai');
  });
});
