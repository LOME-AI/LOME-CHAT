import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { readLatestDescriptorRows, upsertCatalog } from './catalog-store.js';
import type { DescriptorContent } from './normalize.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

async function unwrap<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

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
    releasedAt: 1_700_000_000,
  };
}

afterAll(async () => {
  if (createdModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, createdModelIds));
  }
  await db.$client.end();
  await rival.$client.end();
});

describe('upsertCatalog', () => {
  it('writes the catalog row on first delivery', async () => {
    const modelId = freshModelId('first');
    const result = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, { inputPerToken: '2500' }),
      fetchedAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    expect(result.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.descriptor).toMatchObject({ pricing: { inputPerToken: '2500' } });
  });

  it('stores a descriptor that satisfies the shared ModelDescriptor contract', async () => {
    const modelId = freshModelId('contract');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId),
      fetchedAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    expect(written.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows[0]?.descriptor).toMatchObject({
      id: modelId,
      version: '1',
      fetchedAt: new Date('2026-06-12T00:00:00.000Z').getTime(),
    });
  });

  it('overwrites the descriptor in place on a second upsert, keeping one row', async () => {
    const modelId = freshModelId('overwrite');
    const first = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, { inputPerToken: '2500' }),
      fetchedAt: new Date(),
    });
    const second = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, { inputPerToken: '5000' }),
      fetchedAt: new Date(),
    });
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.descriptor).toMatchObject({ pricing: { inputPerToken: '5000' } });
  });

  it('converges to one row when two writers race the same model', async () => {
    const modelId = freshModelId('race');
    const params = { modelId, content: contentFor(modelId), fetchedAt: new Date() };
    const [a, b] = await Promise.all([upsertCatalog(db, params), upsertCatalog(rival, params)]);
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    const rows = await db.select().from(modelCatalog).where(eq(modelCatalog.modelId, modelId));
    expect(rows).toHaveLength(1);
  });
});

describe('readLatestDescriptorRows', () => {
  it('returns the stored descriptor keyed by model id', async () => {
    const modelId = freshModelId('read');
    const written = await upsertCatalog(db, {
      modelId,
      content: contentFor(modelId, { inputPerToken: '42' }),
      fetchedAt: new Date(),
    });
    expect(written.isOk()).toBe(true);
    const map = await unwrap(readLatestDescriptorRows(db));
    const stored = map.get(modelId);
    expect(stored?.descriptor).toMatchObject({ pricing: { inputPerToken: '42' } });
    expect(stored?.catalogId).toBeDefined();
  });

  it('reflects the latest overwrite for a model', async () => {
    const modelId = freshModelId('read-latest');
    for (const rate of ['1', '2', '3']) {
      const written = await upsertCatalog(db, {
        modelId,
        content: contentFor(modelId, { inputPerToken: rate }),
        fetchedAt: new Date(),
      });
      expect(written.isOk()).toBe(true);
    }
    const map = await unwrap(readLatestDescriptorRows(db));
    expect(map.get(modelId)?.descriptor).toMatchObject({ pricing: { inputPerToken: '3' } });
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

  it('upsertCatalog fails unavailable', async () => {
    const modelId = freshModelId('down-upsert');
    const result = await upsertCatalog(await closedDb(), {
      modelId,
      content: contentFor(modelId),
      fetchedAt: new Date(),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('readLatestDescriptorRows fails unavailable', async () => {
    const result = await readLatestDescriptorRows(await closedDb());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
