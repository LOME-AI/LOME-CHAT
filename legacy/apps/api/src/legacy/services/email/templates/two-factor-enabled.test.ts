import { describe, it, expect } from 'vitest';
import { twoFactorEnabledEmail } from './two-factor-enabled.js';

describe('twoFactorEnabledEmail', () => {
  describe('html output', () => {
    it('contains the two-factor enabled title', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).toContain('Two-Factor Authentication Enabled');
    });

    it('contains user name when provided', () => {
      const result = twoFactorEnabledEmail({ userName: 'John Doe' });

      expect(result.html).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).not.toContain('undefined');
      expect(result.html).not.toContain('null');
    });

    it('contains the footer with copyright', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('contains contact email', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).toContain('hello@hushbox.ai');
    });

    it('uses dark mode styling', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });

    it('contains two-factor enabled message', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).toContain('Two-factor authentication has been enabled');
      expect(result.html).toContain('authenticator app');
    });

    it('contains security warning', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).toContain('security@hushbox.ai');
    });

    it('security email link uses accent color', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.html).toContain('security@hushbox.ai');
      expect(result.html).toContain('#ec4755');
    });
  });

  describe('text output', () => {
    it('contains the two-factor enabled title', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.text).toContain('Two-Factor Authentication Enabled');
    });

    it('contains user name when provided', () => {
      const result = twoFactorEnabledEmail({ userName: 'John Doe' });

      expect(result.text).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.text).not.toContain('undefined');
      expect(result.text).not.toContain('null');
    });

    it('contains footer with copyright', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.text).toContain('LOME-AI LLC');
    });

    it('contains two-factor enabled message', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.text).toContain('Two-factor authentication has been enabled');
      expect(result.text).toContain('authenticator app');
    });

    it('contains security warning', () => {
      const result = twoFactorEnabledEmail({});

      expect(result.text).toContain('security@hushbox.ai');
    });
  });
});
