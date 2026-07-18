import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { eq, inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb, feedback, users } from '@hushbox/db';
import { ERROR_CODES } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { markPipelineHandler } from '../../middleware/pipeline-markers.js';
import { rateLimitByCaller } from '../../middleware/rate-limit.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { unavailableError } from '../../lib/errors/index.js';
import { errAsync } from '../../lib/result/index.js';
import { LINK_CREDENTIAL_HEADER } from '../conversations/index.js';
import {
  createFeedbackManifest,
  createFeedbackStores,
  feedbackSubmitHourlyRateLimit,
  feedbackSubmitRateLimit,
} from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { FeedbackStoresFactory } from './index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for feedback route tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
let counter = 0;

async function newSessionUser(): Promise<{ userId: string; cookie: string }> {
  counter += 1;
  const username = `fbroute${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@feedback-route.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const cookie = `${SESSION_COOKIE_NAME}=${await sealData(
    {
      userId,
      sessionId: 'session-1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  )}`;
  return { userId, cookie };
}

/** Pipeline + the same two per-caller submit throttles app.ts mounts on the route. */
function createApp(stores: FeedbackStoresFactory = createFeedbackStores): Hono<AppEnv> {
  const manifest = createFeedbackManifest({ stores });
  const app = applyPipeline(new Hono<AppEnv>());
  app.use(
    '/feedback',
    markPipelineHandler(
      rateLimitByCaller(feedbackSubmitRateLimit, { credentialHeader: LINK_CREDENTIAL_HEADER })
    )
  );
  app.use(
    '/feedback',
    markPipelineHandler(
      rateLimitByCaller(feedbackSubmitHourlyRateLimit, { credentialHeader: LINK_CREDENTIAL_HEADER })
    )
  );
  app.route(manifest.basePath, manifest.routes);
  return app;
}

interface PostOptions {
  cookie?: string;
  idempotencyKey?: string | null;
  body?: unknown;
  stores?: FeedbackStoresFactory;
}

/** Typed JSON read severed from hono's Response inference (json() is unknown here). */
async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function post(options: PostOptions): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  if (options.idempotencyKey !== null) {
    headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
  }
  return createApp(options.stores).request(
    '/feedback',
    {
      method: 'POST',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    testEnv
  );
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('POST /feedback authorization', () => {
  it('rejects an anonymous submission (session default-deny)', async () => {
    const res = await post({ body: { kind: 'bug', body: 'anon' } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('demands an Idempotency-Key from an authenticated caller', async () => {
    const { cookie } = await newSessionUser();
    const res = await post({ cookie, idempotencyKey: null, body: { kind: 'bug', body: 'x' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED });
  });
});

describe('POST /feedback submission', () => {
  it('persists the note and answers 200 with its id', async () => {
    const { userId, cookie } = await newSessionUser();
    const res = await post({ cookie, body: { kind: 'idea', body: 'ship dark mode' } });
    expect(res.status).toBe(200);
    const { id } = await readJson<{ id: string }>(res);
    const [row] = await db.select().from(feedback).where(eq(feedback.id, id));
    expect(row?.userId).toBe(userId);
    expect(row?.kind).toBe('idea');
    expect(row?.body).toBe('ship dark mode');
    expect(row?.status).toBe('new');
  });
});

describe('POST /feedback validation', () => {
  it('rejects a whitespace-only body with 400 VALIDATION', async () => {
    const { cookie } = await newSessionUser();
    const res = await post({ cookie, body: { kind: 'bug', body: '   ' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects an over-length body with 400 VALIDATION', async () => {
    const { cookie } = await newSessionUser();
    const res = await post({ cookie, body: { kind: 'bug', body: 'z'.repeat(4001) } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('rejects an invalid kind with 400 VALIDATION', async () => {
    const { cookie } = await newSessionUser();
    const res = await post({ cookie, body: { kind: 'rant', body: 'nope' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});

describe('POST /feedback idempotency', () => {
  it('replays the stored response for a retried key without a second row', async () => {
    const { userId, cookie } = await newSessionUser();
    const key = crypto.randomUUID();
    const body = { kind: 'praise', body: 'love it' };
    const first = await post({ cookie, idempotencyKey: key, body });
    const second = await post({ cookie, idempotencyKey: key, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    const rows = await db
      .select({ id: feedback.id })
      .from(feedback)
      .where(eq(feedback.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('answers 409 when the same key is reused with a different body', async () => {
    const { cookie } = await newSessionUser();
    const key = crypto.randomUUID();
    await post({ cookie, idempotencyKey: key, body: { kind: 'bug', body: 'original' } });
    const conflict = await post({
      cookie,
      idempotencyKey: key,
      body: { kind: 'bug', body: 'changed' },
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH });
  });
});

describe('POST /feedback duplicate-body dedup', () => {
  it('rejects a same-body resubmit under a fresh key with 409 FEEDBACK_DUPLICATE', async () => {
    const { cookie } = await newSessionUser();
    const body = { kind: 'bug', body: 'the same exact note' };
    const first = await post({ cookie, body });
    const second = await post({ cookie, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: ERROR_CODES.FEEDBACK_DUPLICATE });
  });

  it('accepts a different body from the same user', async () => {
    const { cookie } = await newSessionUser();
    await post({ cookie, body: { kind: 'bug', body: 'first distinct note' } });
    const second = await post({ cookie, body: { kind: 'bug', body: 'second distinct note' } });
    expect(second.status).toBe(200);
  });

  it('accepts an identical body from a different user', async () => {
    const shared = { kind: 'idea', body: 'a very shareable idea' } as const;
    const userA = await newSessionUser();
    const userB = await newSessionUser();
    const first = await post({ cookie: userA.cookie, body: shared });
    const second = await post({ cookie: userB.cookie, body: shared });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('accepts an identical body once the prior row is older than the dedup window', async () => {
    const { userId, cookie } = await newSessionUser();
    // A row committed two hours ago falls outside the one-hour dedup window.
    await db.insert(feedback).values({
      userId,
      kind: 'praise',
      body: 'aged praise',
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    const res = await post({ cookie, body: { kind: 'praise', body: 'aged praise' } });
    expect(res.status).toBe(200);
  });

  it('replays the original success for a network retry (same key, same body) without a 409', async () => {
    const { userId, cookie } = await newSessionUser();
    const key = crypto.randomUUID();
    const body = { kind: 'praise', body: 'retried identical note' };
    const first = await post({ cookie, idempotencyKey: key, body });
    // Same Idempotency-Key: byKey replays the stored 200 and never re-runs the
    // conditional insert, so the dedup guard cannot misfire on a legit retry.
    const retry = await post({ cookie, idempotencyKey: key, body });
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    const rows = await db
      .select({ id: feedback.id })
      .from(feedback)
      .where(eq(feedback.userId, userId));
    expect(rows).toHaveLength(1);
  });
});

describe('POST /feedback hourly cap', () => {
  it('refuses a submission once the hourly per-user window is at the cap', async () => {
    const { userId, cookie } = await newSessionUser();
    const { maxAttempts, windowSeconds } = feedbackSubmitHourlyRateLimit.rateLimitConfig;
    // Preset only the hourly counter to its cap; the 10/min burst key stays
    // empty, so a 429 here isolates the hourly ceiling.
    await redis.set(
      feedbackSubmitHourlyRateLimit.buildKey(userId),
      { count: maxAttempts, firstAttempt: Date.now() },
      { ex: windowSeconds }
    );
    const res = await post({ cookie, body: { kind: 'bug', body: 'past the hourly cap' } });
    expect(res.status).toBe(429);
    const parsed = await readJson<{ code: string; details: { retryAfterSeconds: number } }>(res);
    expect(parsed.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(parsed.details.retryAfterSeconds).toBeGreaterThan(0);
    await redis.del(feedbackSubmitHourlyRateLimit.buildKey(userId));
  });
});

describe('POST /feedback store failure', () => {
  it('answers 503 FEEDBACK_SUBMIT_FAILED when the store is unavailable', async () => {
    const { cookie } = await newSessionUser();
    const failingStores: FeedbackStoresFactory = () => ({
      insert: () => errAsync(unavailableError('feedback store down')),
    });
    const res = await post({
      cookie,
      body: { kind: 'bug', body: 'will fail' },
      stores: failingStores,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FEEDBACK_SUBMIT_FAILED });
  });
});

describe('POST /feedback rate limit', () => {
  it('refuses a submission once the per-caller window is at the cap', async () => {
    const { userId, cookie } = await newSessionUser();
    const { maxAttempts, windowSeconds } = feedbackSubmitRateLimit.rateLimitConfig;
    await redis.set(
      feedbackSubmitRateLimit.buildKey(userId),
      { count: maxAttempts, firstAttempt: Date.now() },
      { ex: windowSeconds }
    );
    const res = await post({ cookie, body: { kind: 'bug', body: 'over the cap' } });
    expect(res.status).toBe(429);
    const parsed = await readJson<{ code: string; details: { retryAfterSeconds: number } }>(res);
    expect(parsed.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(parsed.details.retryAfterSeconds).toBeGreaterThan(0);
    await redis.del(feedbackSubmitRateLimit.buildKey(userId));
  });
});
