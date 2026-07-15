import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, idempotencyKeys } from '@hushbox/db';
import { and, eq, like } from 'drizzle-orm';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, describe, expect, it } from 'vitest';
import { Mode, envConfig } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import {
  CF_ACCESS_JWT_HEADER,
  accessIssuer,
  mintDevAdminToken,
} from '../../middleware/pipeline-admin.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { createAdminOpEngine } from './domain/engine.js';
import { FIXTURE_AMOUNT_CAP_NANO_USD, createAdminFixtureRegistry } from './domain/fixture-ops.js';
import { createAdminStores } from './adapters/stores.js';
import { createAdminManifest } from './routes.js';
import type { DbTransaction } from '../../lib/idempotency/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { AdminFixtureDeps, AdminFixtureScratch } from './domain/fixture-ops.js';

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin route integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per run: audit rows are append-only (actor-isolated forever). */
const RUN_ID = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const ADMIN_EMAIL = `admin-routes-run-${RUN_ID}@hushbox.test`;
const SECOND_ADMIN_EMAIL = `admin-routes-second-${RUN_ID}@hushbox.test`;
const SCRATCH_ROUTE = `/admin-routes-fixture/${RUN_ID}`;

const TEAM_DOMAIN = 'hushbox-dev';
const AUDIENCE = 'dev-admin-access-aud';
const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
  CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
  CF_ACCESS_AUD: AUDIENCE,
  ADMIN_ACTOR_ALLOWLIST: `${ADMIN_EMAIL},${SECOND_ADMIN_EMAIL}`,
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
};

/** Durable scratch effect: one idempotency_keys row per marked target (the
 * same observable-scratch trick the engine's own integration tests use). */
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

function createApp(): Hono<AppEnv> {
  const manifest = createAdminManifest({
    listOps: () => registry.list(),
    // This suite exercises the ops routes only; the read surface has its own
    // integration file (routes-reads).
    reads: () => {
      throw new Error('admin reads are not under test in this suite');
    },
    engine: (requestDb, telemetry) =>
      createAdminOpEngine({
        db: requestDb,
        registry,
        stores,
        telemetry,
        opDeps: fixtureDeps,
        executorId: `admin-routes-routes-${RUN_ID}`,
      }),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function adminToken(): Promise<string> {
  return mintDevAdminToken(testEnv, { email: ADMIN_EMAIL });
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

function markBody(targetId: string): { input: Record<string, unknown> } {
  return {
    input: { targetId, amountNanoUsd: '500', reason: 'integration battery' },
  };
}

async function auditRowsFor(targetId: string): Promise<{ action: string; actor: string }[]> {
  return db
    .select({ action: adminAudit.action, actor: adminAudit.actor })
    .from(adminAudit)
    .where(eq(adminAudit.targetId, targetId));
}

async function scratchMarked(targetId: string): Promise<boolean> {
  const rows = await db
    .select({ id: idempotencyKeys.id })
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.route, SCRATCH_ROUTE), eq(idempotencyKeys.key, targetId)));
  return rows.length > 0;
}

async function expectZeroEffect(targetId: string): Promise<void> {
  expect(await auditRowsFor(targetId)).toEqual([]);
  expect(await scratchMarked(targetId)).toBe(false);
}

afterAll(async () => {
  // admin_audit is append-only by trigger — rows stay, actor-isolated by the
  // per-run allowlisted email. Scratch + engine key rows are reclaimable.
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.route, SCRATCH_ROUTE));
  await db
    .delete(idempotencyKeys)
    .where(
      and(
        like(idempotencyKeys.route, 'admin/ops/fixture.%'),
        like(idempotencyKeys.key, `admin-routes-key-${RUN_ID}%`)
      )
    );
});

describe('admin routes: authz denial battery (zero effect on every refusal)', () => {
  it('refuses an execute with no assertion', async () => {
    const targetId = crypto.randomUUID();
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-no-jwt` },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED' });
    await expectZeroEffect(targetId);
  });

  it('refuses a token signed by a foreign key (invalid signature)', async () => {
    const targetId = crypto.randomUUID();
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const nowSeconds = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ email: ADMIN_EMAIL })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'hushbox-dev-admin' })
      .setIssuer(accessIssuer(TEAM_DOMAIN))
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 600)
      .sign(privateKey);
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token: forged,
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-forged` },
    });
    expect(response.status).toBe(401);
    await expectZeroEffect(targetId);
  });

  it('refuses a wrong-audience token', async () => {
    const targetId = crypto.randomUUID();
    const token = await mintDevAdminToken(testEnv, {
      email: ADMIN_EMAIL,
      audience: 'some-other-app',
    });
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token,
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-aud` },
    });
    expect(response.status).toBe(401);
    await expectZeroEffect(targetId);
  });

  it('refuses a wrong-issuer token', async () => {
    const targetId = crypto.randomUUID();
    const token = await mintDevAdminToken(testEnv, {
      email: ADMIN_EMAIL,
      issuer: 'https://not-our-team.cloudflareaccess.com',
    });
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token,
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-iss` },
    });
    expect(response.status).toBe(401);
    await expectZeroEffect(targetId);
  });

  it('refuses an expired token', async () => {
    const targetId = crypto.randomUUID();
    const token = await mintDevAdminToken(testEnv, {
      email: ADMIN_EMAIL,
      expiresInSeconds: -60,
    });
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token,
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-exp` },
    });
    expect(response.status).toBe(401);
    await expectZeroEffect(targetId);
  });

  it('refuses a non-allowlisted email', async () => {
    const targetId = crypto.randomUUID();
    const token = await mintDevAdminToken(testEnv, { email: `stranger-${RUN_ID}@hushbox.test` });
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token,
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-email` },
    });
    expect(response.status).toBe(401);
    await expectZeroEffect(targetId);
  });

  it('refuses a full product session presenting no assertion (a session is not an admin)', async () => {
    const targetId = crypto.randomUUID();
    const sealed = await sealData(
      {
        userId: crypto.randomUUID(),
        sessionId: 'session-1',
        createdAt: Date.now() - 1000,
        pending2FA: false,
        pending2FAExpiresAt: 0,
      },
      { password: SECRET }
    );
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      body: markBody(targetId),
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${sealed}`,
        'Idempotency-Key': `admin-routes-key-${RUN_ID}-cookie`,
      },
    });
    expect(response.status).toBe(401);
    await expectZeroEffect(targetId);
  });
});

describe('admin routes: GET /admin/ops (the catalog)', () => {
  it('requires an admin assertion', async () => {
    const response = await send('/admin/ops');
    expect(response.status).toBe(401);
  });

  it('lists every registered contract with fields, effect class, and inverse', async () => {
    const response = await send('/admin/ops', { token: await adminToken() });
    expect(response.status).toBe(200);
    const body = await jsonBody<{ ops: Record<string, unknown>[] }>(response);
    expect(body.ops.map((op) => op['name'])).toEqual([
      'fixture.mark',
      'fixture.ping',
      'fixture.unmark',
    ]);
    expect(body.ops[0]).toEqual({
      name: 'fixture.mark',
      title: 'Mark fixture target',
      kind: 'mutation',
      effectClass: 'durable',
      inverse: 'fixture.unmark',
      fields: ['targetId', 'amountNanoUsd', 'reason'],
      guardrails: { maxAmountNanoUsd: FIXTURE_AMOUNT_CAP_NANO_USD.toString() },
    });
    expect(body.ops[1]).toEqual({
      name: 'fixture.ping',
      title: 'Ping fixture target',
      kind: 'mutation',
      effectClass: 'ephemeral',
      inverse: null,
      fields: ['targetId', 'reason'],
    });
  });
});

describe('admin routes: POST /admin/ops/:name/preview', () => {
  it('returns the effect diff and commits nothing', async () => {
    const targetId = crypto.randomUUID();
    const response = await send('/admin/ops/fixture.mark/preview', {
      method: 'POST',
      token: await adminToken(),
      body: markBody(targetId),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      effects: [{ label: 'fixture.marked', before: null, after: targetId }],
      inverseInput: {
        targetId,
        amountNanoUsd: '500',
        reason: `undo of fixture.mark on ${targetId}`,
      },
    });
    await expectZeroEffect(targetId);
  });

  it('answers 404 for an unregistered op name', async () => {
    const response = await send('/admin/ops/no.such-op/preview', {
      method: 'POST',
      token: await adminToken(),
      body: markBody(crypto.randomUUID()),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('rejects a malformed body at the boundary', async () => {
    const response = await send('/admin/ops/fixture.mark/preview', {
      method: 'POST',
      token: await adminToken(),
      body: { notInput: true },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'VALIDATION' });
  });

  it('surfaces an over-cap guardrail refusal without committing', async () => {
    const targetId = crypto.randomUUID();
    const response = await send('/admin/ops/fixture.mark/preview', {
      method: 'POST',
      token: await adminToken(),
      body: {
        input: {
          targetId,
          amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
          reason: 'over cap',
        },
      },
    });
    expect(response.status).toBe(403);
    await expectZeroEffect(targetId);
  });
});

describe('admin routes: POST /admin/ops/:name/execute', () => {
  it('rejects an execute with no Idempotency-Key (the engine gate), zero effect', async () => {
    const targetId = crypto.randomUUID();
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token: await adminToken(),
      body: markBody(targetId),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'VALIDATION' });
    await expectZeroEffect(targetId);
  });

  it('answers 404 for an unregistered op name', async () => {
    const response = await send('/admin/ops/no.such-op/execute', {
      method: 'POST',
      token: await adminToken(),
      body: markBody(crypto.randomUUID()),
      headers: { 'Idempotency-Key': `unregistered-op-${RUN_ID}` },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND' });
  });

  it('commits the op, returns the audit id, and replays on the same key', async () => {
    const targetId = crypto.randomUUID();
    const key = `admin-routes-key-${RUN_ID}-commit`;
    const first = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token: await adminToken(),
      body: markBody(targetId),
      headers: { 'Idempotency-Key': key },
    });
    expect(first.status).toBe(200);
    const firstBody = await jsonBody<{ auditId: string; effects: unknown[] }>(first);
    expect(firstBody.auditId).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstBody.effects).toEqual([{ label: 'fixture.marked', before: null, after: targetId }]);
    expect(await scratchMarked(targetId)).toBe(true);
    const audits = await auditRowsFor(targetId);
    expect(audits).toEqual([{ action: 'fixture.mark', actor: ADMIN_EMAIL }]);

    const replay = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token: await adminToken(),
      body: markBody(targetId),
      headers: { 'Idempotency-Key': key },
    });
    expect(replay.status).toBe(200);
    const replayBody = await jsonBody<{ auditId: string }>(replay);
    expect(replayBody.auditId).toBe(firstBody.auditId);
    expect(await auditRowsFor(targetId)).toHaveLength(1);
  });

  it('threads `undoes` through to the exactly-once undo claim', async () => {
    const targetId = crypto.randomUUID();
    const mark = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token: await adminToken(),
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-undo-mark` },
    });
    expect(mark.status).toBe(200);
    const { auditId } = await jsonBody<{ auditId: string }>(mark);

    const undo = await send('/admin/ops/fixture.unmark/execute', {
      method: 'POST',
      token: await adminToken(),
      body: { ...markBody(targetId), undoes: auditId },
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-undo-1` },
    });
    expect(undo.status).toBe(200);
    expect(await scratchMarked(targetId)).toBe(false);

    const secondUndo = await send('/admin/ops/fixture.unmark/execute', {
      method: 'POST',
      token: await adminToken(),
      body: { ...markBody(targetId), undoes: auditId },
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-undo-2` },
    });
    expect(secondUndo.status).toBe(409);
    expect(await secondUndo.json()).toEqual({ code: 'CONFLICT' });
  });

  it('audits the actor from the verified assertion, not from any client field', async () => {
    const targetId = crypto.randomUUID();
    const token = await mintDevAdminToken(testEnv, { email: SECOND_ADMIN_EMAIL });
    const response = await send('/admin/ops/fixture.mark/execute', {
      method: 'POST',
      token,
      body: markBody(targetId),
      headers: { 'Idempotency-Key': `admin-routes-key-${RUN_ID}-actor` },
    });
    expect(response.status).toBe(200);
    expect(await auditRowsFor(targetId)).toEqual([
      { action: 'fixture.mark', actor: SECOND_ADMIN_EMAIL },
    ]);
  });
});
