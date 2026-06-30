import { describe, it, expect } from 'vitest';
import { accountLockedEmail } from './account-locked.js';

describe('accountLockedEmail', () => {
  it('contains the account locked title', () => {
    const result = accountLockedEmail({ lockoutMinutes: 15 });

    expect(result.html).toContain('Account Temporarily Locked');
  });

  it('states the lockout duration', () => {
    const result = accountLockedEmail({ lockoutMinutes: 15 });

    expect(result.html).toContain('15 minutes');
  });

  it('handles a different lockout duration', () => {
    const result = accountLockedEmail({ lockoutMinutes: 30 });

    expect(result.html).toContain('30 minutes');
    expect(result.html).not.toContain('15 minutes');
  });

  it('greets the user by name when provided', () => {
    const result = accountLockedEmail({ userName: 'Alice', lockoutMinutes: 15 });

    expect(result.html).toContain('Hi Alice,');
  });

  it('uses a generic greeting when no user name is provided', () => {
    const result = accountLockedEmail({ lockoutMinutes: 15 });

    expect(result.html).toContain('Hi,');
    expect(result.html).not.toContain('undefined');
  });

  it('warns about the failed sign-in attempts', () => {
    const result = accountLockedEmail({ lockoutMinutes: 15 });

    expect(result.html).toContain('failed sign-in attempts');
    expect(result.text).toContain('failed sign-in attempts');
  });
});
