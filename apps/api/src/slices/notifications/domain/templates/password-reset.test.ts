import { describe, it, expect } from 'vitest';
import { passwordResetEmail } from './password-reset.js';

describe('passwordResetEmail', () => {
  it('contains the password reset title', () => {
    const result = passwordResetEmail({});

    expect(result.html).toContain('Password Reset');
  });

  it('mentions the recovery phrase that authorized the reset', () => {
    const result = passwordResetEmail({});

    expect(result.html).toContain('recovery phrase');
  });

  it('mentions that other sessions were signed out', () => {
    const result = passwordResetEmail({});

    expect(result.html).toContain('All other sessions have been signed out');
  });

  it('greets the user by name when provided', () => {
    const result = passwordResetEmail({ userName: 'Alice' });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = passwordResetEmail({});

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });

  it('contains the security contact', () => {
    const result = passwordResetEmail({});

    expect(result.html).toContain('security@hushbox.ai');
    expect(result.text).toContain('security@hushbox.ai');
  });
});
