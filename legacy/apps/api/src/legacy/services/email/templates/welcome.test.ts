import { describe, it, expect } from 'vitest';
import {
  ALL_FEE_CATEGORIES,
  FEE_CATEGORIES,
  formatFeePercent,
  TOTAL_FEE_RATE,
} from '@hushbox/shared';
import { welcomeEmail } from './welcome.js';

describe('welcomeEmail', () => {
  describe('html output', () => {
    it('contains the welcome title', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('Welcome to HushBox');
    });

    it('uses the canonical product tagline', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('One interface. Every feature. Private.');
    });

    it('contains user name when provided', () => {
      const result = welcomeEmail({ userName: 'Alice' });

      expect(result.html).toContain('Alice');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = welcomeEmail({});

      expect(result.html).not.toContain('undefined');
      expect(result.html).not.toContain('null');
    });

    it('explains pay-as-you-go billing', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('pay-as-you-go');
    });

    it('renders the total fee rate as the headline percent', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain(formatFeePercent(TOTAL_FEE_RATE));
    });

    it('renders one row per non-zero fee category with its short label and percent', () => {
      const result = welcomeEmail({});

      for (const category of FEE_CATEGORIES) {
        expect(result.html).toContain(formatFeePercent(category.rate));
        expect(result.html).toContain(category.shortLabel);
      }
    });

    it('does not render any row for a zero-rate fee category', () => {
      const result = welcomeEmail({});

      for (const category of ALL_FEE_CATEGORIES) {
        if (category.rate === 0) {
          expect(result.html).not.toContain(category.shortLabel);
        }
      }
    });

    it('explains how to add credits', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('Billing');
      expect(result.html).toContain('credits');
    });

    it('contains mobile app billing note', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('Manage Balance Online');
    });

    it('contains the footer with copyright', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('LOME-AI LLC');
    });

    it('uses dark mode styling', () => {
      const result = welcomeEmail({});

      expect(result.html).toContain('#0a0a0a');
      expect(result.html).toContain('#171717');
    });

    it('HTML-escapes user name', () => {
      const result = welcomeEmail({ userName: '<script>alert("xss")</script>' });

      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).not.toContain('<script>alert');
    });
  });

  describe('text output', () => {
    it('contains the welcome title', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('Welcome to HushBox');
    });

    it('uses the canonical product tagline', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('One interface. Every feature. Private.');
    });

    it('contains user name when provided', () => {
      const result = welcomeEmail({ userName: 'Alice' });

      expect(result.text).toContain('Alice');
    });

    it('uses generic greeting when no user name provided', () => {
      const result = welcomeEmail({});

      expect(result.text).not.toContain('undefined');
      expect(result.text).not.toContain('null');
    });

    it('explains pay-as-you-go billing', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('pay-as-you-go');
    });

    it('renders the total fee rate as the headline percent', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain(formatFeePercent(TOTAL_FEE_RATE));
    });

    it('renders one bullet per non-zero fee category with its short label and percent', () => {
      const result = welcomeEmail({});

      for (const category of FEE_CATEGORIES) {
        expect(result.text).toContain(formatFeePercent(category.rate));
        expect(result.text).toContain(category.shortLabel);
      }
    });

    it('does not render any bullet for a zero-rate fee category', () => {
      const result = welcomeEmail({});

      for (const category of ALL_FEE_CATEGORIES) {
        if (category.rate === 0) {
          expect(result.text).not.toContain(category.shortLabel);
        }
      }
    });

    it('contains mobile app billing note', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('Manage Balance Online');
    });

    it('contains footer with copyright', () => {
      const result = welcomeEmail({});

      expect(result.text).toContain('LOME-AI LLC');
    });
  });
});
