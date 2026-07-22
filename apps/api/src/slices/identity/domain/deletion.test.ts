import { describe, expect, it } from 'vitest';
import {
  createDeleteAccountFinishFlow,
  deleteAccountFinishBodySchema,
  deleteAccountInitBodySchema,
} from './deletion.js';
import type { RedisClient } from './keys.js';

const keArray = (length: number): number[] => Array.from({ length }, () => 0);

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

/**
 * The 1024-element cap on the OPAQUE KE arrays bounds parse cost against a
 * pathologically large body. Legacy pinned it for delete-account only
 * (legacy/apps/api/src/legacy/routes/delete-account.ts:33-41,
 * MAX_KE_ARRAY_LENGTH = 1024); this is the parity anchor.
 */
describe('delete-account KE-array cap', () => {
  it('accepts a ke1 array of exactly 1024 elements', () => {
    expect(deleteAccountInitBodySchema.safeParse({ ke1: keArray(1024) }).success).toBe(true);
  });

  it('rejects a ke1 array of 1025 elements', () => {
    expect(deleteAccountInitBodySchema.safeParse({ ke1: keArray(1025) }).success).toBe(false);
  });

  it('accepts a ke3 array of exactly 1024 elements', () => {
    const body = {
      ke3: keArray(1024),
      deleteAccountSessionId: crypto.randomUUID(),
      confirmationPhrase: 'delete my account',
    };
    expect(deleteAccountFinishBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a ke3 array of 1025 elements', () => {
    const body = {
      ke3: keArray(1025),
      deleteAccountSessionId: crypto.randomUUID(),
      confirmationPhrase: 'delete my account',
    };
    expect(deleteAccountFinishBodySchema.safeParse(body).success).toBe(false);
  });
});
