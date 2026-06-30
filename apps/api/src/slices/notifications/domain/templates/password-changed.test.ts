import { describe, it, expect } from 'vitest';
import { passwordChangedEmail } from './password-changed.js';

describe('passwordChangedEmail', () => {
  it('contains the password changed title', () => {
    const result = passwordChangedEmail({});

    expect(result.html).toContain('Password Changed');
  });

  it('mentions that other sessions were signed out', () => {
    const result = passwordChangedEmail({});

    expect(result.html).toContain('All other sessions have been signed out');
  });

  it('greets the user by name when provided', () => {
    const result = passwordChangedEmail({ userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = passwordChangedEmail({});

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });

  it('contains the security contact', () => {
    const result = passwordChangedEmail({});

    expect(result.html).toContain('security@hushbox.ai');
    expect(result.text).toContain('security@hushbox.ai');
  });
});
