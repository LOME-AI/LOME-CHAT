import { describe, it, expect } from 'vitest';
import { twoFactorDisabledEmail } from './two-factor-disabled.js';

describe('twoFactorDisabledEmail', () => {
  describe('html output', () => {
    it('contains the two-factor disabled title', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('Two-Factor Authentication Disabled');
    });

    it('contains user name when provided', () => {
      const result = twoFactorDisabledEmail({ userName: 'John Doe' });

      expect(result.html).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).not.toContain('undefined');
      expect(result.html).not.toContain('null');
    });

    it('contains the footer with copyright', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('contains contact email', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('hello@hushbox.ai');
    });

    it('uses dark mode styling', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });

    it('contains two-factor disabled message', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('Two-factor authentication has been removed');
      expect(result.html).toContain('password only');
    });

    it('contains recommendation to re-enable', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('re-enabling 2FA');
    });

    it('contains security warning', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('security@hushbox.ai');
    });

    it('security email link uses accent color', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.html).toContain('security@hushbox.ai');
      expect(result.html).toContain('#ec4755');
    });
  });

  describe('text output', () => {
    it('contains the two-factor disabled title', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.text).toContain('Two-Factor Authentication Disabled');
    });

    it('contains user name when provided', () => {
      const result = twoFactorDisabledEmail({ userName: 'John Doe' });

      expect(result.text).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.text).not.toContain('undefined');
      expect(result.text).not.toContain('null');
    });

    it('contains footer with copyright', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.text).toContain('LOME-AI LLC');
    });

    it('contains two-factor disabled message', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.text).toContain('Two-factor authentication has been removed');
      expect(result.text).toContain('password only');
    });

    it('contains recommendation to re-enable', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.text).toContain('re-enabling 2FA');
    });

    it('contains security warning', () => {
      const result = twoFactorDisabledEmail({});

      expect(result.text).toContain('security@hushbox.ai');
    });
  });
});
