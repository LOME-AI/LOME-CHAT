import { describe, it, expect } from 'vitest';

import { unavailableError } from '../../../lib/errors/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { getActiveBanner } from './banner.js';

import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { BannerReadResult } from './banner.js';
import type { BannerConfigRow, BannerConfigStore } from '../ports/index.js';

function configStore(row: BannerConfigRow | null): BannerConfigStore {
  return {
    readActive: () => okAsync(row),
    readForUpdateWithinTx: () => Promise.reject(new Error('not used by getActiveBanner')),
    setWithinTx: () => Promise.reject(new Error('not used by getActiveBanner')),
  };
}

async function unwrap(
  result: ResultAsync<BannerReadResult, DomainError>
): Promise<BannerReadResult> {
  const settled = await result;
  if (settled.isErr()) throw new Error(`expected ok, got ${settled.error.code}`);
  return settled.value;
}

describe('getActiveBanner', () => {
  it('returns a null hash when there is no config row', async () => {
    const value = await unwrap(getActiveBanner(configStore(null)));
    expect(value.response.hash).toBeNull();
    expect(value.response.messages).toEqual([]);
  });

  it('returns a null hash when the row is disabled', async () => {
    const value = await unwrap(
      getActiveBanner(
        configStore({ enabled: false, messages: [{ text: 'hi', variant: 'warning' }] })
      )
    );
    expect(value.response.hash).toBeNull();
  });

  it('computes a stable, content-derived hash for an enabled set and reports zero drops', async () => {
    const row: BannerConfigRow = {
      enabled: true,
      messages: [
        { text: 'one', variant: 'warning' },
        { text: 'two', variant: 'info' },
      ],
    };
    const first = await unwrap(getActiveBanner(configStore(row)));
    const second = await unwrap(getActiveBanner(configStore(row)));
    expect(first.response.hash).not.toBeNull();
    expect(first.response.hash).toBe(second.response.hash);
    expect(first.response.messages.map((message) => message.variant)).toEqual(['warning', 'info']);
    expect(first.response.messages.map((message) => message.text)).toEqual(['one', 'two']);
    expect(first.droppedCount).toBe(0);
  });

  it('changes the hash when the text changes', async () => {
    const a = await unwrap(
      getActiveBanner(configStore({ enabled: true, messages: [{ text: 'a', variant: 'info' }] }))
    );
    const b = await unwrap(
      getActiveBanner(configStore({ enabled: true, messages: [{ text: 'b', variant: 'info' }] }))
    );
    expect(a.response.hash).not.toBe(b.response.hash);
  });

  it('changes the hash when only a message variant changes, re-showing dismissed banners', async () => {
    const a = await unwrap(
      getActiveBanner(configStore({ enabled: true, messages: [{ text: 'a', variant: 'info' }] }))
    );
    const b = await unwrap(
      getActiveBanner(
        configStore({ enabled: true, messages: [{ text: 'a', variant: 'critical' }] })
      )
    );
    expect(a.response.hash).not.toBe(b.response.hash);
  });

  it('salvages invalid messages, defaulting an unknown variant to info, and counts the drops', async () => {
    const row: BannerConfigRow = {
      enabled: true,
      messages: [{ text: 'ok', variant: 'shout' }, { text: '' }, { nope: 1 }],
    };
    const value = await unwrap(getActiveBanner(configStore(row)));
    expect(value.response.messages).toEqual([{ text: 'ok', variant: 'info' }]);
    expect(value.droppedCount).toBe(2);
  });

  it('propagates a store failure', async () => {
    const store: BannerConfigStore = {
      ...configStore(null),
      readActive: () => errAsync(unavailableError('db down')),
    };
    const settled = await getActiveBanner(store);
    expect(settled.isErr()).toBe(true);
  });
});
