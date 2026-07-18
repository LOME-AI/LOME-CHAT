import { z } from 'zod';

/**
 * The launch mailing-list topic. Subscriptions are topic-keyed so a second
 * list is a data change, not a schema change.
 */
export const NEWSLETTER_DEFAULT_TOPIC = 'general';

/**
 * The closed subscriber lifecycle set. One source feeding the pgEnum, the
 * Zod contracts, and the admin wire schemas — adding a member is a
 * deliberate enum migration, never ad-hoc data.
 */
export const NEWSLETTER_STATUSES = ['pending', 'subscribed', 'unsubscribed', 'suppressed'] as const;

/** Zod schema for subscriber-status validation. */
export const NewsletterStatus = z.enum(NEWSLETTER_STATUSES);

/** TypeScript type for a subscriber status. */
export type NewsletterStatus = z.infer<typeof NewsletterStatus>;

/**
 * Why a subscriber was suppressed (provider-signaled, never user-initiated).
 * Feeds the pgEnum.
 */
export const NEWSLETTER_SUPPRESS_REASONS = ['bounce', 'complaint'] as const;

/** Zod schema for suppress-reason validation. */
export const NewsletterSuppressReason = z.enum(NEWSLETTER_SUPPRESS_REASONS);

/** TypeScript type for a suppress reason. */
export type NewsletterSuppressReason = z.infer<typeof NewsletterSuppressReason>;

/** The closed issue lifecycle set. Feeds the pgEnum and the admin op guards. */
export const NEWSLETTER_ISSUE_STATUSES = ['scheduled', 'canceled', 'sending', 'sent'] as const;

/** Zod schema for issue-status validation. */
export const NewsletterIssueStatus = z.enum(NEWSLETTER_ISSUE_STATUSES);

/** TypeScript type for an issue status. */
export type NewsletterIssueStatus = z.infer<typeof NewsletterIssueStatus>;

/** The closed per-recipient delivery state set. Feeds the pgEnum. */
export const NEWSLETTER_DELIVERY_STATUSES = ['claimed', 'sent', 'failed'] as const;

/** Zod schema for delivery-status validation. */
export const NewsletterDeliveryStatus = z.enum(NEWSLETTER_DELIVERY_STATUSES);

/** TypeScript type for a delivery status. */
export type NewsletterDeliveryStatus = z.infer<typeof NewsletterDeliveryStatus>;

/**
 * Where consent was captured. Recorded per subscriber alongside the consent
 * text version — the compliance evidence pair. Feeds the pgEnum.
 */
export const NEWSLETTER_CONSENT_SOURCES = ['marketing_site', 'app_settings'] as const;

/** Zod schema for consent-source validation. */
export const NewsletterConsentSource = z.enum(NEWSLETTER_CONSENT_SOURCES);

/** TypeScript type for a consent source. */
export type NewsletterConsentSource = z.infer<typeof NewsletterConsentSource>;

/**
 * Version stamp of the consent copy shown at signup. Bump whenever the
 * user-facing consent wording changes; stored per subscriber as evidence of
 * exactly what they agreed to.
 */
export const NEWSLETTER_CONSENT_TEXT_VERSION = '2026-07-17';

/** Lifetime of a double-opt-in confirm token. */
export const NEWSLETTER_CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * CAN-SPAM requires a valid physical postal address in every marketing
 * email; single source for the email footer templates.
 */
export const NEWSLETTER_POSTAL_ADDRESS = '8465 Keystone Crossing, Ste 115, Indianapolis IN 46240';
