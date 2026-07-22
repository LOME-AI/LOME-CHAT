import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog, users, wallets } from '@hushbox/db';
import { DAILY_ALLOWANCE_NANO_USD, createBillingStores } from '../../billing/index.js';
import { withModelCatalogLock } from '../../models/__tests__/model-catalog-lock.js';
import { createEstimateRun, listDescriptors, snapshotResolver } from '../../models/index.js';
import {
  buildSmartModelTurnDefinition,
  buildTrialSmartModelTurnDefinition,
} from './smart-model-turn.js';
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
const REASONING_MODEL = `chat-route-smart/${crypto.randomUUID().slice(0, 8)}`;
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
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL, REASONING_MODEL]));
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

/** A trial-eligible reasoning-capable text model (effort-native full ladder). */
async function seedReasoningModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: REASONING_MODEL,
      descriptor: {
        id: REASONING_MODEL,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: ['streaming'],
        limits: { contextLength: 128_000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        reasoning: { supportedEfforts: null },
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

async function seedBrokeUser(): Promise<string> {
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
  // Zero purchased balance: the group-member / free-tier shape whose spend is
  // funded by the budget's effective funding, not their own wallet.
  await db.insert(wallets).values({ userId: id, type: 'purchased', balanceNanoUsd: 0n });
  return id;
}

describe('buildSmartModelTurnDefinition with a budget', () => {
  it('filters candidates by the effective turn funding, not the sender wallet', async () => {
    const userId = await seedBrokeUser();
    const build = await withModelCatalogLock(redis, async () => {
      await db.delete(modelCatalog);
      await seedModel();
      return buildSmartModelTurnDefinition(
        { db, telemetry: silentTelemetry, billing: createBillingStores() },
        {
          userId,
          now: new Date(),
          budget: {
            promptCharacterCount: 400,
            // $5 of effective funding (owner-funded / free-allowance turn):
            // ample for the seeded model even though the sender holds $0.
            funding: { remainingNanoUsd: 5_000_000_000n, kind: 'purchased' },
          },
        }
      );
    });
    const value = build._unsafeUnwrap();
    expect(value.buildable).toBe(true);
  });
});

describe('free-tier Smart worst-case admission ceiling (enforcement rung)', () => {
  // Rung-3 money contract: a free-tier default (Smart Model) turn, built through
  // the REAL build path over the REAL catalog and priced by the REAL estimator,
  // must fit the daily allowance — or the free tier cannot send at all. A future
  // catalog/default change that reinflates the ceiling fails HERE, at merge.
  it('fits DAILY_ALLOWANCE_NANO_USD for a free-tier default turn over the seeded catalog', async () => {
    const userId = await seedBrokeUser();
    const deps = { db, telemetry: silentTelemetry, billing: createBillingStores() };
    const { build, resolver } = await withModelCatalogLock(redis, async () => {
      await db.delete(modelCatalog);
      await seedModel();
      const built = await buildSmartModelTurnDefinition(deps, {
        userId,
        now: new Date(),
        budget: {
          promptCharacterCount: 400,
          // The free-tier daily allowance IS the effective funding.
          funding: { remainingNanoUsd: DAILY_ALLOWANCE_NANO_USD, kind: 'free' },
        },
      });
      const descriptorsResult = await listDescriptors(deps);
      const descriptors = descriptorsResult._unsafeUnwrap();
      return { build: built, resolver: snapshotResolver(descriptors) };
    });
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable free-tier smart-model definition');

    const ceiling = createEstimateRun(resolver)(value.definition)._unsafeUnwrap();
    expect(ceiling <= DAILY_ALLOWANCE_NANO_USD).toBe(true);
  });
});

describe('buildSmartModelTurnDefinition without a budget', () => {
  it('builds an uncapped answer node (the omitted-budget defensive path)', async () => {
    const userId = await seedRichUser();
    // Seed and derive under the catalog lock: candidate derivation scans the
    // whole catalog, so a concurrent whole-table wipe must not race the read.
    const build = await withModelCatalogLock(redis, async () => {
      // Candidate derivation scans the WHOLE exposed catalog (cheapest text
      // model becomes the classifier; a foreign row with unpriceable/zero rates
      // sorts to the front and fails the classifier-reserve computation, making
      // the build refuse). Under the lock, clear every foreign row and seed one
      // controlled model so the global read sees only our set — the same
      // deterministic-catalog pattern the chat-route trial suite uses. Safe
      // because every participating suite re-seeds what it needs under the lock.
      await db.delete(modelCatalog);
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

describe('buildTrialSmartModelTurnDefinition with classifyEffort', () => {
  it('declares both classifier dimensions when a trial candidate can reason (budget-less path)', async () => {
    const build = await withModelCatalogLock(redis, async () => {
      // Deterministic catalog under the lock (see the paid no-budget test):
      // one plain and one reasoning-capable trial-eligible model, so the
      // effort-dimension gate has a reasoning candidate to find.
      await db.delete(modelCatalog);
      await seedModel();
      await seedReasoningModel();
      return buildTrialSmartModelTurnDefinition(
        { db, telemetry: silentTelemetry },
        { prompt: 'hello there', history: [], now: new Date(), classifyEffort: true }
      );
    });
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable trial smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    expect(node?.type === 'smartModel' && node.classify).toEqual({ model: true, effort: true });
  });

  it('stamps the hard-off wire on a trial Smart turn when the send selected none', async () => {
    const build = await withModelCatalogLock(redis, async () => {
      await db.delete(modelCatalog);
      await seedModel();
      await seedReasoningModel();
      return buildTrialSmartModelTurnDefinition(
        { db, telemetry: silentTelemetry },
        { prompt: 'hello there', history: [], now: new Date(), reasoningOff: true }
      );
    });
    const value = build._unsafeUnwrap();
    if (!value.buildable) throw new Error('expected a buildable trial smart-model definition');
    const node = value.definition.nodes.find((candidate) => candidate.type === 'smartModel');
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    expect(node.params['reasoning']).toEqual({ enabled: false });
    expect(node.classify).toBeUndefined();
  });
});
