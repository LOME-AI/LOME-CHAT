import { describe, it, expect } from 'vitest';
import { accountLockedEmail } from './account-locked.js';

describe('accountLockedEmail', () => {
  describe('html output', () => {
    it('contains the account locked title', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).toContain('Account Temporarily Locked');
    });

    it('contains user name when provided', () => {
      const result = accountLockedEmail({
        userName: 'John Doe',
        lockoutMinutes: 15,
      });

      expect(result.html).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).not.toContain('undefined');
      expect(result.html).not.toContain('null');
    });

    it('contains the footer with copyright', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('contains contact email', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).toContain('hello@hushbox.ai');
    });

    it('uses dark mode styling', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });

    it('contains account locked message', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).toContain('temporarily locked');
      expect(result.html).toContain('failed sign-in attempts');
    });

    it('contains lockout duration', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).toContain('15 minutes');
    });

    it('handles different lockout durations', () => {
      const result = accountLockedEmail({ lockoutMinutes: 30 });

      expect(result.html).toContain('30 minutes');
      expect(result.html).not.toContain('15 minutes');
    });

    it('contains security warning', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.html).toContain('someone may be trying to access your account');
      expect(result.html).toContain('changing your password');
    });
  });

  describe('text output', () => {
    it('contains the account locked title', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.text).toContain('Account Temporarily Locked');
    });

    it('contains user name when provided', () => {
      const result = accountLockedEmail({
        userName: 'John Doe',
        lockoutMinutes: 15,
      });

      expect(result.text).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.text).not.toContain('undefined');
      expect(result.text).not.toContain('null');
    });

    it('contains footer with copyright', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.text).toContain('LOME-AI LLC');
    });

    it('contains account locked message', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.text).toContain('temporarily locked');
      expect(result.text).toContain('failed sign-in attempts');
    });

    it('contains lockout duration', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.text).toContain('15 minutes');
    });

    it('handles different lockout durations', () => {
      const result = accountLockedEmail({ lockoutMinutes: 30 });

      expect(result.text).toContain('30 minutes');
      expect(result.text).not.toContain('15 minutes');
    });

    it('contains security warning', () => {
      const result = accountLockedEmail({ lockoutMinutes: 15 });

      expect(result.text).toContain('someone may be trying to access your account');
      expect(result.text).toContain('changing your password');
    });
  });
});
