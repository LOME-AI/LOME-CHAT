import { afterAll, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import { unsealData } from 'iron-session';
import { LOCAL_NEON_DEV_CONFIG, createDb, users } from '@hushbox/db';
import { SESSION_COOKIE_NAME, parseSessionClaims } from '../../../lib/context/index.js';
import { redisGet } from '../../../lib/redis/index.js';
import { createIdentityStores } from '../adapters/stores.js';
import { IDENTITY_KEYS } from './keys.js';
import { billingTokenLogin, issueBillingLoginToken } from './billing-portal.js';
import type { SessionClaims } from '../../../lib/context/index.js';
import type { BillingTokenLoginOutcome } from './billing-portal.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Upstash vars are required');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const stores = createIdentityStores(db);

const SECRET = 'secret-at-least-32-characters-long!!';

/** Unique per run so concurrent suites on the shared DB never collide. */
const PREFIX = `zb${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

async function createUser(): Promise<string> {
  counter += 1;
  const name = `${PREFIX}u${String(counter)}`;
  const inserted = await stores.users.insertRegistered({
    id: crypto.randomUUID(),
    email: `${name}@billing-portal.test`,
    username: name,
    opaqueRegistration: BYTES,
    publicKey: BYTES,
    passwordWrappedPrivateKey: BYTES,
    recoveryWrappedPrivateKey: BYTES,
  });
  const outcome = inserted._unsafeUnwrap();
  if (outcome.kind !== 'created') throw new Error('user seed failed');
  createdUserIds.push(outcome.userId);
  return outcome.userId;
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

async function loginWith(
  token: string
): Promise<{ outcome: BillingTokenLoginOutcome; response: Response }> {
  const response = new Response();
  const result = await billingTokenLogin({
    redis,
    store: stores.users,
    token,
    request: new Request('http://localhost/auth/token-login'),
    response,
    secret: SECRET,
    isProduction: false,
    now: Date.now(),
  });
  return { outcome: result._unsafeUnwrap(), response };
}

async function unsealCookie(response: Response): Promise<SessionClaims> {
  const header = response.headers.get('set-cookie') ?? '';
  const sealed = header.split(`${SESSION_COOKIE_NAME}=`)[1]?.split(';')[0] ?? '';
  const claims = parseSessionClaims(await unsealData(sealed, { password: SECRET }));
  if (claims === null) throw new Error('cookie did not unseal to valid claims');
  return claims;
}

async function issueToken(userId: string): Promise<string> {
  const issued = await issueBillingLoginToken({ redis, userId });
  return issued._unsafeUnwrap().token;
}

describe('issueBillingLoginToken', () => {
  it('stores the userId under the token key and returns the token', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    const stored = await redisGet(redis, IDENTITY_KEYS.billingLoginToken, token);
    expect(stored._unsafeUnwrap()).toEqual({ userId });
  });

  it('mints a fresh unguessable token per call', async () => {
    const userId = await createUser();
    const first = await issueToken(userId);
    const second = await issueToken(userId);
    expect(first).not.toBe(second);
  });
});

describe('billingTokenLogin', () => {
  it('mints a billing-only session for a live token', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    const { outcome, response } = await loginWith(token);
    expect(outcome).toEqual({ kind: 'logged-in' });
    const claims = await unsealCookie(response);
    expect(claims.userId).toBe(userId);
    expect(claims.billingOnly).toBe(true);
    expect(claims.pending2FA).toBe(false);
    const active = await redisGet(redis, IDENTITY_KEYS.sessionActive, userId, claims.sessionId);
    expect(active._unsafeUnwrap()).toBe('1');
  });

  it('does not delete the token on redemption (TTL is the expiry)', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    await loginWith(token);
    const stored = await redisGet(redis, IDENTITY_KEYS.billingLoginToken, token);
    expect(stored._unsafeUnwrap()).toEqual({ userId });
  });

  it('converges replays of the same token onto one deterministic session', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    const first = await loginWith(token);
    const second = await loginWith(token);
    const firstClaims = await unsealCookie(first.response);
    const secondClaims = await unsealCookie(second.response);
    expect(secondClaims.sessionId).toBe(firstClaims.sessionId);
  });

  it('derives distinct sessions from distinct tokens', async () => {
    const userId = await createUser();
    const tokenA = await issueToken(userId);
    const tokenB = await issueToken(userId);
    const loginA = await loginWith(tokenA);
    const loginB = await loginWith(tokenB);
    const claimsA = await unsealCookie(loginA.response);
    const claimsB = await unsealCookie(loginB.response);
    expect(claimsA.sessionId).not.toBe(claimsB.sessionId);
  });

  it('yields exactly one distinct session under concurrent same-token logins', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    const results = await Promise.all(Array.from({ length: 5 }, () => loginWith(token)));
    const sessionIds = new Set<string>();
    for (const { outcome, response } of results) {
      expect(outcome).toEqual({ kind: 'logged-in' });
      const claims = await unsealCookie(response);
      sessionIds.add(claims.sessionId);
    }
    expect(sessionIds.size).toBe(1);
  });

  it('surfaces a digest failure as unavailable instead of a refusal', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    const spy = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('digest down'));
    try {
      const response = new Response();
      const result = await billingTokenLogin({
        redis,
        store: stores.users,
        token,
        request: new Request('http://localhost/auth/token-login'),
        response,
        secret: SECRET,
        isProduction: false,
        now: Date.now(),
      });
      expect(result._unsafeUnwrapErr().code).toBe('unavailable');
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses an unknown token without minting anything', async () => {
    const { outcome, response } = await loginWith(crypto.randomUUID());
    expect(outcome).toEqual({ kind: 'invalid' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a token whose user no longer exists with the same uniform outcome', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    await db.delete(users).where(eq(users.id, userId));
    const { outcome, response } = await loginWith(token);
    expect(outcome).toEqual({ kind: 'invalid' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a token for a locked account with the same uniform outcome', async () => {
    const userId = await createUser();
    const token = await issueToken(userId);
    await db
      .update(users)
      .set({ lockedAt: new Date(), lockReason: 'admin' })
      .where(eq(users.id, userId));
    const { outcome, response } = await loginWith(token);
    expect(outcome).toEqual({ kind: 'invalid' });
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
