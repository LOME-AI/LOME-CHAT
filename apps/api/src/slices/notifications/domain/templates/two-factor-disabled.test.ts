import { describe, it, expect } from 'vitest';
import { twoFactorDisabledEmail } from './two-factor-disabled.js';

describe('twoFactorDisabledEmail', () => {
  it('contains the 2FA disabled title', () => {
    const result = twoFactorDisabledEmail({});

    expect(result.html).toContain('Two-Factor Authentication Disabled');
  });

  it('recommends re-enabling 2FA', () => {
    const result = twoFactorDisabledEmail({});

    expect(result.html).toContain('re-enabling 2FA');
  });

  it('greets the user by name when provided', () => {
    const result = twoFactorDisabledEmail({ userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = twoFactorDisabledEmail({});

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });

  it('contains the security contact', () => {
    const result = twoFactorDisabledEmail({});

    expect(result.html).toContain('security@hushbox.ai');
    expect(result.text).toContain('security@hushbox.ai');
  });
});
