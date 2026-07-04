import {
  LOCAL_NEON_DEV_CONFIG,
  createDb,
  modelCatalog,
  modelOverrides,
  modelPricing,
} from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { insertCatalogVersion, readLatestDescriptorRows, readOverrides } from './catalog-store.js';
import type { DescriptorContent } from './normalize.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for catalog-store integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

/** Unique per test run so concurrent suites on the shared DB never collide. */
const RUN_PREFIX = `mdl-cs-${crypto.randomUUID().slice(0, 8)}`;
const createdModelIds: string[] = [];

function freshModelId(slug: string): string {
  const modelId = `${RUN_PREFIX}/${slug}`;
  createdModelIds.push(modelId);
  return modelId;
}

function contentFor(
  modelId: string,
  pricing: DescriptorContent['pricing'] = {}
): DescriptorContent {
  return {
    id: modelId,
    provider: 'test-provider',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {},
    pricing,
    zdrReachable: true,
  };
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
    await db.delete(modelOverrides).where(inArray(modelOverrides.modelId, createdModelIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('insertCatalogVersion', () => {
  it('writes the catalog row and its pricing row on first delivery', async () => {
    const modelId = freshModelId('first');
    const result = await insertCatalogVersion(db, {
      modelId,
      version: 1,
      content: contentFor(modelId, { inputPerToken: '2500' }),
      fetchedAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    expect(result._unsafeUnwrap()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(1);
    const catalogId = rows[0]?.id ?? '';
    const pricingRows = await db
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.modelCatalogId, catalogId));
    expect(pricingRows).toHaveLength(1);
    expect(pricingRows[0]?.pricing).toEqual({ inputPerToken: '2500' });
  });

  it('stores a descriptor that satisfies the shared ModelDescriptor contract', async () => {
    const modelId = freshModelId('contract');
    const written = await insertCatalogVersion(db, {
      modelId,
      version: 3,
      content: contentFor(modelId),
      fetchedAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    expect(written.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows[0]?.descriptor).toMatchObject({
      id: modelId,
      version: '3',
      fetchedAt: new Date('2026-06-12T00:00:00.000Z').getTime(),
    });
  });

  it('converges duplicate delivery of the same version onto one row', async () => {
    const modelId = freshModelId('dup');
    const params = {
      modelId,
      version: 1,
      content: contentFor(modelId),
      fetchedAt: new Date(),
    };
    const first = await insertCatalogVersion(db, params);
    const second = await insertCatalogVersion(db, params);
    expect(first._unsafeUnwrap()).toBe(true);
    expect(second._unsafeUnwrap()).toBe(false);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
  });

  it('creates exactly one version row when two writers race', async () => {
    const modelId = freshModelId('race');
    const params = {
      modelId,
      version: 1,
      content: contentFor(modelId),
      fetchedAt: new Date(),
    };
    const [a, b] = await Promise.all([
      insertCatalogVersion(db, params),
      insertCatalogVersion(rival, params),
    ]);
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
    const catalogId = rows[0]?.id ?? '';
    const pricingRows = await db
      .select()
      .from(modelPricing)
      .where(eq(modelPricing.modelCatalogId, catalogId));
    expect(pricingRows).toHaveLength(1);
  });
});

describe('readLatestDescriptorRows', () => {
  it('returns the highest version per model', async () => {
    const modelId = freshModelId('latest');
    const v1 = await insertCatalogVersion(db, {
      modelId,
      version: 1,
      content: contentFor(modelId),
      fetchedAt: new Date(),
    });
    expect(v1.isOk()).toBe(true);
    const v2 = await insertCatalogVersion(db, {
      modelId,
      version: 2,
      content: contentFor(modelId, { inputPerToken: '42' }),
      fetchedAt: new Date(),
    });
    expect(v2.isOk()).toBe(true);
    const mapResult = await readLatestDescriptorRows(db);
    const map = mapResult._unsafeUnwrap();
    const stored = map.get(modelId);
    expect(stored?.version).toBe(2);
    expect(stored?.descriptor).toMatchObject({ pricing: { inputPerToken: '42' } });
  });

  it('keeps the highest version across a descending run of older rows', async () => {
    const modelId = freshModelId('descending');
    // Descending insertion puts the newest row first in heap order, so the
    // fold meets every older version while already holding a newer one —
    // the keep-current side of the comparison.
    for (const version of [3, 2, 1]) {
      const written = await insertCatalogVersion(db, {
        modelId,
        version,
        content: contentFor(modelId, { inputPerToken: String(version) }),
        fetchedAt: new Date(),
      });
      expect(written.isOk()).toBe(true);
    }
    const mapResult = await readLatestDescriptorRows(db);
    const stored = mapResult._unsafeUnwrap().get(modelId);
    expect(stored?.version).toBe(3);
    expect(stored?.descriptor).toMatchObject({ pricing: { inputPerToken: '3' } });
  });

  it('keeps the highest version when a lower one is written afterward', async () => {
    const modelId = freshModelId('out-of-order');
    const v2 = await insertCatalogVersion(db, {
      modelId,
      version: 2,
      content: contentFor(modelId, { inputPerToken: '7' }),
      fetchedAt: new Date(),
    });
    expect(v2.isOk()).toBe(true);
    const v1 = await insertCatalogVersion(db, {
      modelId,
      version: 1,
      content: contentFor(modelId),
      fetchedAt: new Date(),
    });
    expect(v1.isOk()).toBe(true);
    const mapResult = await readLatestDescriptorRows(db);
    const stored = mapResult._unsafeUnwrap().get(modelId);
    expect(stored?.version).toBe(2);
  });
});

describe('when the database is unreachable', () => {
  // Module-level narrowing of DATABASE_URL does not reach this closure.
  const databaseUrl: string = DATABASE_URL;

  async function closedDb(): Promise<typeof db> {
    const closed = createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });
    await closed.$client.end();
    return closed;
  }

  it('insertCatalogVersion fails unavailable', async () => {
    const modelId = freshModelId('down-insert');
    const result = await insertCatalogVersion(await closedDb(), {
      modelId,
      version: 1,
      content: contentFor(modelId),
      fetchedAt: new Date(),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('readLatestDescriptorRows fails unavailable', async () => {
    const result = await readLatestDescriptorRows(await closedDb());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('readOverrides fails unavailable', async () => {
    const result = await readOverrides(await closedDb());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('readOverrides', () => {
  it('parses an override row keyed by model id', async () => {
    const modelId = freshModelId('override');
    await db
      .insert(modelOverrides)
      .values({
        modelId,
        overrides: { pricing: { perImage: '40000000' } },
        zdrVerifiedAt: new Date('2026-06-01T00:00:00.000Z'),
      })
      .onConflictDoNothing();
    const readResult = await readOverrides(db);
    const { overrides } = readResult._unsafeUnwrap();
    const row = overrides.get(modelId);
    expect(row?.data.pricing).toEqual({ perImage: '40000000' });
    expect(row?.zdrVerifiedAt?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('reports a contract-breaking override row as invalid and omits it', async () => {
    const modelId = freshModelId('bad-override');
    await db
      .insert(modelOverrides)
      .values({ modelId, overrides: { surprise: 1 } })
      .onConflictDoNothing();
    const readResult = await readOverrides(db);
    const { overrides, invalidModelIds } = readResult._unsafeUnwrap();
    expect(overrides.has(modelId)).toBe(false);
    expect(invalidModelIds).toContain(modelId);
  });
});
