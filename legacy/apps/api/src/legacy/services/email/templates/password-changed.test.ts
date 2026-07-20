import { describe, it, expect } from 'vitest';
import { passwordChangedEmail } from './password-changed.js';

describe('passwordChangedEmail', () => {
  describe('html output', () => {
    it('contains the password changed title', () => {
      const result = passwordChangedEmail({});

      expect(result.html).toContain('Password Changed');
    });

    it('contains user name when provided', () => {
      const result = passwordChangedEmail({ userName: 'John Doe' });

      expect(result.html).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = passwordChangedEmail({});

      expect(result.html).not.toContain('undefined');
      expect(result.html).not.toContain('null');
    });

    it('contains the footer with copyright', () => {
      const result = passwordChangedEmail({});

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('contains contact email', () => {
      const result = passwordChangedEmail({});

      expect(result.html).toContain('hello@hushbox.ai');
    });

    it('uses dark mode styling', () => {
      const result = passwordChangedEmail({});

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });

    it('contains password changed message', () => {
      const result = passwordChangedEmail({});

      expect(result.html).toContain('Your password was just changed');
      expect(result.html).toContain('All other sessions have been signed out');
    });

    it('contains security warning', () => {
      const result = passwordChangedEmail({});

      expect(result.html).toContain('security@hushbox.ai');
    });

    it('security email link uses accent color', () => {
      const result = passwordChangedEmail({});

      expect(result.html).toContain('security@hushbox.ai');
      expect(result.html).toContain('#ec4755');
    });
  });

  describe('text output', () => {
    it('contains the password changed title', () => {
      const result = passwordChangedEmail({});

      expect(result.text).toContain('Password Changed');
    });

    it('contains user name when provided', () => {
      const result = passwordChangedEmail({ userName: 'John Doe' });

      expect(result.text).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = passwordChangedEmail({});

      expect(result.text).not.toContain('undefined');
      expect(result.text).not.toContain('null');
    });

    it('contains footer with copyright', () => {
      const result = passwordChangedEmail({});

      expect(result.text).toContain('LOME-AI LLC');
    });

    it('contains password changed message', () => {
      const result = passwordChangedEmail({});

      expect(result.text).toContain('Your password was just changed');
      expect(result.text).toContain('All other sessions have been signed out');
    });

    it('contains security warning', () => {
      const result = passwordChangedEmail({});

      expect(result.text).toContain('security@hushbox.ai');
    });
  });
});
