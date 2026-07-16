import { describe, expect, it } from 'vitest';
import {
  MESSAGE_ROLES,
  messageRoleSchema,
  PAYMENT_STATUSES,
  paymentStatusSchema,
  LEDGER_ENTRY_TYPES,
  ledgerEntryTypeSchema,
  MEMBER_PRIVILEGES,
  memberPrivilegeSchema,
} from './enums';

describe('enums', () => {
  describe('MESSAGE_ROLES', () => {
    it('contains user, assistant, and system roles', () => {
      expect(MESSAGE_ROLES).toEqual(['user', 'assistant', 'system']);
    });

    it('validates valid roles', () => {
      expect(messageRoleSchema.safeParse('user').success).toBe(true);
      expect(messageRoleSchema.safeParse('assistant').success).toBe(true);
      expect(messageRoleSchema.safeParse('system').success).toBe(true);
    });

    it('rejects invalid roles', () => {
      expect(messageRoleSchema.safeParse('admin').success).toBe(false);
      expect(messageRoleSchema.safeParse('').success).toBe(false);
      expect(messageRoleSchema.safeParse(null).success).toBe(false);
    });
  });

  describe('PAYMENT_STATUSES', () => {
    it('contains all payment statuses', () => {
      expect(PAYMENT_STATUSES).toEqual([
        'pending',
        'awaiting_webhook',
        'completed',
        'failed',
        'refunded',
      ]);
    });

    it('validates valid statuses', () => {
      expect(paymentStatusSchema.safeParse('pending').success).toBe(true);
      expect(paymentStatusSchema.safeParse('awaiting_webhook').success).toBe(true);
      expect(paymentStatusSchema.safeParse('completed').success).toBe(true);
      expect(paymentStatusSchema.safeParse('failed').success).toBe(true);
      expect(paymentStatusSchema.safeParse('refunded').success).toBe(true);
    });

    it('rejects invalid statuses', () => {
      expect(paymentStatusSchema.safeParse('processing').success).toBe(false);
      expect(paymentStatusSchema.safeParse('cancelled').success).toBe(false);
    });
  });

  describe('LEDGER_ENTRY_TYPES', () => {
    it('contains all ledger entry types', () => {
      expect(LEDGER_ENTRY_TYPES).toEqual([
        'deposit',
        'usage_charge',
        'refund',
        'adjustment',
        'welcome_credit',
      ]);
    });

    it('validates valid types', () => {
      expect(ledgerEntryTypeSchema.safeParse('deposit').success).toBe(true);
      expect(ledgerEntryTypeSchema.safeParse('usage_charge').success).toBe(true);
      expect(ledgerEntryTypeSchema.safeParse('refund').success).toBe(true);
      expect(ledgerEntryTypeSchema.safeParse('adjustment').success).toBe(true);
      expect(ledgerEntryTypeSchema.safeParse('welcome_credit').success).toBe(true);
    });

    it('rejects invalid types', () => {
      expect(ledgerEntryTypeSchema.safeParse('usage').success).toBe(false);
      expect(ledgerEntryTypeSchema.safeParse('withdrawal').success).toBe(false);
      // `renewal` is a retired legacy kind — the new double-entry ledger writes
      // no renewal rows, so the value no longer exists in the enum.
      expect(ledgerEntryTypeSchema.safeParse('renewal').success).toBe(false);
    });
  });

  describe('MEMBER_PRIVILEGES', () => {
    it('contains all privilege levels in order', () => {
      expect(MEMBER_PRIVILEGES).toEqual(['read', 'write', 'admin', 'owner']);
    });

    it('validates valid privileges', () => {
      expect(memberPrivilegeSchema.safeParse('read').success).toBe(true);
      expect(memberPrivilegeSchema.safeParse('write').success).toBe(true);
      expect(memberPrivilegeSchema.safeParse('admin').success).toBe(true);
      expect(memberPrivilegeSchema.safeParse('owner').success).toBe(true);
    });

    it('rejects invalid privileges', () => {
      expect(memberPrivilegeSchema.safeParse('superadmin').success).toBe(false);
      expect(memberPrivilegeSchema.safeParse('moderator').success).toBe(false);
      expect(memberPrivilegeSchema.safeParse('').success).toBe(false);
      expect(memberPrivilegeSchema.safeParse(null).success).toBe(false);
    });
  });
});
