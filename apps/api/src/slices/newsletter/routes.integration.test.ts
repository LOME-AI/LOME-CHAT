import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, newsletterSubscribers, users } from '@hushbox/db';
import { ERROR_CODES, NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { signHmacSha256Webhook } from '@hushbox/crypto';
import { applyPipeline } from '../../middleware/pipeline.js';
import { markPipelineHandler } from '../../middleware/pipeline-markers.js';
import { rateLimitByIp } from '../../middleware/rate-limit.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { unavailableError } from '../../lib/errors/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { createIdentityStores } from '../identity/index.js';
import {
  createNewsletterManifest,
  createNewsletterStores,
  createResendWebhookVerifier,
  newsletterConfirmIpRateLimit,
  newsletterSubscribeIpRateLimit,
  newsletterUnsubscribeIpRateLimit,
} from './index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { NewsletterConfirmEmailPort, NewsletterStoresFactory } from './index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for newsletter route tests');
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
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdEmails: string[] = [];
let counter = 0;
let ipCounter = 0;

/**
 * Unique per-test client IP so the shared Redis window never cross-couples
 * tests — or back-to-back runs inside one 60s window (the random run octets
 * make each run's IPs distinct).
 */
const RUN_OCTETS = `${String(Math.floor(Math.random() * 256))}.${String(
  Math.floor(Math.random() * 256)
)}`;

function nextIp(): string {
  ipCounter += 1;
  return `10.${RUN_OCTETS}.${String(ipCounter)}`;
}

function nextEmail(tag: string): string {
  counter += 1;
  const email = `${tag}${String(counter)}-${crypto.randomUUID().slice(0, 8)}@newsletter.test`;
  createdEmails.push(email);
  return email;
}

interface SentConfirmation {
  readonly to: string;
  readonly token: string;
}

function recordingEmailPort(): { port: NewsletterConfirmEmailPort; sent: SentConfirmation[] } {
  const sent: SentConfirmation[] = [];
  return {
    port: {
      sendConfirmation: (args) => {
        sent.push(args);
        return okAsync();
      },
    },
    sent,
  };
}

function failingEmailPort(): NewsletterConfirmEmailPort {
  return { sendConfirmation: () => errAsync(unavailableError('sender down')) };
}

async function newSessionUser(): Promise<{ userId: string; email: string; cookie: string }> {
  counter += 1;
  const username = `nlroute${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const email = nextEmail('acct');
  const rows = await db
    .insert(users)
    .values({
      email,
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
  return { userId, email, cookie };
}

interface AppOptions {
  emailPort?: NewsletterConfirmEmailPort;
  stores?: NewsletterStoresFactory;
}

const WEBHOOK_SECRET_B64 = Buffer.from('newsletter-route-webhook-secret').toString('base64');
const WEBHOOK_SECRET = `whsec_${WEBHOOK_SECRET_B64}`;

/** Pipeline + the same per-IP subscribe throttle app.ts mounts on the route. */
function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const manifest = createNewsletterManifest({
    stores: options.stores ?? createNewsletterStores,
    confirmEmail: options.emailPort ?? recordingEmailPort().port,
    identityUsers: (dbArgument) => createIdentityStores(dbArgument).users,
    webhookVerifier: () => createResendWebhookVerifier({ secret: WEBHOOK_SECRET }),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.use(
    '/newsletter/subscribe',
    markPipelineHandler(rateLimitByIp(newsletterSubscribeIpRateLimit))
  );
  app.use('/newsletter/confirm', markPipelineHandler(rateLimitByIp(newsletterConfirmIpRateLimit)));
  app.use(
    '/newsletter/unsubscribe',
    markPipelineHandler(rateLimitByIp(newsletterUnsubscribeIpRateLimit))
  );
  app.route(manifest.basePath, manifest.routes);
  return app;
}

interface RequestOptions {
  app?: Hono<AppEnv>;
  path: string;
  method?: string;
  ip?: string;
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
  query?: string;
  headers?: Record<string, string>;
}

function buildHeaders(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.rawBody !== undefined || options.body !== undefined) {
    headers['content-type'] = options.contentType ?? 'application/json';
  }
  // Every request carries a distinct IP unless a test pins one: all three
  // public routes are IP-limited, and the shared 'unknown' fallback would
  // couple unrelated tests through one Redis window.
  headers['x-forwarded-for'] = options.ip ?? nextIp();
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  return { ...headers, ...options.headers };
}

async function send(options: RequestOptions): Promise<Response> {
  const init: RequestInit = { method: options.method ?? 'POST', headers: buildHeaders(options) };
  if (options.rawBody !== undefined) init.body = options.rawBody;
  else if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const app = options.app ?? createApp();
  return app.request(`${options.path}${options.query ?? ''}`, init, testEnv);
}

async function subscriberRow(
  email: string
): Promise<typeof newsletterSubscribers.$inferSelect | undefined> {
  const rows = await db
    .select()
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, email));
  return rows[0];
}

async function mustSubscriberRow(
  email: string
): Promise<typeof newsletterSubscribers.$inferSelect> {
  const row = await subscriberRow(email);
  if (row === undefined) throw new Error(`no subscriber row for ${email}`);
  return row;
}

async function seedRow(
  values: Partial<typeof newsletterSubscribers.$inferInsert> & { email: string }
): Promise<typeof newsletterSubscribers.$inferSelect> {
  const rows = await db
    .insert(newsletterSubscribers)
    .values({
      status: 'pending',
      consentSource: 'marketing_site',
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      unsubscribeToken: crypto.randomUUID(),
      ...values,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('newsletter seed failed');
  return row;
}

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.email, createdEmails));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('POST /newsletter/subscribe', () => {
  it('creates a pending subscriber with consent evidence on a fresh email', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('fresh');
    const ip = nextIp();
    const res = await send({ app, path: '/newsletter/subscribe', ip, body: { email } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await mustSubscriberRow(email);
    expect(row.status).toBe('pending');
    expect(row.consentSource).toBe('marketing_site');
    expect(row.consentIp).toBe(ip);
    expect(row.consentTextVersion).toBe(NEWSLETTER_CONSENT_TEXT_VERSION);
    expect(row.confirmToken).not.toBeNull();
    expect(row.confirmExpiresAt).not.toBeNull();
    expect(row.confirmSentAt).not.toBeNull();
    expect(row.unsubscribeToken).not.toBe('');
    expect(sent).toEqual([{ to: email, token: row.confirmToken }]);
  });

  it('does not resend inside the pending resend throttle', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('throttled');
    await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    const first = await subscriberRow(email);
    const res = await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await subscriberRow(email);
    expect(row?.confirmToken).toBe(first?.confirmToken);
    expect(sent).toHaveLength(1);
  });

  it('refreshes the token and resends when the pending send is older than the throttle', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('refresh');
    const staleToken = crypto.randomUUID();
    await seedRow({
      email,
      status: 'pending',
      confirmToken: staleToken,
      confirmExpiresAt: new Date(Date.now() - 1000),
      confirmSentAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    const ip = nextIp();
    const res = await send({ app, path: '/newsletter/subscribe', ip, body: { email } });
    expect(res.status).toBe(200);
    const row = await subscriberRow(email);
    expect(row?.confirmToken).not.toBe(staleToken);
    expect(row?.confirmExpiresAt?.getTime()).toBeGreaterThan(Date.now());
    expect(row?.consentIp).toBe(ip);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.token).toBe(row?.confirmToken);
  });

  it('no-ops on an already-subscribed email', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('active');
    const seeded = await seedRow({ email, status: 'subscribed', confirmedAt: new Date() });
    const res = await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('subscribed');
    expect(row?.confirmToken).toBe(seeded.confirmToken);
    expect(sent).toHaveLength(0);
  });

  it('reopens an unsubscribed row to pending with fresh consent and resends', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('resignup');
    await seedRow({ email, status: 'unsubscribed', unsubscribedAt: new Date() });
    const ip = nextIp();
    const res = await send({ app, path: '/newsletter/subscribe', ip, body: { email } });
    expect(res.status).toBe(200);
    const row = await subscriberRow(email);
    expect(row?.status).toBe('pending');
    expect(row?.unsubscribedAt).toBeNull();
    expect(row?.confirmToken).not.toBeNull();
    expect(row?.consentIp).toBe(ip);
    expect(row?.consentSource).toBe('marketing_site');
    expect(row?.consentTextVersion).toBe(NEWSLETTER_CONSENT_TEXT_VERSION);
    expect(sent).toHaveLength(1);
  });

  it('reopens a bounce-suppressed row to pending and resends', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('bounced');
    await seedRow({
      email,
      status: 'suppressed',
      suppressReason: 'bounce',
      suppressedAt: new Date(),
    });
    const res = await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    expect(res.status).toBe(200);
    const row = await subscriberRow(email);
    expect(row?.status).toBe('pending');
    expect(row?.suppressReason).toBeNull();
    expect(row?.suppressedAt).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('never emails a complaint-suppressed address again', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('complained');
    await seedRow({
      email,
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt: new Date(),
    });
    const res = await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('suppressed');
    expect(row?.suppressReason).toBe('complaint');
    expect(sent).toHaveLength(0);
  });

  it('answers byte-identical bodies across every branch (enumeration safety)', async () => {
    const app = createApp();
    const subscribedEmail = nextEmail('enum-active');
    await seedRow({ email: subscribedEmail, status: 'subscribed', confirmedAt: new Date() });
    const complainedEmail = nextEmail('enum-complaint');
    await seedRow({
      email: complainedEmail,
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt: new Date(),
    });
    const bodies = await Promise.all(
      [nextEmail('enum-fresh'), subscribedEmail, complainedEmail].map(async (email) => {
        const res = await send({
          app,
          path: '/newsletter/subscribe',
          ip: nextIp(),
          body: { email },
        });
        expect(res.status).toBe(200);
        return res.text();
      })
    );
    expect(new Set(bodies).size).toBe(1);
  });

  it('rejects a malformed email with 400 VALIDATION', async () => {
    const res = await send({
      path: '/newsletter/subscribe',
      ip: nextIp(),
      body: { email: 'not-an-email' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('still answers ok when the confirmation send fails (best-effort)', async () => {
    const app = createApp({ emailPort: failingEmailPort() });
    const email = nextEmail('sendfail');
    const res = await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('pending');
  });

  it('answers 503 when the store is unavailable', async () => {
    const stores: NewsletterStoresFactory = (dbArgument) => ({
      ...createNewsletterStores(dbArgument),
      findByEmail: () => errAsync(unavailableError('store down')),
    });
    const res = await send({
      app: createApp({ stores }),
      path: '/newsletter/subscribe',
      ip: nextIp(),
      body: { email: nextEmail('storedown') },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });

  it('throttles the eleventh subscribe from one IP inside the window', async () => {
    const app = createApp();
    const ip = nextIp();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await send({
        app,
        path: '/newsletter/subscribe',
        ip,
        body: { email: nextEmail('ratelimit') },
      });
      expect(res.status).toBe(200);
    }
    const blocked = await send({
      app,
      path: '/newsletter/subscribe',
      ip,
      body: { email: nextEmail('ratelimit') },
    });
    expect(blocked.status).toBe(429);
  });
});

describe('POST /newsletter/subscribe converged races', () => {
  it('skips the send when a racing insert already created the row', async () => {
    const { port, sent } = recordingEmailPort();
    const stores: NewsletterStoresFactory = (dbArgument) => ({
      ...createNewsletterStores(dbArgument),
      insertPending: () => okAsync(false),
    });
    const res = await send({
      app: createApp({ emailPort: port, stores }),
      path: '/newsletter/subscribe',
      ip: nextIp(),
      body: { email: nextEmail('race-insert') },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it('skips the resend when the pending row changed under the refresh', async () => {
    const { port, sent } = recordingEmailPort();
    const email = nextEmail('race-refresh');
    await seedRow({
      email,
      status: 'pending',
      confirmSentAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    const stores: NewsletterStoresFactory = (dbArgument) => ({
      ...createNewsletterStores(dbArgument),
      refreshPendingConfirm: () => okAsync(false),
    });
    const res = await send({
      app: createApp({ emailPort: port, stores }),
      path: '/newsletter/subscribe',
      ip: nextIp(),
      body: { email },
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('skips the resend when the terminal row changed under the reopen', async () => {
    const { port, sent } = recordingEmailPort();
    const email = nextEmail('race-reopen');
    await seedRow({ email, status: 'unsubscribed', unsubscribedAt: new Date() });
    const stores: NewsletterStoresFactory = (dbArgument) => ({
      ...createNewsletterStores(dbArgument),
      reopenForConfirmation: () => okAsync(false),
    });
    const res = await send({
      app: createApp({ emailPort: port, stores }),
      path: '/newsletter/subscribe',
      ip: nextIp(),
      body: { email },
    });
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('treats a pending row with no recorded send as past the throttle', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('no-sent-at');
    await seedRow({ email, status: 'pending', confirmSentAt: null });
    const res = await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    expect(res.status).toBe(200);
    const row = await subscriberRow(email);
    expect(row?.confirmSentAt).not.toBeNull();
    expect(sent).toHaveLength(1);
  });
});

describe('POST /newsletter/confirm', () => {
  it('flips a pending row to subscribed and keeps the now-inert token', async () => {
    const email = nextEmail('confirm');
    const token = crypto.randomUUID();
    await seedRow({
      email,
      status: 'pending',
      confirmToken: token,
      confirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      confirmSentAt: new Date(),
    });
    const res = await send({ path: '/newsletter/confirm', body: { token } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('subscribed');
    expect(row?.confirmedAt).not.toBeNull();
    // The token is deliberately KEPT (design ruling: email re-clicks are the
    // most common second impression) — inert on a subscribed row, its only
    // remaining power is the success no-op below.
    expect(row?.confirmToken).not.toBeNull();
  });

  it('answers 200 ok on a replayed confirm link (already-done no-op)', async () => {
    const email = nextEmail('confirm-replay');
    const token = crypto.randomUUID();
    await seedRow({
      email,
      status: 'pending',
      confirmToken: token,
      confirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await send({ path: '/newsletter/confirm', body: { token } });
    const replay = await send({ path: '/newsletter/confirm', body: { token } });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('subscribed');
  });

  it('never re-subscribes an unsubscribed row from an old confirm link', async () => {
    const email = nextEmail('confirm-after-unsub');
    const token = crypto.randomUUID();
    await seedRow({
      email,
      status: 'unsubscribed',
      unsubscribedAt: new Date(),
      confirmToken: token,
      confirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await send({ path: '/newsletter/confirm', body: { token } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NEWSLETTER_CONFIRM_INVALID });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('unsubscribed');
  });

  it('never re-subscribes a complaint-suppressed row from an old confirm link', async () => {
    const email = nextEmail('confirm-after-complaint');
    const token = crypto.randomUUID();
    await seedRow({
      email,
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt: new Date(),
      confirmToken: token,
      confirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await send({ path: '/newsletter/confirm', body: { token } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NEWSLETTER_CONFIRM_INVALID });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('suppressed');
    expect(row?.suppressReason).toBe('complaint');
  });

  it('rejects an expired token', async () => {
    const email = nextEmail('confirm-expired');
    const token = crypto.randomUUID();
    await seedRow({
      email,
      status: 'pending',
      confirmToken: token,
      confirmExpiresAt: new Date(Date.now() - 1000),
    });
    const res = await send({ path: '/newsletter/confirm', body: { token } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NEWSLETTER_CONFIRM_INVALID });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('pending');
  });

  it('rejects an unknown token', async () => {
    const res = await send({ path: '/newsletter/confirm', body: { token: crypto.randomUUID() } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NEWSLETTER_CONFIRM_INVALID });
  });

  it('rejects a token on a row that is no longer pending', async () => {
    const email = nextEmail('confirm-wrongstatus');
    const token = crypto.randomUUID();
    await seedRow({
      email,
      status: 'unsubscribed',
      unsubscribedAt: new Date(),
      confirmToken: token,
      confirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const res = await send({ path: '/newsletter/confirm', body: { token } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NEWSLETTER_CONFIRM_INVALID });
  });

  it('rejects a missing token with 400 VALIDATION', async () => {
    const res = await send({ path: '/newsletter/confirm', body: {} });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('throttles the thirty-first confirm from one IP inside the window', async () => {
    const app = createApp();
    const ip = nextIp();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const res = await send({
        app,
        path: '/newsletter/confirm',
        ip,
        body: { token: crypto.randomUUID() },
      });
      expect(res.status).toBe(400);
    }
    const blocked = await send({
      app,
      path: '/newsletter/confirm',
      ip,
      body: { token: crypto.randomUUID() },
    });
    expect(blocked.status).toBe(429);
  });
});

describe('POST /newsletter/unsubscribe', () => {
  it('accepts the RFC 8058 one-click form POST with the token in the query', async () => {
    const email = nextEmail('oneclick');
    const row = await seedRow({ email, status: 'subscribed', confirmedAt: new Date() });
    const res = await send({
      path: '/newsletter/unsubscribe',
      query: `?token=${row.unsubscribeToken}`,
      rawBody: 'List-Unsubscribe=One-Click',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Location')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
    const updated = await subscriberRow(email);
    expect(updated?.status).toBe('unsubscribed');
    expect(updated?.unsubscribedAt).not.toBeNull();
  });

  it('accepts the JSON body path', async () => {
    const email = nextEmail('goodbye');
    const row = await seedRow({ email, status: 'subscribed', confirmedAt: new Date() });
    const res = await send({
      path: '/newsletter/unsubscribe',
      body: { token: row.unsubscribeToken },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const updated = await subscriberRow(email);
    expect(updated?.status).toBe('unsubscribed');
  });

  it('treats a repeated unsubscribe as success', async () => {
    const email = nextEmail('unsub-repeat');
    const row = await seedRow({ email, status: 'subscribed', confirmedAt: new Date() });
    await send({ path: '/newsletter/unsubscribe', body: { token: row.unsubscribeToken } });
    const repeat = await send({
      path: '/newsletter/unsubscribe',
      body: { token: row.unsubscribeToken },
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ ok: true });
  });

  it('rejects an unknown token', async () => {
    const res = await send({
      path: '/newsletter/unsubscribe',
      body: { token: crypto.randomUUID() },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NEWSLETTER_UNSUBSCRIBE_INVALID });
  });

  it('leaves a suppressed row suppressed and still answers success', async () => {
    const email = nextEmail('unsub-suppressed');
    const row = await seedRow({
      email,
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt: new Date(),
    });
    const res = await send({
      path: '/newsletter/unsubscribe',
      body: { token: row.unsubscribeToken },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const updated = await subscriberRow(email);
    expect(updated?.status).toBe('suppressed');
  });

  it('prefers the query token over a JSON body token', async () => {
    const email = nextEmail('unsub-precedence');
    const row = await seedRow({ email, status: 'subscribed', confirmedAt: new Date() });
    const res = await send({
      path: '/newsletter/unsubscribe',
      query: `?token=${row.unsubscribeToken}`,
      body: { token: crypto.randomUUID() },
    });
    expect(res.status).toBe(200);
    const updated = await subscriberRow(email);
    expect(updated?.status).toBe('unsubscribed');
  });

  it('falls through an empty query token to the JSON body', async () => {
    const email = nextEmail('unsub-emptyquery');
    const row = await seedRow({ email, status: 'subscribed', confirmedAt: new Date() });
    const res = await send({
      path: '/newsletter/unsubscribe',
      query: '?token=',
      body: { token: row.unsubscribeToken },
    });
    expect(res.status).toBe(200);
    const updated = await subscriberRow(email);
    expect(updated?.status).toBe('unsubscribed');
  });

  it('honors the original emailed token after a full leave-and-return cycle', async () => {
    // Old footer links must keep working: unsubscribed → re-signup → confirm
    // never rotates the unsubscribeToken.
    const { port } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const email = nextEmail('unsub-cycle');
    const original = await seedRow({ email, status: 'unsubscribed', unsubscribedAt: new Date() });
    await send({ app, path: '/newsletter/subscribe', ip: nextIp(), body: { email } });
    const reopened = await mustSubscriberRow(email);
    await send({ app, path: '/newsletter/confirm', body: { token: reopened.confirmToken } });
    const confirmed = await mustSubscriberRow(email);
    expect(confirmed.status).toBe('subscribed');
    const res = await send({
      app,
      path: '/newsletter/unsubscribe',
      body: { token: original.unsubscribeToken },
    });
    expect(res.status).toBe(200);
    const final = await mustSubscriberRow(email);
    expect(final.status).toBe('unsubscribed');
  });

  it('throttles the thirty-first unsubscribe from one IP inside the window', async () => {
    const app = createApp();
    const ip = nextIp();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const res = await send({
        app,
        path: '/newsletter/unsubscribe',
        ip,
        body: { token: crypto.randomUUID() },
      });
      expect(res.status).toBe(400);
    }
    const blocked = await send({
      app,
      path: '/newsletter/unsubscribe',
      ip,
      body: { token: crypto.randomUUID() },
    });
    expect(blocked.status).toBe(429);
  });

  it('rejects a request with no token anywhere with 400 VALIDATION', async () => {
    const res = await send({
      path: '/newsletter/unsubscribe',
      rawBody: 'List-Unsubscribe=One-Click',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});

describe('newsletter store outage responses', () => {
  function failingStores(overrides: Partial<ReturnType<NewsletterStoresFactory>>): {
    app: Hono<AppEnv>;
  } {
    const stores: NewsletterStoresFactory = (dbArgument) => ({
      ...createNewsletterStores(dbArgument),
      ...overrides,
    });
    return { app: createApp({ stores }) };
  }

  it('confirm answers 503 when the store is unavailable', async () => {
    const { app } = failingStores({
      consumeConfirmToken: () => errAsync(unavailableError('store down')),
    });
    const res = await send({ app, path: '/newsletter/confirm', body: { token: 'tok' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });

  it('unsubscribe answers 503 when the store is unavailable', async () => {
    const { app } = failingStores({
      unsubscribeByToken: () => errAsync(unavailableError('store down')),
    });
    const res = await send({ app, path: '/newsletter/unsubscribe', body: { token: 'tok' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });

  it('settings toggle answers 503 when the store is unavailable', async () => {
    const { cookie } = await newSessionUser();
    const { app } = failingStores({
      upsertAccountSubscription: () => errAsync(unavailableError('store down')),
    });
    const res = await send({
      app,
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      body: { subscribed: true },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});

describe('GET /newsletter/me', () => {
  it('refuses an anonymous caller', async () => {
    const res = await send({ path: '/newsletter/me', method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('answers 404 when the account row is gone', async () => {
    const { cookie } = await newSessionUser();
    const manifest = createNewsletterManifest({
      stores: createNewsletterStores,
      confirmEmail: recordingEmailPort().port,
      identityUsers: () => ({ findById: () => okAsync(null) }),
      webhookVerifier: () => createResendWebhookVerifier({ secret: WEBHOOK_SECRET }),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await send({ app, path: '/newsletter/me', method: 'GET', cookie });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers subscribed:false when no row exists', async () => {
    const { cookie } = await newSessionUser();
    const res = await send({ path: '/newsletter/me', method: 'GET', cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false });
  });

  it('matches an anonymous row by the account email', async () => {
    const { cookie, email } = await newSessionUser();
    await seedRow({ email, status: 'subscribed', confirmedAt: new Date() });
    const res = await send({ path: '/newsletter/me', method: 'GET', cookie });
    expect(await res.json()).toEqual({ subscribed: true });
  });

  it('matches a linked row by userId even when its email differs', async () => {
    const { cookie, userId } = await newSessionUser();
    await seedRow({
      email: nextEmail('old-address'),
      status: 'subscribed',
      confirmedAt: new Date(),
      userId,
    });
    const res = await send({ path: '/newsletter/me', method: 'GET', cookie });
    expect(await res.json()).toEqual({ subscribed: true });
  });
});

describe('PUT /newsletter/me', () => {
  it('subscribes instantly without a confirmation email or Idempotency-Key', async () => {
    const { port, sent } = recordingEmailPort();
    const app = createApp({ emailPort: port });
    const { cookie, userId, email } = await newSessionUser();
    const ip = nextIp();
    const res = await send({
      app,
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip,
      body: { subscribed: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: true });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('subscribed');
    expect(row?.userId).toBe(userId);
    expect(row?.confirmedAt).not.toBeNull();
    expect(row?.consentSource).toBe('app_settings');
    expect(row?.consentIp).toBe(ip);
    expect(row?.consentTextVersion).toBe(NEWSLETTER_CONSENT_TEXT_VERSION);
    expect(sent).toHaveLength(0);
  });

  it('converges on repeat toggle-on (naturally idempotent)', async () => {
    const { cookie, email } = await newSessionUser();
    await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip: nextIp(),
      body: { subscribed: true },
    });
    const repeat = await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip: nextIp(),
      body: { subscribed: true },
    });
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ subscribed: true });
    const rows = await db
      .select({ id: newsletterSubscribers.id })
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(rows).toHaveLength(1);
  });

  it('links a pre-existing anonymous row instead of duplicating it', async () => {
    const { cookie, userId, email } = await newSessionUser();
    const seeded = await seedRow({ email, status: 'unsubscribed', unsubscribedAt: new Date() });
    const res = await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip: nextIp(),
      body: { subscribed: true },
    });
    expect(await res.json()).toEqual({ subscribed: true });
    const rows = await db
      .select()
      .from(newsletterSubscribers)
      .where(eq(newsletterSubscribers.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(seeded.id);
    expect(rows[0]?.userId).toBe(userId);
    expect(rows[0]?.status).toBe('subscribed');
    expect(rows[0]?.unsubscribedAt).toBeNull();
  });

  it('keeps a complaint-suppressed row suppressed and reports subscribed:false', async () => {
    const { cookie, email } = await newSessionUser();
    await seedRow({
      email,
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt: new Date(),
    });
    const res = await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip: nextIp(),
      body: { subscribed: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('suppressed');
    expect(row?.suppressReason).toBe('complaint');
  });

  it('unsubscribes on toggle-off', async () => {
    const { cookie, email } = await newSessionUser();
    await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip: nextIp(),
      body: { subscribed: true },
    });
    const res = await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip: nextIp(),
      body: { subscribed: false },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false });
    const row = await subscriberRow(email);
    expect(row?.status).toBe('unsubscribed');
    expect(row?.unsubscribedAt).not.toBeNull();
  });

  it('answers subscribed:false on toggle-off when no row exists', async () => {
    const { cookie } = await newSessionUser();
    const res = await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      ip: nextIp(),
      body: { subscribed: false },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ subscribed: false });
  });

  it('rejects a non-boolean body with 400 VALIDATION', async () => {
    const { cookie } = await newSessionUser();
    const res = await send({
      path: '/newsletter/me',
      method: 'PUT',
      cookie,
      body: { subscribed: 'yes' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});

describe('POST /newsletter/webhooks/resend', () => {
  function eventBody(type: string, to: readonly string[]): string {
    return JSON.stringify({ type, data: { to: [...to] } });
  }

  async function signedWebhook(
    rawBody: string,
    options: { readonly id?: string; readonly skewSeconds?: number } = {}
  ): Promise<Record<string, string>> {
    const svixId = options.id ?? `msg_${crypto.randomUUID()}`;
    const svixTimestamp = String(Math.floor(Date.now() / 1000) + (options.skewSeconds ?? 0));
    const svixSignature = await signHmacSha256Webhook({
      secret: WEBHOOK_SECRET_B64,
      payload: rawBody,
      timestamp: svixTimestamp,
      webhookId: svixId,
    });
    return { 'svix-id': svixId, 'svix-timestamp': svixTimestamp, 'svix-signature': svixSignature };
  }

  async function postWebhook(rawBody: string, headers: Record<string, string>): Promise<Response> {
    return send({ path: '/newsletter/webhooks/resend', rawBody, headers });
  }

  it('rejects a delivery with missing signature headers and processes nothing', async () => {
    const { email } = await seedRow({ email: nextEmail('wh-missing'), status: 'subscribed' });
    const res = await postWebhook(eventBody('email.bounced', [email]), {});

    expect(res.status).toBe(401);
    const row = await mustSubscriberRow(email);
    expect(row.status).toBe('subscribed');
  });

  it('rejects a tampered body with 401 and processes nothing', async () => {
    const { email } = await seedRow({ email: nextEmail('wh-tamper'), status: 'subscribed' });
    const signedOver = eventBody('email.bounced', ['someone-else@newsletter.test']);
    const headers = await signedWebhook(signedOver);

    const res = await postWebhook(eventBody('email.bounced', [email]), headers);

    expect(res.status).toBe(401);
    const row = await mustSubscriberRow(email);
    expect(row.status).toBe('subscribed');
  });

  it('rejects an expired timestamp with 401', async () => {
    const body = eventBody('email.bounced', ['whoever@newsletter.test']);
    const res = await postWebhook(body, await signedWebhook(body, { skewSeconds: -301 }));

    expect(res.status).toBe(401);
  });

  it('suppresses a subscribed recipient on a verified bounce', async () => {
    const { email } = await seedRow({ email: nextEmail('wh-bounce'), status: 'subscribed' });
    const body = eventBody('email.bounced', [email]);

    const res = await postWebhook(body, await signedWebhook(body));

    expect(res.status).toBe(200);
    const row = await mustSubscriberRow(email);
    expect(row.status).toBe('suppressed');
    expect(row.suppressReason).toBe('bounce');
    expect(row.suppressedAt).not.toBeNull();
  });

  it('escalates a bounce suppression to complaint', async () => {
    const { email } = await seedRow({
      email: nextEmail('wh-escalate'),
      status: 'suppressed',
      suppressReason: 'bounce',
      suppressedAt: new Date(0),
    });
    const body = eventBody('email.complained', [email]);

    const res = await postWebhook(body, await signedWebhook(body));

    expect(res.status).toBe(200);
    const row = await mustSubscriberRow(email);
    expect(row.suppressReason).toBe('complaint');
  });

  it('answers 200 without demoting a complaint suppression on a later bounce', async () => {
    const { email } = await seedRow({
      email: nextEmail('wh-sticky'),
      status: 'suppressed',
      suppressReason: 'complaint',
      suppressedAt: new Date(0),
    });
    const body = eventBody('email.bounced', [email]);

    const res = await postWebhook(body, await signedWebhook(body));

    expect(res.status).toBe(200);
    const row = await mustSubscriberRow(email);
    expect(row.suppressReason).toBe('complaint');
  });

  it('answers 200 for a recipient who never subscribed', async () => {
    const body = eventBody('email.bounced', [
      `stranger-${crypto.randomUUID().slice(0, 8)}@newsletter.test`,
    ]);

    const res = await postWebhook(body, await signedWebhook(body));

    expect(res.status).toBe(200);
  });

  it('answers 200 as a no-op for a verified non-suppression event type', async () => {
    const { email } = await seedRow({ email: nextEmail('wh-other'), status: 'subscribed' });
    const body = eventBody('email.delivered', [email]);

    const res = await postWebhook(body, await signedWebhook(body));

    expect(res.status).toBe(200);
    const row = await mustSubscriberRow(email);
    expect(row.status).toBe('subscribed');
  });

  it('replays the same svix-id to a single effect', async () => {
    const { email } = await seedRow({ email: nextEmail('wh-replay'), status: 'subscribed' });
    const body = eventBody('email.bounced', [email]);
    const headers = await signedWebhook(body);

    const firstDelivery = await postWebhook(body, headers);
    expect(firstDelivery.status).toBe(200);
    const afterFirst = await mustSubscriberRow(email);

    const secondDelivery = await postWebhook(body, headers);
    expect(secondDelivery.status).toBe(200);
    const afterSecond = await mustSubscriberRow(email);

    expect(afterFirst.suppressReason).toBe('bounce');
    expect(afterSecond.suppressedAt).toEqual(afterFirst.suppressedAt);
  });
});
