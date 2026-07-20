import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  LEDGER_ENTRY_KINDS,
  MEMBER_PRIVILEGES,
  MODALITIES,
  NEWSLETTER_CONSENT_SOURCES,
  NEWSLETTER_DELIVERY_STATUSES,
  NEWSLETTER_ISSUE_STATUSES,
  NEWSLETTER_STATUSES,
  NEWSLETTER_SUPPRESS_REASONS,
  PAYMENT_STATUSES,
} from '@hushbox/shared';

import {
  contentItemTypeEnum,
  devicePlatformEnum,
  feedbackKindEnum,
  feedbackStatusEnum,
  houseAccountEnum,
  idempotencyKeyKindEnum,
  idempotencyKeyStatusEnum,
  jobShardEnum,
  jobStatusEnum,
  ledgerEntryKindEnum,
  memberPrivilegeEnum,
  messageSenderTypeEnum,
  modalityEnum,
  newsletterConsentSourceEnum,
  newsletterDeliveryStatusEnum,
  newsletterIssueStatusEnum,
  newsletterStatusEnum,
  newsletterSuppressReasonEnum,
  paymentStatusEnum,
  userLockReasonEnum,
  verificationPurposeEnum,
  walletTypeEnum,
} from './index';

const ALL_ENUMS = [
  contentItemTypeEnum,
  devicePlatformEnum,
  feedbackKindEnum,
  feedbackStatusEnum,
  houseAccountEnum,
  idempotencyKeyKindEnum,
  idempotencyKeyStatusEnum,
  jobShardEnum,
  jobStatusEnum,
  ledgerEntryKindEnum,
  memberPrivilegeEnum,
  messageSenderTypeEnum,
  modalityEnum,
  newsletterConsentSourceEnum,
  newsletterDeliveryStatusEnum,
  newsletterIssueStatusEnum,
  newsletterStatusEnum,
  newsletterSuppressReasonEnum,
  paymentStatusEnum,
  userLockReasonEnum,
  verificationPurposeEnum,
  walletTypeEnum,
];

describe('pgEnums', () => {
  it('declares every enum in the public pg schema', () => {
    for (const e of ALL_ENUMS) {
      expect(e.schema).toBeUndefined();
    }
  });

  it('derives modality values from the single shared MODALITIES source', () => {
    expect(modalityEnum.enumValues).toEqual([...MODALITIES]);
  });

  it('derives member-privilege values from the single shared MEMBER_PRIVILEGES source', () => {
    expect(memberPrivilegeEnum.enumValues).toEqual([...MEMBER_PRIVILEGES]);
    // Byte-identical to the deployed pg enum — a drift here would generate a migration.
    expect(memberPrivilegeEnum.enumValues).toEqual(['read', 'write', 'admin', 'owner']);
  });

  it('derives feedback-kind values from the single shared FEEDBACK_KINDS source', () => {
    expect(feedbackKindEnum.enumValues).toEqual([...FEEDBACK_KINDS]);
  });

  it('derives feedback-status values from the single shared FEEDBACK_STATUSES source', () => {
    expect(feedbackStatusEnum.enumValues).toEqual([...FEEDBACK_STATUSES]);
  });

  it('declares the job_status state machine', () => {
    expect(jobStatusEnum.enumValues).toEqual([
      'pending',
      'running',
      'succeeded',
      'cancelled',
      'dead',
    ]);
  });

  it('declares the dispatcher shards', () => {
    expect(jobShardEnum.enumValues).toEqual(['default', 'bulk']);
  });

  it('derives ledger_entries.kind values from the single shared LEDGER_ENTRY_KINDS source', () => {
    expect(ledgerEntryKindEnum.enumValues).toEqual([...LEDGER_ENTRY_KINDS]);
    // Byte-identical to the deployed pg enum — a drift here would generate a migration.
    expect(ledgerEntryKindEnum.enumValues).toEqual([
      'deposit',
      'charge',
      'clawback',
      'promo',
      'refund',
    ]);
  });

  it('derives payment_status values from the single shared PAYMENT_STATUSES source', () => {
    expect(paymentStatusEnum.enumValues).toEqual([...PAYMENT_STATUSES]);
    // Byte-identical to the deployed pg enum — a drift here would generate a migration.
    expect(paymentStatusEnum.enumValues).toEqual([
      'pending',
      'awaiting_webhook',
      'completed',
      'failed',
      'expired',
    ]);
  });

  it('declares the house accounts', () => {
    expect(houseAccountEnum.enumValues).toEqual(['revenue', 'payments-in', 'promo']);
  });

  it('declares the idempotency-key kinds', () => {
    expect(idempotencyKeyKindEnum.enumValues).toEqual(['request', 'run']);
  });

  it('declares the idempotency-key outcome states', () => {
    expect(idempotencyKeyStatusEnum.enumValues).toEqual(['claimed', 'succeeded', 'failed']);
  });

  it('declares one purchased and one free-tier wallet type', () => {
    expect(walletTypeEnum.enumValues).toEqual(['purchased', 'free']);
  });

  it('derives newsletter-status values from the single shared NEWSLETTER_STATUSES source', () => {
    expect(newsletterStatusEnum.enumValues).toEqual([...NEWSLETTER_STATUSES]);
  });

  it('derives newsletter-suppress-reason values from the single shared NEWSLETTER_SUPPRESS_REASONS source', () => {
    expect(newsletterSuppressReasonEnum.enumValues).toEqual([...NEWSLETTER_SUPPRESS_REASONS]);
  });

  it('derives newsletter-issue-status values from the single shared NEWSLETTER_ISSUE_STATUSES source', () => {
    expect(newsletterIssueStatusEnum.enumValues).toEqual([...NEWSLETTER_ISSUE_STATUSES]);
  });

  it('derives newsletter-delivery-status values from the single shared NEWSLETTER_DELIVERY_STATUSES source', () => {
    expect(newsletterDeliveryStatusEnum.enumValues).toEqual([...NEWSLETTER_DELIVERY_STATUSES]);
  });

  it('derives newsletter-consent-source values from the single shared NEWSLETTER_CONSENT_SOURCES source', () => {
    expect(newsletterConsentSourceEnum.enumValues).toEqual([...NEWSLETTER_CONSENT_SOURCES]);
  });
});
