import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { acquireModelCatalogLock } from '../__tests__/model-catalog-lock.js';
import { disableModelWithinTx, enableModelWithinTx } from '../adapters/catalog-admin.js';
import { findAdminDisabledModel } from './admin-disabled.js';
import { upsertCatalog } from './catalog-store.js';
import { TEST_GATEWAY_BASE_URL, catalogFetch, modelEntryFixture } from './gateway-fixtures.js';
import { createModelPricingResolver } from './pricing-resolver.js';
import { refreshCatalog } from './refresh.js';
import type { DescriptorContent } from './normalize.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL and UPSTASH_REDIS_REST_* are required for admin-disabled integration tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// Serialize every catalog critical section against the other model_catalog
// suites; held per test via a crash-safe Redis TTL lock (see helper).
let releaseModelCatalogLock: (() => Promise<void>) | undefined;
beforeEach(async () => {
  releaseModelCatalogLock = await acquireModelCatalogLock(redis);
});
afterEach(async () => {
  const release = releaseModelCatalogLock;
  releaseModelCatalogLock = undefined;
  await release?.();
});

/** Unique per test run so concurrent suites on the shared DB never collide. */
const RUN_PREFIX = `mdl-ad-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

/** Exposed content: priced, ZDR-reachable, language call shape. */
function exposedContentFor(modelId: string): DescriptorContent {
  return {
    id: modelId,
    provider: RUN_PREFIX,
    version: '2',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {},
    pricing: { inputPerToken: '2500' },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
  };
}

async function seedExposed(modelId: string): Promise<void> {
  const written = await upsertCatalog(db, {
    modelId,
    content: exposedContentFor(modelId),
    popularityRank: null,
    fetchedAt: new Date('2026-07-13T00:00:00.000Z'),
  });
  written._unsafeUnwrap();
}

async function adminDisabledAtOf(modelId: string): Promise<Date | null> {
  const rows = await db
    .select({ adminDisabledAt: modelCatalog.adminDisabledAt })
    .from(modelCatalog)
    .where(eq(modelCatalog.modelId, modelId));
  expect(rows).toHaveLength(1);
  return rows[0]?.adminDisabledAt ?? null;
}

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  emitMetric: () => {},
  captureError: () => {},
};

const NOW = new Date('2026-07-13T12:00:00.000Z');

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
});

describe('disableModelWithinTx', () => {
  it('sets the kill switch on an enabled model', async () => {
    const modelId = freshModelId('disable');
    await seedExposed(modelId);
    const outcome = await unwrap(disableModelWithinTx(db, modelId, NOW));
    expect(outcome).toBe('disabled');
    expect(await adminDisabledAtOf(modelId)).toEqual(NOW);
  });

  it('double-disable is a distinguishable no-op that keeps the original timestamp', async () => {
    const modelId = freshModelId('disable-twice');
    await seedExposed(modelId);
    await unwrap(disableModelWithinTx(db, modelId, NOW));
    const later = new Date('2026-07-14T00:00:00.000Z');
    const outcome = await unwrap(disableModelWithinTx(db, modelId, later));
    expect(outcome).toBe('already-disabled');
    expect(await adminDisabledAtOf(modelId)).toEqual(NOW);
  });

  it('refuses an unknown model with not_found', async () => {
    const result = await disableModelWithinTx(db, `${RUN_PREFIX}/missing`, NOW);
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('composes inside a transaction: a rolled-back disable leaves the model enabled', async () => {
    const modelId = freshModelId('disable-rollback');
    await seedExposed(modelId);
    await expect(
      db.transaction(async (tx) => {
        const outcome = await unwrap(disableModelWithinTx(tx, modelId, NOW));
        expect(outcome).toBe('disabled');
        throw new Error('force rollback');
      })
    ).rejects.toThrow('force rollback');
    expect(await adminDisabledAtOf(modelId)).toBeNull();
  });
});

describe('enableModelWithinTx', () => {
  it('clears the kill switch on a disabled model', async () => {
    const modelId = freshModelId('enable');
    await seedExposed(modelId);
    await unwrap(disableModelWithinTx(db, modelId, NOW));
    const outcome = await unwrap(enableModelWithinTx(db, modelId));
    expect(outcome).toBe('enabled');
    expect(await adminDisabledAtOf(modelId)).toBeNull();
  });

  it('double-enable is a distinguishable no-op', async () => {
    const modelId = freshModelId('enable-twice');
    await seedExposed(modelId);
    const outcome = await unwrap(enableModelWithinTx(db, modelId));
    expect(outcome).toBe('already-enabled');
    expect(await adminDisabledAtOf(modelId)).toBeNull();
  });

  it('refuses an unknown model with not_found', async () => {
    const result = await enableModelWithinTx(db, `${RUN_PREFIX}/missing`);
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });
});

describe('findAdminDisabledModel', () => {
  it('names the disabled model in a selection even though listings hide it', async () => {
    const enabled = freshModelId('gate-enabled');
    const disabled = freshModelId('gate-disabled');
    await seedExposed(enabled);
    await seedExposed(disabled);
    await unwrap(disableModelWithinTx(db, disabled, NOW));
    expect(await unwrap(findAdminDisabledModel({ db }, [enabled, disabled]))).toBe(disabled);
  });

  it('returns undefined for a clean selection (unknown ids ignored)', async () => {
    const enabled = freshModelId('gate-clean');
    await seedExposed(enabled);
    expect(
      await unwrap(findAdminDisabledModel({ db }, [enabled, `${RUN_PREFIX}/unknown`]))
    ).toBeUndefined();
  });
});

describe('turn-time resolution seam', () => {
  it('the pricing resolver chat builds turns from fails closed on a disabled model', async () => {
    const modelId = freshModelId('resolver');
    await seedExposed(modelId);
    const before = await unwrap(createModelPricingResolver({ db, telemetry: silentTelemetry }));
    expect(before(modelId)?.id).toBe(modelId);

    await unwrap(disableModelWithinTx(db, modelId, NOW));
    const after = await unwrap(createModelPricingResolver({ db, telemetry: silentTelemetry }));
    expect(after(modelId)).toBeUndefined();
  });
});

describe('catalog refresh non-clobber', () => {
  it('a disabled model stays disabled and hidden through a content-changing refresh', async () => {
    const modelId = freshModelId('refresh');
    const refresh = async (contextLength: number): Promise<void> => {
      const result = await refreshCatalog({
        db,
        fetch: catalogFetch({
          models: [modelEntryFixture({ id: modelId, context_length: contextLength })],
          zdrModelIds: [modelId],
        }),
        gatewayBaseUrl: TEST_GATEWAY_BASE_URL,
        telemetry: silentTelemetry,
        now: () => new Date('2026-07-13T00:00:00.000Z'),
      });
      result._unsafeUnwrap();
    };

    await refresh(100_000);
    await unwrap(disableModelWithinTx(db, modelId, NOW));

    // Changed content forces the upsert's conflict-update path — the set
    // clause only touches `descriptor`, so the flag must survive.
    await refresh(200_000);
    expect(await adminDisabledAtOf(modelId)).toEqual(NOW);
    const resolver = await unwrap(createModelPricingResolver({ db, telemetry: silentTelemetry }));
    expect(resolver(modelId)).toBeUndefined();
  });
});
