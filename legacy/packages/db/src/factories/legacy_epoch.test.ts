import { describe, it, expect } from 'vitest';

import { epochFactory } from './legacy_epoch';

describe('epochFactory', () => {
  it('builds a complete epoch object', () => {
    const epoch = epochFactory.build();

    expect(epoch.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(epoch.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(typeof epoch.epochNumber).toBe('number');
    expect(epoch.epochNumber).toBeGreaterThanOrEqual(1);
    expect(epoch.createdAt).toBeInstanceOf(Date);
  });

  it('generates bytea fields as Uint8Array', () => {
    const epoch = epochFactory.build();

    expect(epoch.epochPublicKey).toBeInstanceOf(Uint8Array);
    expect(epoch.epochPublicKey.length).toBe(32);
    expect(epoch.confirmationHash).toBeInstanceOf(Uint8Array);
    expect(epoch.confirmationHash.length).toBe(32);
  });

  it('generates chainLink as null by default for epoch 1', () => {
    const epoch = epochFactory.build({ epochNumber: 1 });
    expect(epoch.chainLink).toBeNull();
  });

  it('allows field overrides', () => {
    const customKey = new Uint8Array(32).fill(0xab);
    const epoch = epochFactory.build({ epochPublicKey: customKey, epochNumber: 3 });
    expect(epoch.epochPublicKey).toEqual(customKey);
    expect(epoch.epochNumber).toBe(3);
  });

  it('builds a list with unique IDs', () => {
    const epochList = epochFactory.buildList(3);
    expect(epochList).toHaveLength(3);
    const ids = new Set(epochList.map((e) => e.id));
    expect(ids.size).toBe(3);
  });
});
