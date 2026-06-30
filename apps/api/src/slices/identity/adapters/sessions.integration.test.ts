import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { unsealData } from 'iron-session';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '../../../lib/context/index.js';
import { redisGet } from '../../../lib/redis/index.js';
import { IDENTITY_KEYS } from './keys.js';
import { PENDING_2FA_TTL_MS, createIdentitySessions } from './sessions.js';
import type { SessionClaims } from '../../../lib/context/index.js';
import type { SessionKind } from '../ports/index.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const sessions = createIdentitySessions(redis);
const SECRET = 'secret-at-least-32-characters-long!!';
const NOW = Date.now();

async function issue(
  kind: SessionKind
): Promise<{ sessionId: string; response: Response; userId: string }> {
  const response = new Response();
  const userId = crypto.randomUUID();
  const result = await sessions.issue({
    request: new Request('http://localhost/auth/login/finish'),
    response,
    secret: SECRET,
    isProduction: false,
    userId,
    kind,
    now: NOW,
  });
  const { sessionId } = result._unsafeUnwrap();
  return { sessionId, response, userId };
}

async function unsealCookie(response: Response): Promise<SessionClaims & Record<string, unknown>> {
  const header = response.headers.get('set-cookie');
  expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
  const value = header?.split(`${SESSION_COOKIE_NAME}=`)[1]?.split(';')[0];
  return await unsealData(value ?? '', { password: SECRET });
}

describe('createIdentitySessions: issue', () => {
  it('seals a full-session cookie with fresh ids and timestamps', async () => {
    const { sessionId, response, userId } = await issue('full');
    const claims = await unsealCookie(response);
    expect(claims).toEqual({
      userId,
      sessionId,
      createdAt: NOW,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    });
  });

  it('seals a pending-2fa cookie with a five-minute challenge expiry', async () => {
    const { response } = await issue('pending-2fa');
    const claims = await unsealCookie(response);
    expect(claims.pending2FA).toBe(true);
    expect(claims.pending2FAExpiresAt).toBe(NOW + PENDING_2FA_TTL_MS);
  });

  it('seals a billing-only cookie', async () => {
    const { response } = await issue('billing-only');
    const claims = await unsealCookie(response);
    expect(claims.billingOnly).toBe(true);
    expect(claims.pending2FA).toBe(false);
  });

  it('writes the sessionActive key for the issued session', async () => {
    const { sessionId, userId } = await issue('full');
    const active = await redisGet(redis, IDENTITY_KEYS.sessionActive, userId, sessionId);
    expect(active._unsafeUnwrap()).toBe('1');
  });

  it('bounds the sessionActive key by the cookie lifetime', async () => {
    const { sessionId, userId } = await issue('full');
    const ttl = await redis.ttl(IDENTITY_KEYS.sessionActive.buildKey(userId, sessionId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(SESSION_MAX_AGE_SECONDS);
  });

  it('issues no cookie when the sessionActive write fails (fail closed)', async () => {
    const deadRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
    const deadSessions = createIdentitySessions(deadRedis);
    const response = new Response();
    const result = await deadSessions.issue({
      request: new Request('http://localhost/auth/login/finish'),
      response,
      secret: SECRET,
      isProduction: false,
      userId: crypto.randomUUID(),
      kind: 'full',
      now: NOW,
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('createIdentitySessions: destroyCookie', () => {
  it('sets an expired removal cookie on the response', async () => {
    const response = new Response();
    await sessions.destroyCookie({
      request: new Request('http://localhost/auth/logout'),
      response,
      secret: SECRET,
      isProduction: false,
    });
    const header = response.headers.get('set-cookie');
    expect(header).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
  });
});

describe('createIdentitySessions: revoke', () => {
  it('deletes the sessionActive key', async () => {
    const { sessionId, userId } = await issue('full');
    const result = await sessions.revoke({ userId, sessionId });
    expect(result.isOk()).toBe(true);
    const active = await redisGet(redis, IDENTITY_KEYS.sessionActive, userId, sessionId);
    expect(active._unsafeUnwrap()).toBeNull();
  });
});
