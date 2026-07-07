import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { advanceForkTipWithinTx, resolveForkTipWithinTx } from './fork-tip.js';
import { fakeStores } from './test-fixtures.js';
import type { ForkRecord } from '../ports/index.js';

function forkRecord(overrides: Partial<ForkRecord> = {}): ForkRecord {
  return { id: 'f1', name: 'Main', tipMessageId: 'tip', createdAt: new Date(0), ...overrides };
}

describe('resolveForkTipWithinTx', () => {
  it('returns the locked fork tip', async () => {
    const stores = fakeStores({
      forks: { lockById: () => okAsync(forkRecord({ tipMessageId: 'msg-7' })) },
    });
    const result = await resolveForkTipWithinTx(stores, { conversationId: 'c1', forkId: 'f1' });
    expect(result._unsafeUnwrap()).toEqual({ tipMessageId: 'msg-7' });
  });

  it('resolves a null tip for a fork with no messages', async () => {
    const stores = fakeStores({
      forks: { lockById: () => okAsync(forkRecord({ tipMessageId: null })) },
    });
    const result = await resolveForkTipWithinTx(stores, { conversationId: 'c1', forkId: 'f1' });
    expect(result._unsafeUnwrap()).toEqual({ tipMessageId: null });
  });

  it('errors not_found when the fork is gone at settlement', async () => {
    const stores = fakeStores({ forks: { lockById: () => okAsync(null) } });
    const result = await resolveForkTipWithinTx(stores, { conversationId: 'c1', forkId: 'gone' });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});

describe('advanceForkTipWithinTx', () => {
  it('advances the tip from the expected prior tip to the new reply', async () => {
    const captured: unknown[] = [];
    const stores = fakeStores({
      forks: {
        updateTip: (params) => {
          captured.push(params);
          return okAsync(forkRecord({ tipMessageId: 'assistant-1' }));
        },
      },
    });
    const result = await advanceForkTipWithinTx(stores, {
      conversationId: 'c1',
      forkId: 'f1',
      expectedTipMessageId: 'prior',
      newTipMessageId: 'assistant-1',
    });
    expect(result._unsafeUnwrap()).toBe(true);
    expect(captured).toEqual([
      {
        conversationId: 'c1',
        forkId: 'f1',
        expectedTipMessageId: 'prior',
        tipMessageId: 'assistant-1',
      },
    ]);
  });

  it('errors conflict when a zero-row CAS re-reads a moved tip', async () => {
    const stores = fakeStores({
      forks: {
        updateTip: () => okAsync(null),
        byId: () => okAsync(forkRecord({ tipMessageId: 'someone-elses' })),
      },
    });
    const result = await advanceForkTipWithinTx(stores, {
      conversationId: 'c1',
      forkId: 'f1',
      expectedTipMessageId: 'prior',
      newTipMessageId: 'assistant-1',
    });
    expect(result._unsafeUnwrapErr().code).toBe('conflict');
  });

  it('errors not_found when a zero-row CAS re-reads a vanished fork', async () => {
    const stores = fakeStores({
      forks: {
        updateTip: () => okAsync(null),
        byId: () => okAsync(null),
      },
    });
    const result = await advanceForkTipWithinTx(stores, {
      conversationId: 'c1',
      forkId: 'f1',
      expectedTipMessageId: 'prior',
      newTipMessageId: 'assistant-1',
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});
