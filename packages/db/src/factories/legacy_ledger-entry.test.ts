import { describe, it, expect } from 'vitest';

import { ledgerEntryFactory } from './legacy_ledger-entry';

describe('ledgerEntryFactory', () => {
  it('builds a complete ledger entry object', () => {
    const entry = ledgerEntryFactory.build();

    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(entry.walletId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(entry.amount).toBeTruthy();
    expect(entry.balanceAfter).toBeTruthy();
    expect(entry.entryType).toBeTruthy();
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it('generates valid entry type', () => {
    const validTypes = [
      'deposit',
      'usage_charge',
      'refund',
      'adjustment',
      'renewal',
      'welcome_credit',
    ];
    const entry = ledgerEntryFactory.build();
    expect(validTypes).toContain(entry.entryType);
  });

  it('generates amount and balanceAfter as numeric strings', () => {
    const entry = ledgerEntryFactory.build();
    expect(Number(entry.amount)).not.toBeNaN();
    expect(Number(entry.balanceAfter)).not.toBeNaN();
  });

  it('sets exactly one FK reference', () => {
    const entry = ledgerEntryFactory.build();
    const fkCount = [entry.paymentId, entry.usageRecordId, entry.sourceWalletId].filter(
      (v) => v !== null
    ).length;
    expect(fkCount).toBe(1);
  });

  it('sets paymentId for deposit entries', () => {
    const entry = ledgerEntryFactory.build({ entryType: 'deposit' });
    expect(entry.paymentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(entry.usageRecordId).toBeNull();
    expect(entry.sourceWalletId).toBeNull();
  });

  it('sets usageRecordId for usage_charge entries', () => {
    const entry = ledgerEntryFactory.build({ entryType: 'usage_charge' });
    expect(entry.usageRecordId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(entry.paymentId).toBeNull();
    expect(entry.sourceWalletId).toBeNull();
  });

  it('sets sourceWalletId for renewal entries', () => {
    const entry = ledgerEntryFactory.build({ entryType: 'renewal' });
    expect(entry.sourceWalletId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(entry.paymentId).toBeNull();
    expect(entry.usageRecordId).toBeNull();
  });

  it('allows field overrides', () => {
    const entry = ledgerEntryFactory.build({ amount: '-5.00000000', balanceAfter: '95.00000000' });
    expect(entry.amount).toBe('-5.00000000');
    expect(entry.balanceAfter).toBe('95.00000000');
  });

  it('builds a list with unique IDs', () => {
    const entryList = ledgerEntryFactory.buildList(3);
    expect(entryList).toHaveLength(3);
    const ids = new Set(entryList.map((e) => e.id));
    expect(ids.size).toBe(3);
  });
});
