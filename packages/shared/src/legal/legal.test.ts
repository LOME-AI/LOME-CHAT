import { describe, it, expect } from 'vitest';
import {
  PRIVACY_POLICY_META,
  PRIVACY_SECTIONS,
  TERMS_OF_SERVICE_META,
  TERMS_SECTIONS,
} from './index.js';
import {
  PRIVACY_POLICY_EFFECTIVE_DATE,
  TERMS_OF_SERVICE_EFFECTIVE_DATE,
  PRIVACY_CONTACT_EMAIL,
  BILLING_CONTACT_EMAIL,
} from '../constants.js';
import { TOTAL_FEE_RATE, STORAGE_COST_PER_1K_CHARS } from '../affordability/constants.js';
import { ALL_FEE_CATEGORIES, FEE_CATEGORIES, formatFeePercent } from '../affordability/fees.js';
import type { LegalSection } from './types.js';

function assertValidSections(sections: LegalSection[]): void {
  const ids = sections.map((s) => s.id);
  const uniqueIds = new Set(ids);

  it('has no duplicate IDs', () => {
    expect(ids.length).toBe(uniqueIds.size);
  });

  for (const section of sections) {
    describe(section.id, () => {
      it('has a non-empty title', () => {
        expect(section.title.length).toBeGreaterThan(0);
      });

      it('has a non-empty simplyPut summary', () => {
        expect(section.simplyPut.length).toBeGreaterThan(0);
      });

      it('has at least one point', () => {
        expect(section.points.length).toBeGreaterThan(0);
      });

      it('has non-empty points', () => {
        for (const point of section.points) {
          expect(point.length).toBeGreaterThan(0);
        }
      });

      it('has an id matching kebab-case format', () => {
        expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
      });
    });
  }
}

describe('Privacy Policy', () => {
  describe('PRIVACY_POLICY_META', () => {
    it('has the correct title', () => {
      expect(PRIVACY_POLICY_META.title).toBe('Privacy Policy');
    });

    it('uses the effective date from constants', () => {
      expect(PRIVACY_POLICY_META.effectiveDate).toBe(PRIVACY_POLICY_EFFECTIVE_DATE);
    });

    it('uses the privacy contact email from constants', () => {
      expect(PRIVACY_POLICY_META.contactEmail).toBe(PRIVACY_CONTACT_EMAIL);
    });
  });

  describe('PRIVACY_SECTIONS', () => {
    it('has exactly 9 sections', () => {
      expect(PRIVACY_SECTIONS).toHaveLength(9);
    });

    it('starts with data-collection section', () => {
      expect(PRIVACY_SECTIONS[0]!.id).toBe('data-collection');
    });

    it('ends with contact section', () => {
      expect(PRIVACY_SECTIONS.at(-1)!.id).toBe('contact');
    });

    it('includes encryption-security section', () => {
      const section = PRIVACY_SECTIONS.find((s) => s.id === 'encryption-security');
      expect(section).toBeDefined();
    });

    assertValidSections(PRIVACY_SECTIONS);
  });

  describe('content constraints', () => {
    it('does not mention iron-session', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('iron-session');
    });

    it('does not mention PostHog', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('posthog');
    });

    it('does not mention the AI gateway provider by name', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('openrouter');
      expect(allText.toLowerCase()).not.toContain('vercel');
    });

    it('does not promise data export', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('export your data');
    });

    it('promises account deletion in plain language', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).toContain('delete your account');
    });

    it('promises a 90-day retention for the deletion event record', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      const lower = allText.toLowerCase();
      expect(lower).toContain('90 days');
      const ninetyDaysIndex = lower.indexOf('90 days');
      const deletionIndex = lower.indexOf('deletion', Math.max(0, ninetyDaysIndex - 200));
      expect(deletionIndex).toBeGreaterThanOrEqual(0);
      expect(Math.abs(deletionIndex - ninetyDaysIndex)).toBeLessThan(200);
    });

    it('promises encryption keys are destroyed on account deletion', () => {
      const retentionSection = PRIVACY_SECTIONS.find((s) => s.id === 'data-retention');
      expect(retentionSection).toBeDefined();
      const sectionText = [
        retentionSection!.title,
        retentionSection!.simplyPut,
        ...retentionSection!.points,
      ]
        .join(' ')
        .toLowerCase();
      expect(sectionText).toContain('encryption keys');
      expect(sectionText).toContain('destroyed');
    });
  });
});

describe('Terms of Service', () => {
  describe('TERMS_OF_SERVICE_META', () => {
    it('has the correct title', () => {
      expect(TERMS_OF_SERVICE_META.title).toBe('Terms of Service');
    });

    it('uses the effective date from constants', () => {
      expect(TERMS_OF_SERVICE_META.effectiveDate).toBe(TERMS_OF_SERVICE_EFFECTIVE_DATE);
    });

    it('uses the billing contact email from constants', () => {
      expect(TERMS_OF_SERVICE_META.contactEmail).toBe(BILLING_CONTACT_EMAIL);
    });
  });

  describe('TERMS_SECTIONS', () => {
    it('has exactly 13 sections', () => {
      expect(TERMS_SECTIONS).toHaveLength(13);
    });

    it('starts with acceptance section', () => {
      expect(TERMS_SECTIONS[0]!.id).toBe('acceptance');
    });

    it('ends with changes section', () => {
      expect(TERMS_SECTIONS.at(-1)!.id).toBe('changes');
    });

    it('includes intellectual-property section', () => {
      const section = TERMS_SECTIONS.find((s) => s.id === 'intellectual-property');
      expect(section).toBeDefined();
    });

    assertValidSections(TERMS_SECTIONS);
  });

  describe('content constraints', () => {
    it('does not mention OpenRouter by name', () => {
      const allText = TERMS_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(' ');
      expect(allText.toLowerCase()).not.toContain('openrouter');
    });

    it('disclaims ownership of AI outputs in IP section', () => {
      const ipSection = TERMS_SECTIONS.find((s) => s.id === 'intellectual-property');
      expect(ipSection).toBeDefined();
      const allPoints = ipSection!.points.join(' ').toLowerCase();
      expect(allPoints).toContain('never claim ownership');
    });

    it('states no refunds in payment section', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ').toLowerCase();
      expect(allPoints).toContain('final');
    });

    it('references the total fee rate from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).toContain(formatFeePercent(TOTAL_FEE_RATE));
    });

    it('references every non-zero fee category by percent and label', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      for (const category of FEE_CATEGORIES) {
        expect(allPoints).toContain(formatFeePercent(category.rate));
        expect(allPoints).toContain(category.label);
      }
    });

    it('does not mention any zero-rate fee category label', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      for (const category of ALL_FEE_CATEGORIES) {
        if (category.rate === 0) {
          expect(allPoints).not.toContain(category.label);
        }
      }
    });

    it('includes the breakdown bullet iff at least one fee is non-zero', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      if (FEE_CATEGORIES.length > 0) {
        expect(allPoints).toContain('Fee breakdown:');
      } else {
        expect(allPoints).not.toContain('Fee breakdown:');
      }
    });

    it('does not contain a malformed empty breakdown ("Fee breakdown: .")', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).not.toMatch(/Fee breakdown:\s*\./);
    });

    it('references storage cost from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).toContain(`$${String(STORAGE_COST_PER_1K_CHARS)}`);
    });

    it('specifies Indiana as governing law', () => {
      const govSection = TERMS_SECTIONS.find((s) => s.id === 'governing-law');
      expect(govSection).toBeDefined();
      const allPoints = govSection!.points.join(' ');
      expect(allPoints).toContain('Indiana');
    });

    it('grants an explicit account-deletion right in the termination section', () => {
      const terminationSection = TERMS_SECTIONS.find((s) => s.id === 'termination');
      expect(terminationSection).toBeDefined();
      const sectionText = [
        terminationSection!.title,
        terminationSection!.simplyPut,
        ...terminationSection!.points,
      ]
        .join(' ')
        .toLowerCase();
      expect(sectionText).toContain('delete your account');
    });
  });
});

// Uncoverable branch note: terms-sections.ts evaluates
// `FEE_CATEGORIES.length > 0 ? [...] : []` once at module load against the
// imported fee constants. The empty-list arm is a deliberate guard for a
// future zero-fee configuration; with the current FEE_CATEGORIES it cannot
// execute, and re-evaluating it would require mocking an internal module,
// which the testing rules forbid.
