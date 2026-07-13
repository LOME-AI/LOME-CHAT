import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog, users, wallets } from '@hushbox/db';
import { createBillingStores } from '../../billing/index.js';
import { withModelCatalogLock } from '../../models/__tests__/model-catalog-lock.js';
import { buildSmartModelTurnDefinition } from './smart-model-turn.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for smart-model-turn integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([4, 4, 4]);
// Smart Model candidate derivation reads the WHOLE catalog (affordability +
// premium-quartile scan), so a concurrent suite's whole-table catalog wipe
// (`withDearTrialCatalog`, platform/dev) can empty it between this suite's seed
// and read. The `chat-route` prefix only survives the chat route suite's
// *foreign-row* isolation delete — not those whole-table wipes — so seed + build
// run under the shared catalog lock, guaranteeing the model is present at read.
const MODEL = `chat-route-smart/${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL]));
  await db.$client.end();
});

async function seedModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        zdrReachable: true,
        releasedAt: 1_600_000_000,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

async function seedRichUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@smart-turn.test`,
      username: `sm${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  // A large purchased balance keeps every exposed text model affordable, so a
  // candidate is always derivable regardless of concurrent catalog rows.
  await db
    .insert(wallets)
    .values({ userId: id, type: 'purchased', balanceNanoUsd: 1_000_000_000_000n });
  return id;
}

describe('buildSmartModelTurnDefinition without a budget', () => {
  it('builds an uncapped answer node (the omitted-budget defensive path)', async () => {
    const userId = await seedRichUser();
    // Seed and derive under the catalog lock: candidate derivation scans the
    // whole catalog, so a concurrent whole-table wipe must not race the read.
    const build = await withModelCatalogLock(redis, async () => {
      await seedModel();
      return buildSmartModelTurnDefinition(
        { db, telemetry: silentTelemetry, billing: createBillingStores() },
        { userId, now: new Date() }
      );
    });
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    // No budget → no derived ceiling → the answer call keeps the model default,
    // so the node carries the schema's empty params default.
    expect(node?.type === 'smartModel' && node.params).toEqual({});
  });
});
