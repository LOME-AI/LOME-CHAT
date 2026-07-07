import { describe, expect, it, vi } from 'vitest';
import { consumeTrialQuota, hashIp } from './trial-quota.js';
import type { ConsumeTrialQuotaArgs } from './trial-quota.js';

type Redis = Parameters<typeof consumeTrialQuota>[0];

interface ExpireCall {
  readonly key: string;
  readonly mode: string | undefined;
}

/** An in-memory Redis double: atomic INCR + a recording EXPIRE. */
function fakeRedis(seed: Record<string, number> = {}): {
  redis: Redis;
  expireCalls: ExpireCall[];
} {
  const store = new Map<string, number>(Object.entries(seed));
  const expireCalls: ExpireCall[] = [];
  const redis = {
    incr: (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    },
    expire: (key: string, _seconds: number, mode?: string) => {
      expireCalls.push({ key, mode });
      return Promise.resolve(1);
    },
  } as unknown as Redis;
  return { redis, expireCalls };
}

const ARGS: ConsumeTrialQuotaArgs = { sessionId: 's1', ipHash: 'ip1' };

describe('consumeTrialQuota', () => {
  it('allows a fresh session within the daily limit', async () => {
    const { redis } = fakeRedis();
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome._unsafeUnwrap()).toEqual({ allowed: true, count: 1 });
  });

  it('refuses once the higher of the two identities exceeds the limit', async () => {
    // Session already at the limit; the next increment (6) exceeds it.
    const { redis } = fakeRedis({ 'trial:usage:session:s1': 5, 'trial:usage:ip:ip1': 2 });
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome._unsafeUnwrap()).toEqual({ allowed: false, count: 6 });
  });

  it('takes the IP count when it is the higher identity (rotated token evasion)', async () => {
    const { redis } = fakeRedis({ 'trial:usage:session:s1': 0, 'trial:usage:ip:ip1': 5 });
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome._unsafeUnwrap()).toEqual({ allowed: false, count: 6 });
  });

  it('anchors each counter TTL with EXPIRE … NX (no window extension)', async () => {
    const { redis, expireCalls } = fakeRedis();
    const outcome = await consumeTrialQuota(redis, ARGS);
    expect(outcome.isOk()).toBe(true);
    expect(expireCalls).toHaveLength(2);
    expect(expireCalls.every((call) => call.mode === 'NX')).toBe(true);
  });

  it('fails closed (unavailable) when Redis is down', async () => {
    const redis = { incr: vi.fn(() => Promise.reject(new Error('down'))) } as unknown as Redis;
    const result = await consumeTrialQuota(redis, ARGS);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('unavailable');
  });
});

describe('hashIp', () => {
  it('returns a stable 64-char SHA-256 hex digest', async () => {
    const a = await hashIp('203.0.113.7');
    const b = await hashIp('203.0.113.7');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('produces different digests for different IPs (never stores a raw IP)', async () => {
    expect(await hashIp('203.0.113.7')).not.toBe(await hashIp('203.0.113.8'));
  });
});
