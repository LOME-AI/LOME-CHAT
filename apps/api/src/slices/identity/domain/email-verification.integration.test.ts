import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { resendVerification } from './email-verification.js';
import type { IdentityVerificationStore, VerificationEmailPort } from '../ports/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

interface StoreCalls {
  issued: number;
  decoys: number;
}

function countingStore(
  calls: StoreCalls,
  unverifiedUserId: string | null
): IdentityVerificationStore {
  return {
    issueEmailVerification: () => {
      calls.issued += 1;
      return okAsync();
    },
    issueVerificationDecoy: () => {
      calls.decoys += 1;
      return okAsync();
    },
    consumeEmailVerification: () => errAsync(unavailableError('not under test')),
    findUnverifiedByEmail: () =>
      okAsync(unverifiedUserId === null ? null : { id: unverifiedUserId, username: 'someone' }),
    findLatestVerificationToken: () => errAsync(unavailableError('not under test')),
  };
}

const silentEmailPort: VerificationEmailPort = {
  sendVerificationEmail: () => okAsync(),
};

function uniqueEmail(): string {
  return `resend-${crypto.randomUUID()}@identity-domain.test`;
}

describe('resendVerification enumeration symmetry', () => {
  it('performs the mirrored decoy store write for an unknown email', async () => {
    const calls: StoreCalls = { issued: 0, decoys: 0 };
    const outcome = await resendVerification({
      redis,
      store: countingStore(calls, null),
      emailPort: silentEmailPort,
      email: uniqueEmail(),
      now: Date.now(),
    });
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'ok' });
    expect(calls.decoys).toBe(1);
    expect(calls.issued).toBe(0);
  });

  it('issues a real token without the decoy for a known unverified email', async () => {
    const calls: StoreCalls = { issued: 0, decoys: 0 };
    const outcome = await resendVerification({
      redis,
      store: countingStore(calls, crypto.randomUUID()),
      emailPort: silentEmailPort,
      email: uniqueEmail(),
      now: Date.now(),
    });
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'ok' });
    expect(calls.issued).toBe(1);
    expect(calls.decoys).toBe(0);
  });
});
