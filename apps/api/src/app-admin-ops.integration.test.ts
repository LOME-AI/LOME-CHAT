import { Redis } from '@upstash/redis';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LOCAL_NEON_DEV_CONFIG,
  adminAudit,
  createDb,
  idempotencyKeys,
  ledgerEntries,
  modelCatalog,
  users,
  wallets,
} from '@hushbox/db';
import { userFactory, walletFactory } from '@hushbox/db/factories';
import { Mode, envConfig } from '@hushbox/shared';
import { createApp } from './app.js';
import { IDEMPOTENCY_KEY_HEADER } from './lib/idempotency/index.js';
import { CF_ACCESS_JWT_HEADER, mintDevAdminToken } from './middleware/pipeline-admin.js';
import { BILLING_KEYS } from './slices/billing/domain/keys.js';
import { acquireModelCatalogLock } from './slices/models/__tests__/model-catalog-lock.js';
import type { Bindings } from './lib/context/index.js';
import type { TelemetryEnv } from './lib/telemetry/index.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`admin ops mount tests: missing ${name}. Run via the package test script.`);
  }
  return value;
}

const DATABASE_URL = requiredEnv('DATABASE_URL');
const UPSTASH_REDIS_REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const UPSTASH_REDIS_REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');

const ADMIN_EMAIL = `admin-ops-mount-${crypto.randomUUID().slice(0, 8)}@hushbox.test`;

const ADMIN_ORIGIN = 'http://localhost:7000';

const devEnv: Bindings & TelemetryEnv & { ADMIN_URL: string } = {
  NODE_ENV: 'development',
  ADMIN_URL: ADMIN_ORIGIN,
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: 'secret-at-least-32-characters-long!!',
  TELEMETRY_SINKS: 'console',
  CF_ACCESS_TEAM_DOMAIN: 'hushbox-dev',
  CF_ACCESS_AUD: 'dev-admin-access-aud',
  ADMIN_ACTOR_ALLOWLIST: ADMIN_EMAIL,
  CF_ACCESS_DEV_PRIVATE_JWK: envConfig.CF_ACCESS_DEV_PRIVATE_JWK[Mode.Development],
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const app = createApp();

const EXPECTED_OP_NAMES = [
  'job.discard',
  'job.redrive',
  'job.restore',
  'model.disable',
  'model.enable',
  'sessions.revokeAll',
  'share.revoke',
  'share.unrevoke',
  'user.lock',
  'user.unlock',
  'wallet.clawback',
  'wallet.credit',
] as const;

const mintedIdempotencyKeys: string[] = [];
const snapshotWalletIds: string[] = [];
const insertedModelIds: string[] = [];
let releaseCatalogLock: (() => Promise<void>) | undefined;

beforeAll(async () => {
  // Model ops mutate real `model_catalog` rows; the cross-suite lock keeps the
  // catalog-clearing suites from racing these inserts in either direction.
  releaseCatalogLock = await acquireModelCatalogLock(redis);
}, 20_000);

afterAll(async () => {
  // admin_audit is append-only by trigger — audit rows stay (actor-isolated);
  // ledger/wallet rows stay too (balanced, uuid-isolated). Only the engine-claim
  // key rows, seeded catalog rows, and Redis snapshot keys are removed.
  for (const key of mintedIdempotencyKeys) {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  }
  for (const modelId of insertedModelIds) {
    await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
  }
  for (const walletId of snapshotWalletIds) {
    await redis.del(BILLING_KEYS.walletSnapshot.buildKey(walletId));
  }
  await releaseCatalogLock?.();
});

async function adminToken(): Promise<string> {
  return mintDevAdminToken(devEnv, { email: ADMIN_EMAIL });
}

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function postOp(
  name: string,
  mode: 'preview' | 'execute',
  body: Record<string, unknown>,
  idempotencyKey?: string
): Promise<Response> {
  const token = await adminToken();
  if (idempotencyKey !== undefined) mintedIdempotencyKeys.push(idempotencyKey);
  return app.request(
    `/admin/ops/${name}/${mode}`,
    {
      method: 'POST',
      headers: {
        [CF_ACCESS_JWT_HEADER]: token,
        'Content-Type': 'application/json',
        ...(idempotencyKey === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey }),
      },
      body: JSON.stringify(body),
    },
    devEnv
  );
}

async function walletBalance(walletId: string): Promise<bigint> {
  const rows = await db
    .select({ balanceNanoUsd: wallets.balanceNanoUsd })
    .from(wallets)
    .where(eq(wallets.id, walletId));
  const balance = rows[0]?.balanceNanoUsd;
  if (balance === undefined) throw new Error('admin ops mount tests: wallet row is gone');
  return balance;
}

async function auditRowCount(): Promise<number> {
  const rows = await db
    .select({ id: adminAudit.id })
    .from(adminAudit)
    .where(eq(adminAudit.actor, ADMIN_EMAIL));
  return rows.length;
}

async function walletLegCount(walletId: string): Promise<number> {
  const rows = await db
    .select({ id: ledgerEntries.id })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.walletId, walletId));
  return rows.length;
}

describe('composed app: admin ops surface', () => {
  it('lists all twelve registered op contracts on GET /admin/ops', async () => {
    const token = await adminToken();
    const res = await app.request(
      '/admin/ops',
      { method: 'GET', headers: { [CF_ACCESS_JWT_HEADER]: token } },
      devEnv
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ ops: { name: string }[] }>(res);
    expect(body.ops.map((op) => op.name)).toEqual([...EXPECTED_OP_NAMES]);
  });

  it('runs the wallet.credit money flow: preview commits nothing, execute commits once, replay does not double-apply, undo nets to zero', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
    if (user === undefined) throw new Error('admin ops mount tests: user insert returned no row');
    const [wallet] = await db
      .insert(wallets)
      .values(walletFactory.build({ userId: user.id }))
      .returning({ id: wallets.id });
    if (wallet === undefined) {
      throw new Error('admin ops mount tests: wallet insert returned no row');
    }
    snapshotWalletIds.push(wallet.id);
    const startingBalance = await walletBalance(wallet.id);
    const amount = 5_000_000_000n;
    const input = {
      walletId: wallet.id,
      amountNanoUsd: amount.toString(10),
      reason: 'admin ops mount test credit',
    };

    // Preview returns effects and commits NOTHING.
    const preview = await postOp('wallet.credit', 'preview', { input });
    expect(preview.status).toBe(200);
    const previewBody = await jsonBody<{ effects: unknown[] }>(preview);
    expect(previewBody.effects.length).toBeGreaterThan(0);
    expect(await walletBalance(wallet.id)).toBe(startingBalance);
    expect(await walletLegCount(wallet.id)).toBe(0);
    expect(await auditRowCount()).toBe(0);

    // Execute commits effect + audit row exactly once.
    const executeKey = crypto.randomUUID();
    const execute = await postOp('wallet.credit', 'execute', { input }, executeKey);
    expect(execute.status).toBe(200);
    const executed = await jsonBody<{
      auditId: string;
      inverseInput: Record<string, unknown>;
    }>(execute);
    expect(await walletBalance(wallet.id)).toBe(startingBalance + amount);
    expect(await walletLegCount(wallet.id)).toBe(1);
    expect(await auditRowCount()).toBe(1);

    // A replayed execute under the same Idempotency-Key does not double-apply.
    const replay = await postOp('wallet.credit', 'execute', { input }, executeKey);
    expect(replay.status).toBe(200);
    const replayed = await jsonBody<{ auditId: string }>(replay);
    expect(replayed.auditId).toBe(executed.auditId);
    expect(await walletBalance(wallet.id)).toBe(startingBalance + amount);
    expect(await walletLegCount(wallet.id)).toBe(1);
    expect(await auditRowCount()).toBe(1);

    // Undo = executing the registered inverse with `undoes` nets the balance back.
    const undo = await postOp(
      'wallet.clawback',
      'execute',
      { input: executed.inverseInput, undoes: executed.auditId },
      crypto.randomUUID()
    );
    expect(undo.status).toBe(200);
    expect(await walletBalance(wallet.id)).toBe(startingBalance);
    expect(await walletLegCount(wallet.id)).toBe(2);
    expect(await auditRowCount()).toBe(2);
  });

  it('admits an admin mutation carrying the admin SPA Origin through CSRF', async () => {
    const [user] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
    if (user === undefined) throw new Error('admin ops mount tests: user insert returned no row');
    const [wallet] = await db
      .insert(wallets)
      .values(walletFactory.build({ userId: user.id }))
      .returning({ id: wallets.id });
    if (wallet === undefined) {
      throw new Error('admin ops mount tests: wallet insert returned no row');
    }
    snapshotWalletIds.push(wallet.id);
    const token = await adminToken();
    const input = {
      walletId: wallet.id,
      amountNanoUsd: '1000000000',
      reason: 'admin origin CSRF test',
    };

    const res = await app.request(
      '/admin/ops/wallet.credit/preview',
      {
        method: 'POST',
        headers: {
          [CF_ACCESS_JWT_HEADER]: token,
          'Content-Type': 'application/json',
          Origin: ADMIN_ORIGIN,
        },
        body: JSON.stringify({ input }),
      },
      devEnv
    );
    expect(res.status).toBe(200);
  });

  it('rejects an admin mutation from a foreign Origin with CSRF_REJECTED even with a valid JWT', async () => {
    const token = await adminToken();
    const res = await app.request(
      '/admin/ops/wallet.credit/preview',
      {
        method: 'POST',
        headers: {
          [CF_ACCESS_JWT_HEADER]: token,
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ input: {} }),
      },
      devEnv
    );
    expect(res.status).toBe(403);
    const body = await jsonBody<{ code: string }>(res);
    expect(body.code).toBe('CSRF_REJECTED');
  });

  it('serves the same op catalog at the production /api-prefixed admin path', async () => {
    const token = await adminToken();
    const res = await app.request(
      '/api/admin/ops',
      { method: 'GET', headers: { [CF_ACCESS_JWT_HEADER]: token } },
      devEnv
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<{ ops: { name: string }[] }>(res);
    expect(body.ops.map((op) => op.name)).toEqual([...EXPECTED_OP_NAMES]);
  });

  it('routes the /api-prefixed admin alias through the fail-closed admin pipeline', async () => {
    const res = await app.request('/api/admin/ops', { method: 'GET' }, devEnv);
    expect(res.status).toBe(401);
  });

  it('does not rewrite non-admin /api paths', async () => {
    const res = await app.request('/api/health', { method: 'GET' }, devEnv);
    expect(res.status).toBe(404);
    const direct = await app.request('/health', { method: 'GET' }, devEnv);
    expect(direct.status).toBe(200);
  });

  it('runs a non-money op pair over HTTP: model.disable sets the kill switch and model.enable clears it', async () => {
    const modelId = `admin-ops-mount-test/${crypto.randomUUID()}`;
    insertedModelIds.push(modelId);
    await db.insert(modelCatalog).values({ modelId, descriptor: { id: modelId } });

    const disabledAt = async (): Promise<Date | null> => {
      const rows = await db
        .select({ adminDisabledAt: modelCatalog.adminDisabledAt })
        .from(modelCatalog)
        .where(eq(modelCatalog.modelId, modelId));
      const row = rows[0];
      if (row === undefined) throw new Error('admin ops mount tests: model row is gone');
      return row.adminDisabledAt;
    };

    const disable = await postOp(
      'model.disable',
      'execute',
      { input: { modelId, reason: 'admin ops mount test disable' } },
      crypto.randomUUID()
    );
    expect(disable.status).toBe(200);
    expect(await disabledAt()).not.toBeNull();

    const enable = await postOp(
      'model.enable',
      'execute',
      { input: { modelId, reason: 'admin ops mount test enable' } },
      crypto.randomUUID()
    );
    expect(enable.status).toBe(200);
    expect(await disabledAt()).toBeNull();
  });
});
