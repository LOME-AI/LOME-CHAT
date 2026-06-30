import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { IDENTITY_KEYS } from './keys.js';
import { createIdentityAuthState, evaluateWindow } from './auth-state.js';

const CONFIG = { maxAttempts: 3, windowSeconds: 60 };
const NOW = 1_700_000_000_000;

describe('evaluateWindow', () => {
  it('opens a fresh window on the first attempt', () => {
    expect(evaluateWindow(null, CONFIG, NOW)).toEqual({
      decision: { allowed: true },
      nextState: { count: 1, firstAttempt: NOW },
    });
  });

  it('counts attempts inside the window', () => {
    expect(evaluateWindow({ count: 1, firstAttempt: NOW - 1000 }, CONFIG, NOW)).toEqual({
      decision: { allowed: true },
      nextState: { count: 2, firstAttempt: NOW - 1000 },
    });
  });

  it('denies once the attempt cap is reached with the window remainder as retry-after', () => {
    const firstAttempt = NOW - 10_000;
    expect(evaluateWindow({ count: 3, firstAttempt }, CONFIG, NOW)).toEqual({
      decision: { allowed: false, retryAfterSeconds: 50 },
      nextState: null,
    });
  });

  it('reopens the window after it expires', () => {
    const firstAttempt = NOW - 61_000;
    expect(evaluateWindow({ count: 3, firstAttempt }, CONFIG, NOW)).toEqual({
      decision: { allowed: true },
      nextState: { count: 1, firstAttempt: NOW },
    });
  });

  it('rounds a fractional window remainder up to whole seconds', () => {
    const firstAttempt = NOW - 59_500;
    const evaluation = evaluateWindow({ count: 3, firstAttempt }, CONFIG, NOW);
    expect(evaluation.decision).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

describe('createIdentityAuthState (integration: real Redis)', () => {
  const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  const store = createIdentityAuthState(redis);

  function uniqueIdentifier(): string {
    return `rl-${crypto.randomUUID()}@identity.test`;
  }

  it('allows rate-limited attempts up to the configured cap and then denies', async () => {
    const identifier = uniqueIdentifier();
    const { maxAttempts, windowSeconds } = IDENTITY_KEYS.registerRateLimit.rateLimitConfig;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const result = await store.consumeRateLimit('register', identifier, Date.now());
      expect(result._unsafeUnwrap()).toEqual({ allowed: true });
    }
    const denied = await store.consumeRateLimit('register', identifier, Date.now());
    const decision = denied._unsafeUnwrap();
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
      expect(decision.retryAfterSeconds).toBeLessThanOrEqual(windowSeconds);
    }
  });

  it('reopens a rate limit after it is cleared', async () => {
    const identifier = uniqueIdentifier();
    const { maxAttempts } = IDENTITY_KEYS.registerRateLimit.rateLimitConfig;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      await store.consumeRateLimit('register', identifier, Date.now());
    }
    const cleared = await store.clearRateLimit('register', identifier);
    expect(cleared.isOk()).toBe(true);
    const retry = await store.consumeRateLimit('register', identifier, Date.now());
    expect(retry._unsafeUnwrap()).toEqual({ allowed: true });
  });

  it('round-trips pending login state exactly once (consume is single-use)', async () => {
    const handshakeId = crypto.randomUUID();
    const state = { identifier: 'someone@x.test', userId: null, expectedSerialized: [1, 2, 3] };
    const saved = await store.savePendingLogin(handshakeId, state);
    expect(saved.isOk()).toBe(true);
    const first = await store.consumePendingLogin(handshakeId);
    expect(first._unsafeUnwrap()).toEqual(state);
    const second = await store.consumePendingLogin(handshakeId);
    expect(second._unsafeUnwrap()).toBeNull();
  });

  it('round-trips pending registration state exactly once (consume is single-use)', async () => {
    const handshakeId = crypto.randomUUID();
    const state = { email: 'a@x.test', username: 'a', userId: crypto.randomUUID(), existing: true };
    const saved = await store.savePendingRegistration(handshakeId, state);
    expect(saved.isOk()).toBe(true);
    const first = await store.consumePendingRegistration(handshakeId);
    expect(first._unsafeUnwrap()).toEqual(state);
    const second = await store.consumePendingRegistration(handshakeId);
    expect(second._unsafeUnwrap()).toBeNull();
  });

  it('answers unavailable when Redis is unreachable', async () => {
    const deadRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
    const deadStore = createIdentityAuthState(deadRedis);
    const result = await deadStore.consumeRateLimit('register', uniqueIdentifier(), Date.now());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
