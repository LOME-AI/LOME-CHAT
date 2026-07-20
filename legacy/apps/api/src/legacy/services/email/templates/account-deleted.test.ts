import { describe, it, expect } from 'vitest';
import { accountDeletedEmail } from './account-deleted.js';

describe('accountDeletedEmail', () => {
  describe('html output', () => {
    it('contains the account deleted title', () => {
      const result = accountDeletedEmail({});

      expect(result.html).toContain('Account Permanently Deleted');
    });

    it('contains the permanent deletion message', () => {
      const result = accountDeletedEmail({});

      expect(result.html).toContain('permanently deleted');
    });

    it('contains the security contact', () => {
      const result = accountDeletedEmail({});

      expect(result.html).toContain('security@hushbox.ai');
    });

    it('contains the footer with copyright', () => {
      const result = accountDeletedEmail({});

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('contains contact email', () => {
      const result = accountDeletedEmail({});

      expect(result.html).toContain('hello@hushbox.ai');
    });

    it('uses dark mode styling', () => {
      const result = accountDeletedEmail({});

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });

    it('security email link uses accent color', () => {
      const result = accountDeletedEmail({});

      expect(result.html).toContain('#ec4755');
    });
  });

  describe('text output', () => {
    it('contains the account deleted title', () => {
      const result = accountDeletedEmail({});

      expect(result.text).toContain('Account Permanently Deleted');
    });

    it('contains the permanent deletion message', () => {
      const result = accountDeletedEmail({});

      expect(result.text).toContain('permanently deleted');
    });

    it('contains the security contact', () => {
      const result = accountDeletedEmail({});

      expect(result.text).toContain('security@hushbox.ai');
    });

    it('contains footer with copyright', () => {
      const result = accountDeletedEmail({});

      expect(result.text).toContain('LOME-AI LLC');
    });
  });
});
