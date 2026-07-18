import { describe, expect, it } from 'vitest';
import {
  NEWSLETTER_CONFIRM_TTL_MS,
  NEWSLETTER_CONSENT_SOURCES,
  NEWSLETTER_CONSENT_TEXT_VERSION,
  NEWSLETTER_DEFAULT_TOPIC,
  NEWSLETTER_DELIVERY_STATUSES,
  NEWSLETTER_ISSUE_STATUSES,
  NEWSLETTER_POSTAL_ADDRESS,
  NEWSLETTER_STATUSES,
  NEWSLETTER_SUPPRESS_REASONS,
  NewsletterStatus,
} from './newsletter.js';
import { NEWSLETTER_STATUSES as BarrelStatuses } from './index.js';

describe('newsletter constants', () => {
  it('names the default topic', () => {
    expect(NEWSLETTER_DEFAULT_TOPIC).toBe('general');
  });

  it('closes the subscriber status set', () => {
    expect(NEWSLETTER_STATUSES).toEqual(['pending', 'subscribed', 'unsubscribed', 'suppressed']);
  });

  it('closes the suppression reason set', () => {
    expect(NEWSLETTER_SUPPRESS_REASONS).toEqual(['bounce', 'complaint']);
  });

  it('closes the issue status set', () => {
    expect(NEWSLETTER_ISSUE_STATUSES).toEqual(['scheduled', 'canceled', 'sending', 'sent']);
  });

  it('closes the delivery status set', () => {
    expect(NEWSLETTER_DELIVERY_STATUSES).toEqual(['claimed', 'sent', 'failed']);
  });

  it('closes the consent source set', () => {
    expect(NEWSLETTER_CONSENT_SOURCES).toEqual(['marketing_site', 'app_settings']);
  });

  it('pins the consent text version', () => {
    expect(NEWSLETTER_CONSENT_TEXT_VERSION).toBe('2026-07-17');
  });

  it('sets the confirm-token TTL to 24 hours', () => {
    expect(NEWSLETTER_CONFIRM_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('names the CAN-SPAM postal address', () => {
    expect(NEWSLETTER_POSTAL_ADDRESS).toBe(
      '8465 Keystone Crossing, Ste 115, Indianapolis IN 46240'
    );
  });

  it('is re-exported from the package barrel', () => {
    expect(BarrelStatuses).toBe(NEWSLETTER_STATUSES);
  });
});

describe('NewsletterStatus schema', () => {
  it('accepts every registered status', () => {
    for (const status of NEWSLETTER_STATUSES) {
      expect(NewsletterStatus.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    expect(NewsletterStatus.safeParse('bounced').success).toBe(false);
  });
});
