import { pgEnum } from 'drizzle-orm/pg-core';
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  MEMBER_PRIVILEGES,
  MODALITIES,
  NEWSLETTER_CONSENT_SOURCES,
  NEWSLETTER_DELIVERY_STATUSES,
  NEWSLETTER_ISSUE_STATUSES,
  NEWSLETTER_STATUSES,
  NEWSLETTER_SUPPRESS_REASONS,
  USER_LOCK_REASONS,
} from '@hushbox/shared';

/**
 * pgEnums for every status/type/privilege field and for modality. The
 * modality enum derives from the single shared MODALITIES const — the one
 * source feeding the pgEnum, the Zod contracts, and the dispatch types.
 */
export const modalityEnum = pgEnum('modality', MODALITIES);

/** Job state machine. */
export const jobStatusEnum = pgEnum('job_status', [
  'pending',
  'running',
  'succeeded',
  'cancelled',
  'dead',
]);

/** Dispatcher shards (one Durable Object per shard). */
export const jobShardEnum = pgEnum('job_shard', ['default', 'bulk']);

/**
 * ledger_entries.kind discriminator. OpenRouter returns the authoritative cost
 * inline, so settlement charges it directly with no async reconcile leg; rare
 * manual cost corrections use charge/refund.
 */
export const ledgerEntryKindEnum = pgEnum('ledger_entry_kind', [
  'deposit',
  'charge',
  'clawback',
  'promo',
  'refund',
]);

/** House accounts beside user wallets (double-entry counterlegs). */
export const houseAccountEnum = pgEnum('house_account', ['revenue', 'payments-in', 'promo']);

/**
 * Pre-claim lifecycle: pending → awaiting_webhook →
 * completed/failed, with expired for pre-claims the verify job gives up on.
 */
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'awaiting_webhook',
  'completed',
  'failed',
  'expired',
]);

/** Dual-lifecycle split: request dedup vs the run-settlement referee. */
export const idempotencyKeyKindEnum = pgEnum('idempotency_key_kind', ['request', 'run']);

/** Outcome state machine (the unique insert is the claim). */
export const idempotencyKeyStatusEnum = pgEnum('idempotency_key_status', [
  'claimed',
  'succeeded',
  'failed',
]);

/** One purchased + one free-tier wallet per user. */
export const walletTypeEnum = pgEnum('wallet_type', ['purchased', 'free']);

/** Derives from the single shared MEMBER_PRIVILEGES const (same pattern as modality). */
export const memberPrivilegeEnum = pgEnum('member_privilege', MEMBER_PRIVILEGES);

export const messageSenderTypeEnum = pgEnum('message_sender_type', ['user', 'assistant', 'system']);

/** Content modalities that rest as content_items (modality minus embedding). */
export const contentItemTypeEnum = pgEnum('content_item_type', ['text', 'image', 'audio', 'video']);

export const devicePlatformEnum = pgEnum('device_platform', ['ios', 'android']);

/**
 * Chargeback auto-defense vs explicit admin lock. Derives from the single
 * shared USER_LOCK_REASONS const (same pattern as modality).
 */
export const userLockReasonEnum = pgEnum('user_lock_reason', USER_LOCK_REASONS);

export const verificationPurposeEnum = pgEnum('verification_purpose', ['email_verification']);

/** Derives from the single shared FEEDBACK_KINDS const (same pattern as modality). */
export const feedbackKindEnum = pgEnum('feedback_kind', FEEDBACK_KINDS);

/** Derives from the single shared FEEDBACK_STATUSES const (admin triage state machine). */
export const feedbackStatusEnum = pgEnum('feedback_status', FEEDBACK_STATUSES);

/** Derives from the single shared NEWSLETTER_STATUSES const (subscriber lifecycle). */
export const newsletterStatusEnum = pgEnum('newsletter_status', NEWSLETTER_STATUSES);

/** Derives from the single shared NEWSLETTER_SUPPRESS_REASONS const (provider-signaled only). */
export const newsletterSuppressReasonEnum = pgEnum(
  'newsletter_suppress_reason',
  NEWSLETTER_SUPPRESS_REASONS
);

/** Derives from the single shared NEWSLETTER_ISSUE_STATUSES const (issue lifecycle). */
export const newsletterIssueStatusEnum = pgEnum(
  'newsletter_issue_status',
  NEWSLETTER_ISSUE_STATUSES
);

/** Derives from the single shared NEWSLETTER_DELIVERY_STATUSES const (per-recipient state). */
export const newsletterDeliveryStatusEnum = pgEnum(
  'newsletter_delivery_status',
  NEWSLETTER_DELIVERY_STATUSES
);

/** Derives from the single shared NEWSLETTER_CONSENT_SOURCES const (where consent was given). */
export const newsletterConsentSourceEnum = pgEnum(
  'newsletter_consent_source',
  NEWSLETTER_CONSENT_SOURCES
);
