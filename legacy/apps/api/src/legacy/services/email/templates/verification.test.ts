import { describe, it, expect } from 'vitest';
import { verificationEmail } from './verification.js';

describe('verificationEmail', () => {
  const testUrl = 'https://hushbox.ai/verify?token=abc123';

  describe('html output', () => {
    it('contains the verification URL', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.html).toContain(testUrl);
    });

    it('contains user name when provided', () => {
      const result = verificationEmail({
        verificationUrl: testUrl,
        userName: 'John Doe',
      });

      expect(result.html).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.html).not.toContain('undefined');
      expect(result.html).not.toContain('null');
    });

    it('contains the verify button', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.html).toContain('Verify Email');
    });

    it('contains the footer with copyright', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('contains contact email', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.html).toContain('hello@hushbox.ai');
    });

    it('defaults expiration to 24 hours', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.html).toContain('24 hours');
    });

    it('uses custom expiration time when provided', () => {
      const result = verificationEmail({
        verificationUrl: testUrl,
        expiresInHours: 48,
      });

      expect(result.html).toContain('48 hours');
      expect(result.html).not.toContain('24 hours');
    });

    it('uses dark mode styling', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });
  });

  describe('text output', () => {
    it('contains the verification URL', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.text).toContain(testUrl);
    });

    it('contains user name when provided', () => {
      const result = verificationEmail({
        verificationUrl: testUrl,
        userName: 'John Doe',
      });

      expect(result.text).toContain('John Doe');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.text).not.toContain('undefined');
      expect(result.text).not.toContain('null');
    });

    it('defaults expiration to 24 hours', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.text).toContain('24 hours');
    });

    it('uses custom expiration time when provided', () => {
      const result = verificationEmail({
        verificationUrl: testUrl,
        expiresInHours: 48,
      });

      expect(result.text).toContain('48 hours');
      expect(result.text).not.toContain('24 hours');
    });

    it('contains footer with copyright', () => {
      const result = verificationEmail({ verificationUrl: testUrl });

      expect(result.text).toContain('LOME-AI LLC');
    });
  });
});
