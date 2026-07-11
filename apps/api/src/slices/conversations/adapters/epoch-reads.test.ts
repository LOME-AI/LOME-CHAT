import { describe, expect, it } from 'vitest';
import { createEpochPublicKeyReader } from './epoch-reads.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';

/** A minimal drizzle read chain returning the supplied rows. */
function fakeReader(rows: readonly { readonly key: Uint8Array }[]): DbWriter {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as DbWriter;
}

describe('createEpochPublicKeyReader', () => {
  it('returns the epoch public key when the epoch row exists', async () => {
    const key = new Uint8Array([1, 2, 3]);
    const reader = createEpochPublicKeyReader();
    await expect(reader(fakeReader([{ key }]), 'c1', 1)).resolves.toBe(key);
  });

  it('returns null when the conversation has no such epoch', async () => {
    const reader = createEpochPublicKeyReader();
    await expect(reader(fakeReader([]), 'c1', 99)).resolves.toBeNull();
  });
});
