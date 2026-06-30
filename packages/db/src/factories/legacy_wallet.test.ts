import { describe, it, expect } from 'vitest';

import { walletFactory } from './legacy_wallet';

describe('walletFactory', () => {
  it('builds a complete wallet object', () => {
    const wallet = walletFactory.build();

    expect(wallet.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(wallet.type).toBeTruthy();
    expect(wallet.balance).toBeTruthy();
    expect(typeof wallet.priority).toBe('number');
    expect(wallet.createdAt).toBeInstanceOf(Date);
  });

  it('generates valid wallet type', () => {
    const wallet = walletFactory.build();
    expect(['purchased', 'free_tier']).toContain(wallet.type);
  });

  it('generates userId as nullable UUID by default', () => {
    const wallet = walletFactory.build();
    expect(wallet.userId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('allows null userId', () => {
    const wallet = walletFactory.build({ userId: null });
    expect(wallet.userId).toBeNull();
  });

  it('generates balance as numeric string', () => {
    const wallet = walletFactory.build();
    expect(Number(wallet.balance)).not.toBeNaN();
  });

  it('allows field overrides', () => {
    const wallet = walletFactory.build({ type: 'free_tier', balance: '100.00000000' });
    expect(wallet.type).toBe('free_tier');
    expect(wallet.balance).toBe('100.00000000');
  });

  it('builds a list with unique IDs', () => {
    const walletList = walletFactory.buildList(3);
    expect(walletList).toHaveLength(3);
    const ids = new Set(walletList.map((w) => w.id));
    expect(ids.size).toBe(3);
  });
});
