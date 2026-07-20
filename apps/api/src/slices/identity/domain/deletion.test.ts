import { describe, expect, it } from 'vitest';
import { createDeleteAccountFinishFlow } from './deletion.js';
import type { RedisClient } from './keys.js';

/**
 * Unit coverage for the read-only hard-lock gate in the delete-account finish
 * flow: once the 24-hour lock is engaged, `execute()` returns `locked` before
 * any phrase/guessing-gate work. The integration suite covers the actual
 * deletion; this pins the frozen-account short-circuit with a fake redis.
 */

describe('createDeleteAccountFinishFlow — hard lock', () => {
  it('returns a locked outcome when the 24-hour hard lock is engaged', async () => {
    const redis = {
      // claim() consumes the step-up handshake (a valid StepUpPending)…
      getdel: () => Promise.resolve({ userId: 'user-1', expectedSerialized: [1, 2, 3] }),
      // …and execute() checks the hard-lock TTL first — a positive TTL means locked.
      ttl: () => Promise.resolve(3600),
    } as unknown as RedisClient;

    const args = {
      redis,
      userId: 'user-1',
      deleteAccountSessionId: 'session-1',
    } as unknown as Parameters<typeof createDeleteAccountFinishFlow>[0];

    const flow = createDeleteAccountFinishFlow(args);

    const claimed = await flow.claim();
    expect(claimed.isOk()).toBe(true);
    expect(claimed._unsafeUnwrap()).toBe(true);

    const outcome = await flow.execute();
    expect(outcome.isOk()).toBe(true);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'locked', retryAfterSeconds: 3600 });
  });
});
