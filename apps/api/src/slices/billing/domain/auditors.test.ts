import { describe, expect, it, vi } from 'vitest';
import { BILLING_KEYS } from './keys.js';
import { listSnapshotWalletIds } from './auditors.js';
import type { RedisClient } from './keys.js';

/**
 * Unit coverage for the paginating scan in `listSnapshotWalletIds`: the
 * integration test exercises the single-page (`cursor === '0'` on the first
 * scan) path; this pins the multi-page path where a non-zero cursor keeps the
 * loop going before it returns to `'0'`.
 */

const PREFIX = BILLING_KEYS.walletSnapshot.buildKey('');

describe('listSnapshotWalletIds', () => {
  it('paginates the scan across cursors until the cursor returns to 0', async () => {
    const scan = vi
      .fn()
      // first page: a non-zero cursor keeps the loop going
      .mockResolvedValueOnce(['42', [`${PREFIX}wallet-a`]])
      // second page: cursor back to '0' breaks the loop
      .mockResolvedValueOnce(['0', [`${PREFIX}wallet-b`]]);
    const redis = { scan } as unknown as RedisClient;

    const result = await listSnapshotWalletIds(redis);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(['wallet-a', 'wallet-b']);
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
