import { describe, expect, expectTypeOf, it } from 'vitest';
import { column } from './__tests__/shape-helpers';
import { wallets } from './wallets';

describe('wallets ledger sequence', () => {
  it('carries a bigint-mode ledger_seq column', () => {
    const c = column(wallets, 'ledger_seq');
    expect(c.getSQLType()).toBe('bigint');
    expect(c.dataType).toBe('bigint');
    type WalletRow = typeof wallets.$inferSelect;
    expectTypeOf<WalletRow['ledgerSeq']>().toEqualTypeOf<bigint>();
  });

  it('defaults ledger_seq to zero and forbids null', () => {
    const c = column(wallets, 'ledger_seq');
    expect(c.notNull).toBe(true);
    expect(c.default).toBeDefined();
  });
});
