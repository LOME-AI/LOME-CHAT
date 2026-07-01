import { describe, it, expect, vi } from 'vitest';

import { okAsync } from '../../../lib/result/index.js';
import { getBannerDismissal, saveBannerDismissal } from './dismissal.js';

import type { BannerDismissalStore } from '../ports/index.js';

describe('getBannerDismissal', () => {
  it('reports dismissed when the stored hash matches', async () => {
    const store: BannerDismissalStore = {
      isDismissed: () => okAsync(true),
      upsertDismissal: () => okAsync({ id: 'x' }),
    };
    const settled = await getBannerDismissal(store, 'user-1', 'hash-1');
    expect(settled.isOk() && settled.value).toEqual({ dismissed: true });
  });

  it('reports not dismissed otherwise', async () => {
    const store: BannerDismissalStore = {
      isDismissed: () => okAsync(false),
      upsertDismissal: () => okAsync({ id: 'x' }),
    };
    const settled = await getBannerDismissal(store, 'user-1', 'hash-1');
    expect(settled.isOk() && settled.value).toEqual({ dismissed: false });
  });
});

describe('saveBannerDismissal', () => {
  it('upserts the user + hash and resolves dismissed', async () => {
    const upsertDismissal = vi.fn(() => okAsync({ id: 'x' }));
    const store: BannerDismissalStore = { isDismissed: () => okAsync(false), upsertDismissal };
    const settled = await saveBannerDismissal(store, 'user-1', 'hash-1');
    expect(upsertDismissal).toHaveBeenCalledWith('user-1', 'hash-1');
    expect(settled.isOk() && settled.value).toEqual({ dismissed: true });
  });
});
