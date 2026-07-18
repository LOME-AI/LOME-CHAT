import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  feedback,
  idempotencyKeys,
  modelCatalog,
  newsletterIssues,
  newsletterSubscribers,
  users,
} from '@hushbox/db';
import { Redis } from '@upstash/redis';
import { userFactory } from '@hushbox/db/factories';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Mode, envConfig } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { markPipelineHandler } from '../../middleware/pipeline-markers.js';
import { rateLimitByAdminActor } from '../../middleware/rate-limit.js';
import { adminNewsletterSubscribersRateLimit } from './adapters/rate-limit.js';
import { defineRateLimitKey } from '../../lib/redis/index.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from '../../middleware/pipeline-admin.js';
import { createAdminOpEngine } from './domain/engine.js';
import { createAdminFixtureRegistry } from './domain/fixture-ops.js';
import { createAdminReadSurface } from './domain/read-surface.js';
import { READ_AUDIT_ACTIONS } from './domain/read-audit.js';
import { createIdentityStores } from '../identity/index.js';
import { disableModelWithinTx } from '../models/index.js';
import { acquireModelCatalogLock } from '../models/__tests__/model-catalog-lock.js';
import { createBillingStores, readBalance, readUsageBreakdown } from '../billing/index.js';
import { createAdminCrossSliceReads } from '../../adapters/admin-read-bindings.js';
import { createAdminStores } from './adapters/stores.js';
import { createAdminAuditReads } from './adapters/audit-reads.js';
import { createSqlPanel } from './adapters/sql-panel.js';
import { createAdminManifest } from './routes.js';
import { err } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import type { DbTransaction } from '../../lib/idempotency/index.js';
import type { Result } from '../../lib/result/index.js';
import type { DomainError } from '../../lib/errors/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { AdminFixtureDeps, AdminFixtureScratch } from './domain/fixture-ops.js';

async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin read-route integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const RUN_ID = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const ADMIN_EMAIL = `admin-reads-run-${RUN_ID}@hushbox.test`;
const SCRATCH_ROUTE = `/admin-read-routes-fixture/${RUN_ID}`;

function panelUrl(): string {
  const url = new URL(DATABASE_URL!);
  url.username = 'admin_sql_panel';
  url.password = 'admin_sql_panel';
  return url.toString();
}

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('Redis env is required for admin read-route integration tests');
}

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-dev',
  CF_ACCESS_AUD: 'dev-admin-access-aud',
  ADMIN_ACTOR_ALLOWLIST: ADMIN_EMAIL,
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
  ADMIN_SQL_PANEL_DATABASE_URL: panelUrl(),
};

const scratch: AdminFixtureScratch = {
  async markWithinTx(tx, targetId): Promise<'marked' | 'already-marked'> {
    const writer = tx as DbTransaction;
    const existing = await writer
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.route, SCRATCH_ROUTE), eq(idempotencyKeys.key, targetId)));
    if (existing.length > 0) return 'already-marked';
    await writer.insert(idempotencyKeys).values({
      userId: targetId,
      route: SCRATCH_ROUTE,
      key: targetId,
      kind: 'request',
      bodyHash: 'fixture',
      claimedBy: 'fixture',
    });
    return 'marked';
  },
  async unmarkWithinTx(tx, targetId): Promise<void> {
    const writer = tx as DbTransaction;
    await writer
      .delete(idempotencyKeys)
      .where(and(eq(idempotencyKeys.route, SCRATCH_ROUTE), eq(idempotencyKeys.key, targetId)));
  },
};

const fixtureDeps: AdminFixtureDeps = {
  scratch,
  ephemeralLog: [],
  ephemeralFailure: { armed: false },
};

const registry = createAdminFixtureRegistry();
const stores = createAdminStores();
const billingStores = createBillingStores();

/** Tiny window so the trip test needs three requests, not 121 — mounted
 * exactly the way app.ts mounts the real registry entries. */
const tripWindow = defineRateLimitKey({
  schema: z.object({ count: z.number(), firstAttempt: z.number() }),
  ttlSeconds: 60,
  buildKey: (actorHash: string) => `admin:read:test:${RUN_ID}:ratelimit:${actorHash}`,
  rateLimitConfig: { maxAttempts: 2, windowSeconds: 60 },
});

/** Same tiny-window trick for the feedback inbox path (the real registry
 * entry is 240/hr — too generous to trip in a test). */
const feedbackTripWindow = defineRateLimitKey({
  schema: z.object({ count: z.number(), firstAttempt: z.number() }),
  ttlSeconds: 60,
  buildKey: (actorHash: string) => `admin:read:feedbacktest:${RUN_ID}:ratelimit:${actorHash}`,
  rateLimitConfig: { maxAttempts: 2, windowSeconds: 60 },
});

function createApp(): Hono<AppEnv> {
  const manifest = createAdminManifest({
    listOps: () => registry.list(),
    prefill: () => null,
    engine: (requestDb, telemetry) =>
      createAdminOpEngine({
        db: requestDb,
        registry,
        stores,
        telemetry,
        opDeps: fixtureDeps,
        executorId: `admin-reads-read-routes-${RUN_ID}`,
      }),
    reads: ({ db: requestDb, env, isDev }) =>
      createAdminReadSurface({
        db: requestDb,
        stores,
        auditReads: createAdminAuditReads(),
        crossSlice: createAdminCrossSliceReads(requestDb),
        identity: createIdentityStores(requestDb).users,
        billing: {
          balance: (userId, now) => readBalance(billingStores, requestDb, userId, now),
          ledgerHistory: (userId, window) =>
            billingStores.readLedgerHistory(requestDb, { userId, ...window }),
          usage: (userId) => readUsageBreakdown(billingStores, requestDb, { userId, limit: 20 }),
        },
        sqlPanel: createSqlPanel({ url: env.ADMIN_SQL_PANEL_DATABASE_URL ?? '', isDev }),
        clock: { now: (): Date => new Date() },
      }),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.use('/admin/users/overview', markPipelineHandler(rateLimitByAdminActor(tripWindow)));
  app.use('/admin/feedback', markPipelineHandler(rateLimitByAdminActor(feedbackTripWindow)));
  // The REAL subscriber-read registry entry (240/hr — never trips here):
  // mounted exactly the way app.ts mounts it, so its key builder is exercised.
  app.use(
    '/admin/newsletter/subscribers',
    markPipelineHandler(rateLimitByAdminActor(adminNewsletterSubscribersRateLimit))
  );
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function adminToken(email = ADMIN_EMAIL): Promise<string> {
  return mintDevAdminToken(testEnv, { email });
}

/** A fresh allowlisted actor per call — the tiny trip window mounted on the
 * overview path is per-actor, so tests stay order-independent. */
async function sendAsFreshActor(path: string): Promise<Response> {
  const email = `admin-reads-actor-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
  const env = { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email };
  const token = await mintDevAdminToken(env, { email });
  return createApp().request(path, { headers: { [CF_ACCESS_JWT_HEADER]: token } }, env);
}

interface RequestOptions {
  readonly method?: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

async function send(path: string, options: RequestOptions = {}): Promise<Response> {
  return createApp().request(
    path,
    {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(options.token === undefined ? {} : { [CF_ACCESS_JWT_HEADER]: options.token }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    testEnv
  );
}

const createdUserIds: string[] = [];

async function seedUser(): Promise<{ id: string; email: string }> {
  const inserted = await db
    .insert(users)
    .values(userFactory.build())
    .returning({ id: users.id, email: users.email });
  const row = inserted[0]!;
  createdUserIds.push(row.id);
  return row;
}

async function seedFeedback(status: 'new' | 'triaged' = 'new'): Promise<string> {
  const user = await seedUser();
  const rows = await db
    .insert(feedback)
    .values({ userId: user.id, kind: 'idea', body: 'x'.repeat(200), status })
    .returning({ id: feedback.id });
  return rows[0]!.id;
}

beforeAll(async () => {
  // Dev-only LOGIN provisioning (ensure-stack's job for `pnpm dev`).
  await db.execute(sql`ALTER ROLE admin_sql_panel LOGIN PASSWORD 'admin_sql_panel'`);
});

afterAll(async () => {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.route, SCRATCH_ROUTE));
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        like(idempotencyKeys.route, 'admin/ops/fixture.%'),
        like(idempotencyKeys.key, `admin-reads-key-${RUN_ID}%`)
      )
    );
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
});

describe('admin read routes: authz', () => {
  it.each([
    '/admin/users/overview?email=x%40y.test',
    '/admin/dashboard',
    '/admin/jobs',
    '/admin/feedback',
    '/admin/feedback/00000000-0000-0000-0000-000000000000',
    '/admin/models',
    '/admin/newsletter/issues',
    '/admin/newsletter/subscribers',
    '/admin/newsletter/subscribers/stats',
    '/admin/audit',
    '/admin/sql?query=SELECT%201',
  ])('%s refuses without an admin assertion', async (path) => {
    const response = await send(path);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
  });
});

describe('GET /admin/users/overview', () => {
  it('assembles the 360 and writes exactly one read-audit row', async () => {
    const user = await seedUser();
    const email = `admin-reads-360-actor-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const app = createApp();
    const token = await mintDevAdminToken({ ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }, { email });
    const response = await app.request(
      `/admin/users/overview?email=${encodeURIComponent(user.email)}`,
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }
    );

    expect(response.status).toBe(200);
    const view = await jsonBody<{ user: { id: string }; panels: Record<string, unknown> }>(
      response
    );
    expect(view.user.id).toBe(user.id);
    expect(Object.keys(view.panels).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'adminHistory',
      'conversations',
      'devices',
      'jobs',
      'money',
      'usage',
    ]);

    const audits = await db
      .select({ action: adminAudit.action, targetId: adminAudit.targetId })
      .from(adminAudit)
      .where(eq(adminAudit.actor, email));
    expect(audits).toEqual([{ action: READ_AUDIT_ACTIONS.customer360, targetId: user.id }]);
  });

  it('resolves the overview by userId as well', async () => {
    const user = await seedUser();

    const response = await sendAsFreshActor(`/admin/users/overview?userId=${user.id}`);

    expect(response.status).toBe(200);
    const view = await jsonBody<{ user: { id: string } }>(response);
    expect(view.user.id).toBe(user.id);
  });

  it('rejects a query with neither email nor userId', async () => {
    const response = await sendAsFreshActor('/admin/users/overview');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'VALIDATION' });
  });

  it('answers 404 for an unknown user', async () => {
    const response = await sendAsFreshActor(
      `/admin/users/overview?email=missing-${RUN_ID}%40hushbox.test`
    );
    expect(response.status).toBe(404);
  });

  it('trips the mounted read rate limit with the standard error shape', async () => {
    const user = await seedUser();
    const path = `/admin/users/overview?email=${encodeURIComponent(user.email)}`;
    // A dedicated actor: the window is per-actor and other tests in this
    // file consume the shared actor's budget (tests stay order-independent).
    const email = `admin-reads-trip-actor-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const env = { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email };
    const token = await mintDevAdminToken(env, { email });
    const app = createApp();
    const send = async (target: string): Promise<Response> =>
      app.request(target, { headers: { [CF_ACCESS_JWT_HEADER]: token } }, env);
    const first = await send(path);
    const second = await send(path);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const third = await send(path);
    expect(third.status).toBe(429);
    const body = await jsonBody<{ code: string; details: { retryAfterSeconds: number } }>(third);
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.details.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('GET /admin/newsletter/issues', () => {
  const issueMarker = `admin-read-routes-nl ${RUN_ID}`;

  async function seedIssue(): Promise<string> {
    const rows = await db
      .insert(newsletterIssues)
      .values({
        subject: `${issueMarker} ${crypto.randomUUID()}`,
        bodyMarkdown: 'body',
        status: 'scheduled',
        scheduledAt: new Date('2999-01-01T00:00:00.000Z'),
        createdBy: ADMIN_EMAIL,
      })
      .returning({ id: newsletterIssues.id });
    return rows[0]!.id;
  }

  afterAll(async () => {
    await db.delete(newsletterIssues).where(like(newsletterIssues.subject, `${issueMarker}%`));
  });

  it('returns the keyset page with the issue wire shape', async () => {
    const id = await seedIssue();

    const response = await sendAsFreshActor('/admin/newsletter/issues?limit=100');

    expect(response.status).toBe(200);
    const page = await jsonBody<{ rows: Record<string, unknown>[]; nextCursor: string | null }>(
      response
    );
    const mine = page.rows.find((row) => row['id'] === id);
    expect(mine).toBeDefined();
    expect(Object.keys(mine!).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'canceledAt',
      'createdAt',
      'createdBy',
      'failedCount',
      'id',
      'recipientCount',
      'scheduledAt',
      'sentAt',
      'sentCount',
      'status',
      'subject',
    ]);
    expect(mine!['status']).toBe('scheduled');
    expect(mine!['scheduledAt']).toBe('2999-01-01T00:00:00.000Z');
  });

  it('accepts a cursor and rejects an over-cap limit', async () => {
    const cursorPage = await sendAsFreshActor(
      `/admin/newsletter/issues?cursor=${crypto.randomUUID()}&limit=5`
    );
    expect(cursorPage.status).toBe(200);

    const overCap = await sendAsFreshActor('/admin/newsletter/issues?limit=101');
    expect(overCap.status).toBe(400);
    expect(await overCap.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('GET /admin/newsletter/subscribers (+ /stats)', () => {
  const subscriberMarker = `admin-read-routes-sub-${RUN_ID}`;

  async function seedSubscriber(): Promise<string> {
    const rows = await db
      .insert(newsletterSubscribers)
      .values({
        email: `${subscriberMarker}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`,
        status: 'subscribed',
        unsubscribeToken: crypto.randomUUID(),
        consentSource: 'marketing_site',
        consentIp: '203.0.113.9',
        consentTextVersion: 'v1',
      })
      .returning({ id: newsletterSubscribers.id });
    return rows[0]!.id;
  }

  afterAll(async () => {
    await db
      .delete(newsletterSubscribers)
      .where(like(newsletterSubscribers.email, `${subscriberMarker}%`));
  });

  it('returns the consent-evidence page, honors the status filter, and audits the read', async () => {
    const id = await seedSubscriber();
    const email = `admin-reads-sub-actor-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const env = { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email };
    const token = await mintDevAdminToken(env, { email });
    const response = await createApp().request(
      '/admin/newsletter/subscribers?status=subscribed&limit=100',
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      env
    );

    expect(response.status).toBe(200);
    const page = await jsonBody<{ rows: Record<string, unknown>[]; nextCursor: string | null }>(
      response
    );
    const mine = page.rows.find((row) => row['id'] === id);
    expect(mine).toMatchObject({
      status: 'subscribed',
      consentSource: 'marketing_site',
      consentIp: '203.0.113.9',
      consentTextVersion: 'v1',
    });
    expect(Object.keys(mine!)).not.toContain('unsubscribeToken');
    expect(Object.keys(mine!)).not.toContain('confirmToken');

    const audits = await db
      .select({ action: adminAudit.action })
      .from(adminAudit)
      .where(eq(adminAudit.actor, email));
    expect(audits).toEqual([{ action: 'read.newsletterSubscribers' }]);
  });

  it('rejects an over-cap subscriber page and an unknown status', async () => {
    const overCap = await sendAsFreshActor('/admin/newsletter/subscribers?limit=101');
    expect(overCap.status).toBe(400);
    expect(await overCap.json()).toEqual({ code: 'VALIDATION' });

    const badStatus = await sendAsFreshActor('/admin/newsletter/subscribers?status=nope');
    expect(badStatus.status).toBe(400);
  });

  it('renders the compose preview through the shared issue template', async () => {
    const email = `admin-reads-render-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const env = { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email };
    const token = await mintDevAdminToken(env, { email });
    const response = await createApp().request(
      '/admin/newsletter/render',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          [CF_ACCESS_JWT_HEADER]: token,
        },
        body: JSON.stringify({ subject: 'Launch notes', bodyMarkdown: '## Section\n\nHello' }),
      },
      env
    );

    expect(response.status).toBe(200);
    const { html } = await jsonBody<{ html: string }>(response);
    expect(html).toMatch(/<h2[^>]*>Section<\/h2>/);
    expect(html).toContain('Launch notes');
    // The compliance footer rides the same template the dispatch job renders.
    expect(html).toContain("You're receiving this because you subscribed at hushbox.ai.");
    // Inert unsubscribe: the preview must never mint a live unsubscribe URL.
    expect(html).toContain('href="#"');
    expect(html).not.toContain('/newsletter/unsubscribe');
  });

  it('refuses the render preview without an admin assertion', async () => {
    const response = await send('/admin/newsletter/render', {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { subject: 's', bodyMarkdown: 'b' },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
  });

  it('rejects an invalid render body and a missing idempotency key', async () => {
    const invalid = await send('/admin/newsletter/render', {
      method: 'POST',
      token: await adminToken(),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: { subject: '', bodyMarkdown: 'b' },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ code: 'VALIDATION' });

    // A pure read on a POST still rides the universal key demand (the route
    // declares no exemption class; none fits a wrapperless read).
    const keyless = await send('/admin/newsletter/render', {
      method: 'POST',
      token: await adminToken(),
      body: { subject: 's', bodyMarkdown: 'b' },
    });
    expect(keyless.status).toBe(400);
    expect(await keyless.json()).toEqual({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('serves the aggregate stats shape', async () => {
    await seedSubscriber();

    const response = await sendAsFreshActor('/admin/newsletter/subscribers/stats');

    expect(response.status).toBe(200);
    const stats = await jsonBody<{
      byStatus: Record<string, number>;
      bySuppressReason: Record<string, number>;
    }>(response);
    expect(stats.byStatus['subscribed']).toBeGreaterThanOrEqual(1);
    expect(Object.keys(stats.bySuppressReason).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'bounce',
      'complaint',
    ]);
  });
});

describe('GET /admin/feedback (triage inbox)', () => {
  it('returns the inbox page with the row wire shape and honors the status filter', async () => {
    const id = await seedFeedback('triaged');

    const response = await sendAsFreshActor('/admin/feedback?status=triaged&limit=100');

    expect(response.status).toBe(200);
    const page = await jsonBody<{ rows: Record<string, unknown>[]; nextCursor: string | null }>(
      response
    );
    const mine = page.rows.find((row) => row['id'] === id);
    expect(mine).toBeDefined();
    expect(Object.keys(mine!).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'bodyPreview',
      'createdAt',
      'id',
      'kind',
      'status',
      'userId',
    ]);
    expect(mine!['status']).toBe('triaged');
    expect(String(mine!['bodyPreview']).length).toBeLessThanOrEqual(140);
  });

  it('accepts the status, cursor, and limit filters together', async () => {
    const cursor = crypto.randomUUID();

    const response = await sendAsFreshActor(`/admin/feedback?status=new&cursor=${cursor}&limit=5`);

    expect(response.status).toBe(200);
    const page = await jsonBody<{ rows: unknown[] }>(response);
    expect(Array.isArray(page.rows)).toBe(true);
  });

  it('trips the mounted feedback read rate limit with the standard error shape', async () => {
    await seedFeedback();
    const email = `admin-reads-fbtrip-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const env = { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email };
    const token = await mintDevAdminToken(env, { email });
    const app = createApp();
    const send = async (target: string): Promise<Response> =>
      app.request(target, { headers: { [CF_ACCESS_JWT_HEADER]: token } }, env);

    const first = await send('/admin/feedback');
    const second = await send('/admin/feedback');
    const third = await send('/admin/feedback');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    const body = await jsonBody<{ code: string }>(third);
    expect(body.code).toBe('RATE_LIMITED');
  });
});

describe('GET /admin/feedback/:id (detail)', () => {
  it('returns the full detail and writes exactly one read.feedbackView audit row', async () => {
    const id = await seedFeedback();
    const email = `admin-reads-fb-actor-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const token = await mintDevAdminToken({ ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }, { email });

    const response = await createApp().request(
      `/admin/feedback/${id}`,
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }
    );

    expect(response.status).toBe(200);
    const detail = await jsonBody<{ id: string; body: string }>(response);
    expect(detail.id).toBe(id);
    expect(detail.body).toBe('x'.repeat(200));
    const audits = await db
      .select({
        action: adminAudit.action,
        targetType: adminAudit.targetType,
        targetId: adminAudit.targetId,
      })
      .from(adminAudit)
      .where(eq(adminAudit.actor, email));
    expect(audits).toEqual([
      { action: READ_AUDIT_ACTIONS.feedbackView, targetType: 'feedback', targetId: id },
    ]);
  });

  it('answers 404 for an unknown feedback id', async () => {
    const response = await sendAsFreshActor(`/admin/feedback/${crypto.randomUUID()}`);
    expect(response.status).toBe(404);
  });

  it('rejects a non-uuid id at the boundary', async () => {
    const response = await sendAsFreshActor('/admin/feedback/not-a-uuid');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'VALIDATION' });
  });
});

describe('GET /admin/audit (search + undo threading)', () => {
  it('threads undoes/undone-by across an executed op and its undo', async () => {
    const targetId = crypto.randomUUID();
    const token = await adminToken();
    const mark = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token,
      body: { input: { targetId, amountNanoUsd: '500', reason: 'thread test' } },
      headers: { 'Idempotency-Key': `admin-reads-key-${RUN_ID}-mark-${targetId.slice(0, 8)}` },
    });
    expect(mark.status).toBe(200);
    const { auditId } = await jsonBody<{ auditId: string }>(mark);
    const undo = await send('/admin/ops/fixture.unmark/execute', {
      method: 'POST',
      token,
      body: {
        input: { targetId, amountNanoUsd: '500', reason: 'thread test undo' },
        undoes: auditId,
      },
      headers: { 'Idempotency-Key': `admin-reads-key-${RUN_ID}-undo-${targetId.slice(0, 8)}` },
    });
    expect(undo.status).toBe(200);
    const { auditId: undoId } = await jsonBody<{ auditId: string }>(undo);

    const search = await send(`/admin/audit?targetType=fixture&targetId=${targetId}&limit=10`, {
      token,
    });
    expect(search.status).toBe(200);
    const page = await jsonBody<{
      rows: { id: string; undoes: string | null; undoneBy: string | null }[];
    }>(search);
    const executedRow = page.rows.find((row) => row.id === auditId);
    const undoRow = page.rows.find((row) => row.id === undoId);
    expect(executedRow).toMatchObject({ undoes: null, undoneBy: undoId });
    expect(undoRow).toMatchObject({ undoes: auditId, undoneBy: null });
  });
});

describe('GET /admin/audit full filter surface', () => {
  it('accepts every filter parameter together', async () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const cursor = crypto.randomUUID();
    const response = await send(
      `/admin/audit?actor=${encodeURIComponent(ADMIN_EMAIL)}&action=fixture.mark` +
        `&targetType=fixture&targetId=none&from=${encodeURIComponent(from)}` +
        `&to=${encodeURIComponent(to)}&limit=5&cursor=${cursor}`,
      { token: await adminToken() }
    );

    expect(response.status).toBe(200);
    const page = await jsonBody<{ rows: unknown[]; nextCursor: string | null }>(response);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('GET /admin/jobs full filter surface', () => {
  it('accepts type, cursor, and limit together', async () => {
    const cursor = crypto.randomUUID();
    const response = await send(
      `/admin/jobs?status=discarded&type=never-registered.v1&limit=5&cursor=${cursor}`,
      { token: await adminToken() }
    );

    expect(response.status).toBe(200);
    const page = await jsonBody<{ rows: unknown[] }>(response);
    expect(page.rows).toEqual([]);
  });
});

describe('GET /admin/sql (the SELECT-only panel)', () => {
  it('runs a SELECT and audits the query text', async () => {
    const email = `admin-reads-sql-actor-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const token = await mintDevAdminToken({ ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }, { email });
    const response = await createApp().request(
      `/admin/sql?query=${encodeURIComponent('SELECT 41 + 1 AS answer')}`,
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      rows: [{ answer: 42 }],
      rowCount: 1,
      truncated: false,
    });
    const audits = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(and(eq(adminAudit.actor, email), eq(adminAudit.action, READ_AUDIT_ACTIONS.sqlPanel)));
    expect(audits).toEqual([{ details: { query: 'SELECT 41 + 1 AS answer' } }]);
  });

  it('refuses a write through the role with 403 and still audits it', async () => {
    const email = `admin-reads-sqlw-actor-${RUN_ID}-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;
    const token = await mintDevAdminToken({ ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }, { email });
    const query = 'DELETE FROM jobs';
    const response = await createApp().request(
      `/admin/sql?query=${encodeURIComponent(query)}`,
      { headers: { [CF_ACCESS_JWT_HEADER]: token } },
      { ...testEnv, ADMIN_ACTOR_ALLOWLIST: email }
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'FORBIDDEN' });
    const audits = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(and(eq(adminAudit.actor, email), eq(adminAudit.action, READ_AUDIT_ACTIONS.sqlPanel)));
    expect(audits).toEqual([{ details: { query } }]);
  });
});

describe('read routes surface domain errors', () => {
  function brokenApp(): Hono<AppEnv> {
    const manifest = createAdminManifest({
      listOps: () => registry.list(),
      prefill: () => null,
      engine: (requestDb, telemetry) =>
        createAdminOpEngine({
          db: requestDb,
          registry,
          stores,
          telemetry,
          opDeps: fixtureDeps,
          executorId: `admin-reads-broken-reads-${RUN_ID}`,
        }),
      reads: () => {
        const down = (): Promise<Result<never, DomainError>> =>
          Promise.resolve(err(unavailableError('reads are down')));
        return {
          customer360: down,
          auditSearch: down,
          dashboard: down,
          jobQueue: down,
          feedbackInbox: down,
          feedbackDetail: down,
          newsletterIssues: down,
          newsletterSubscriberStats: down,
          newsletterSubscribers: down,
          renderIssue: down,
          modelsCatalog: down,
          sqlPanel: down,
        };
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it.each([
    '/admin/dashboard',
    '/admin/jobs',
    '/admin/feedback',
    '/admin/models',
    '/admin/newsletter/issues',
    '/admin/newsletter/subscribers',
    '/admin/newsletter/subscribers/stats',
    '/admin/audit',
    '/admin/sql?query=SELECT%201',
  ])('%s maps a failed read surface to 503', async (path) => {
    const response = await brokenApp().request(
      path,
      { headers: { [CF_ACCESS_JWT_HEADER]: await adminToken() } },
      testEnv
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('GET /admin/dashboard and /admin/jobs', () => {
  it('returns the ops summary', async () => {
    const response = await send('/admin/dashboard', { token: await adminToken() });
    expect(response.status).toBe(200);
    const body = await jsonBody<{ jobs: Record<string, number>; recentActions: unknown[] }>(
      response
    );
    expect(Object.keys(body.jobs).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'dead',
      'discarded',
      'pending',
      'running',
    ]);
    expect(Array.isArray(body.recentActions)).toBe(true);
  });

  it('lists the job queue with a status filter', async () => {
    const response = await send('/admin/jobs?status=dead&limit=5', {
      token: await adminToken(),
    });
    expect(response.status).toBe(200);
    const body = await jsonBody<{ rows: { status: string; discarded: boolean }[] }>(response);
    for (const row of body.rows) {
      expect(row.status).toBe('dead');
      expect(row.discarded).toBe(false);
    }
  });
});

describe('GET /admin/models', () => {
  const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  const MODEL_PREFIX = `adm-reads-models-${RUN_ID}`;
  const DISABLED_AT = new Date('2026-07-13T12:00:00.000Z');
  const seededModelIds: string[] = [];

  // Serialize catalog critical sections against the other model_catalog
  // suites (this read is whole-table); held per test via the crash-safe
  // Redis TTL lock convention.
  let releaseModelCatalogLock: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    releaseModelCatalogLock = await acquireModelCatalogLock(redis);
  });
  afterEach(async () => {
    const release = releaseModelCatalogLock;
    releaseModelCatalogLock = undefined;
    await release?.();
  });

  afterAll(async () => {
    if (seededModelIds.length > 0) {
      await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, seededModelIds));
    }
  });

  /** Persisted wire-form descriptor (the shape the refresh upsert stores). */
  function wireDescriptor(modelId: string, overrides: Record<string, unknown> = {}): unknown {
    return {
      id: modelId,
      provider: 'admin-reads-test',
      version: '1',
      inputs: ['text'],
      outputs: ['text'],
      parameters: {},
      behaviors: ['streaming'],
      limits: {},
      pricing: { inputPerToken: '2500' },
      zdrReachable: true,
      name: 'Admin Reads Model',
      releasedAt: 1_700_000_000,
      fetchedAt: 1_700_000_000_000,
      ...overrides,
    };
  }

  async function seedModel(
    modelId: string,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    seededModelIds.push(modelId);
    await db.insert(modelCatalog).values({
      modelId,
      descriptor: wireDescriptor(modelId, overrides),
    });
    return modelId;
  }

  interface ModelsBody {
    models: Record<string, unknown>[];
    truncated: boolean;
  }

  it('lists the catalog including disabled and unexposed models, slim and ordered', async () => {
    // Per-attempt unique ids so a vitest retry never collides with the
    // previous attempt's committed seeds.
    const prefix = `${MODEL_PREFIX}-${crypto.randomUUID().slice(0, 8)}`;
    const disabled = await seedModel(`${prefix}/a-disabled`);
    const enabled = await seedModel(`${prefix}/b-enabled`);
    const hidden = await seedModel(`${prefix}/c-hidden`, { zdrReachable: false });
    const disableOutcome = await disableModelWithinTx(db, disabled, DISABLED_AT);
    expect(disableOutcome._unsafeUnwrap()).toBe('disabled');

    const response = await send('/admin/models', { token: await adminToken() });

    expect(response.status).toBe(200);
    const body = await jsonBody<ModelsBody>(response);
    const mine = body.models.filter((model) => String(model['modelId']).startsWith(prefix));
    // Deterministic model-id order; the ZDR-unreachable model (hidden from
    // the product read) and the kill-switched model are both present.
    expect(mine.map((model) => model['modelId'])).toEqual([disabled, enabled, hidden]);
    expect(mine[0]?.['adminDisabledAt']).toBe(DISABLED_AT.toISOString());
    expect(mine[1]?.['adminDisabledAt']).toBeNull();
    expect(mine[2]?.['adminDisabledAt']).toBeNull();
    expect(mine[2]?.['zdrReachable']).toBe(false);
    expect(body.truncated).toBe(false);
    // The slim projection only — never the descriptor jsonb dump.
    for (const model of mine) {
      expect(Object.keys(model).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'adminDisabledAt',
        'family',
        'modelId',
        'name',
        'zdrReachable',
      ]);
      expect(model['name']).toBe('Admin Reads Model');
      expect(model['family']).toBe('language');
    }
  });
});
