import { describe, it, expect } from 'vitest';
import { MEMBER_PRIVILEGES, MODALITIES } from '@hushbox/shared';

import {
  contentItemTypeEnum,
  devicePlatformEnum,
  houseAccountEnum,
  idempotencyKeyKindEnum,
  idempotencyKeyStatusEnum,
  jobShardEnum,
  jobStatusEnum,
  ledgerEntryKindEnum,
  memberPrivilegeEnum,
  messageSenderTypeEnum,
  modalityEnum,
  paymentStatusEnum,
  userLockReasonEnum,
  verificationPurposeEnum,
  walletTypeEnum,
} from './index';

const ALL_ENUMS = [
  contentItemTypeEnum,
  devicePlatformEnum,
  houseAccountEnum,
  idempotencyKeyKindEnum,
  idempotencyKeyStatusEnum,
  jobShardEnum,
  jobStatusEnum,
  ledgerEntryKindEnum,
  memberPrivilegeEnum,
  messageSenderTypeEnum,
  modalityEnum,
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

  it('declares the ledger_entries.kind discriminator', () => {
    expect(ledgerEntryKindEnum.enumValues).toEqual([
      'deposit',
      'charge',
      'true_up',
      'clawback',
      'promo',
      'refund',
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
});
