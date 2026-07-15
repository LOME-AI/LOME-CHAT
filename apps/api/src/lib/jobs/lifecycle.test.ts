import { describe, expect, it } from 'vitest';
import { redriveJob } from './lifecycle.js';
import type { DbWriter } from '../idempotency/transaction.js';

/**
 * The concurrent-restore gap cannot be produced against a real database
 * inside one transaction, so the defect guard is exercised with a stub
 * writer: the conditional UPDATE matches zero rows, yet the follow-up read
 * still sees a dead, undiscarded row.
 */
function stubWriter(readRow: { status: string; discardedAt: Date | null }): DbWriter {
  const writer = {
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    }),
    select: () => ({
      from: () => ({ where: () => Promise.resolve([readRow]) }),
    }),
  };
  return writer as unknown as DbWriter;
}

describe('redriveJob', () => {
  it('surfaces a concurrent transition instead of mislabeling the state', async () => {
    const writer = stubWriter({ status: 'dead', discardedAt: null });
    await expect(redriveJob(writer, 'job-1')).rejects.toThrow(/transitioned concurrently/);
  });
});
