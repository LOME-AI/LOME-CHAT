import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  modelCatalog,
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

function createApp(): Hono<AppEnv> {
  const manifest = createAdminManifest({
    listOps: () => registry.list(),
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
    '/admin/models',
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
    '/admin/models',
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
