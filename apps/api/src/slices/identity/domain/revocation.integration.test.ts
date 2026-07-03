import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { redisSet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import { checkSessionRevocation } from './revocation.js';
import type { SessionClaims } from '../../../lib/context/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

function claims(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    createdAt: Date.now(),
    pending2FA: false,
    pending2FAExpiresAt: 0,
    ...overrides,
  };
}

async function activate(session: SessionClaims): Promise<void> {
  const written = await redisSet(
    redis,
    IDENTITY_KEYS.sessionActive,
    '1',
    session.userId,
    session.sessionId
  );
  written._unsafeUnwrap();
}

async function markPasswordChanged(userId: string, changedAt: number): Promise<void> {
  const written = await redisSet(redis, IDENTITY_KEYS.passwordChangedAt, changedAt, userId);
  written._unsafeUnwrap();
}

describe('checkSessionRevocation', () => {
  it('answers active for a registered session with no password change', async () => {
    const session = claims();
    await activate(session);
    const result = await checkSessionRevocation(redis, session);
    expect(result._unsafeUnwrap()).toBe('active');
  });

  it('answers revoked when the sessionActive key is absent', async () => {
    const result = await checkSessionRevocation(redis, claims());
    expect(result._unsafeUnwrap()).toBe('revoked');
  });

  it('answers revoked for a cookie issued before the password last changed', async () => {
    const now = Date.now();
    const session = claims({ createdAt: now - 10_000 });
    await activate(session);
    await markPasswordChanged(session.userId, now);
    const result = await checkSessionRevocation(redis, session);
    expect(result._unsafeUnwrap()).toBe('revoked');
  });

  it('answers active for a cookie issued after the password last changed', async () => {
    const now = Date.now();
    const session = claims({ createdAt: now + 1 });
    await activate(session);
    await markPasswordChanged(session.userId, now);
    const result = await checkSessionRevocation(redis, session);
    expect(result._unsafeUnwrap()).toBe('active');
  });

  it('fails closed with unavailable when Redis is unreachable', async () => {
    const deadRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
    const result = await checkSessionRevocation(deadRedis, claims());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
