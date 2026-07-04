import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog, usageRecords, users } from '@hushbox/db';
import { createBillingStores } from '../adapters/stores.js';
import { readUsageBreakdown } from './usage-analytics.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing usage-analytics integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdCatalogIds: string[] = [];
let counter = 0;

async function seedUser(): Promise<string> {
  counter += 1;
  const username = `bluse${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-usage.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedModel(): Promise<string> {
  const rows = await db
    .insert(modelCatalog)
    .values({
      modelId: `billing-usage-test/model-${crypto.randomUUID()}`,
      version: 1,
      descriptor: {},
    })
    .returning({ id: modelCatalog.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('model seed failed');
  createdCatalogIds.push(id);
  return id;
}

async function seedUsage(
  userId: string,
  modelCatalogId: string,
  costNanoUsd: bigint,
  isEstimated: boolean
): Promise<void> {
  await db.insert(usageRecords).values({
    userId,
    runId: crypto.randomUUID(),
    modelCatalogId,
    modality: 'text',
    costNanoUsd,
    isEstimated,
    idempotencyKey: `usage-test:${crypto.randomUUID()}`,
  });
}

let userId: string;
let otherUserId: string;
let modelX: string;
let modelY: string;
let modelZ: string;

beforeAll(async () => {
  userId = await seedUser();
  otherUserId = await seedUser();
  // uuidv7 ids increase with insert order, so modelX < modelY < modelZ.
  modelX = await seedModel();
  modelY = await seedModel();
  modelZ = await seedModel();
  await seedUsage(userId, modelX, 1000n, false);
  await seedUsage(userId, modelX, 2000n, true);
  await seedUsage(userId, modelY, 5000n, false);
  await seedUsage(otherUserId, modelZ, 9000n, false);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(usageRecords).where(inArray(usageRecords.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdCatalogIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.id, createdCatalogIds));
  }
  await db.$client.end();
});

describe('readUsageBreakdown (integration)', () => {
  it('aggregates cost and counts per model for the caller', async () => {
    const result = await readUsageBreakdown(stores, db, { userId });
    const models = result._unsafeUnwrap().models;
    const x = models.find((m) => m.modelCatalogId === modelX);
    expect(x?.totalNanoUsd).toBe(3000n);
    expect(x?.recordCount).toBe(2);
    expect(x?.estimatedCount).toBe(1);
    const y = models.find((m) => m.modelCatalogId === modelY);
    expect(y?.totalNanoUsd).toBe(5000n);
    expect(y?.recordCount).toBe(1);
    expect(y?.estimatedCount).toBe(0);
  });

  it('never leaks another user usage into the caller breakdown', async () => {
    const result = await readUsageBreakdown(stores, db, { userId });
    const ids = result._unsafeUnwrap().models.map((m) => m.modelCatalogId);
    expect(ids).not.toContain(modelZ);
  });

  it('sums only the caller rows for a model both users share', async () => {
    // A fresh user pair keeps the shared model out of the fixture-based
    // aggregation and pagination assertions above.
    const caller = await seedUser();
    const other = await seedUser();
    const shared = await seedModel();
    await seedUsage(caller, shared, 1000n, false);
    await seedUsage(other, shared, 8000n, false);
    const result = await readUsageBreakdown(stores, db, { userId: caller });
    const entry = result._unsafeUnwrap().models.find((m) => m.modelCatalogId === shared);
    // The other user's 8000n row must be excluded, not summed in.
    expect(entry?.totalNanoUsd).toBe(1000n);
    expect(entry?.recordCount).toBe(1);
  });

  it('paginates by model id with a next cursor on a full page', async () => {
    const result = await readUsageBreakdown(stores, db, { userId, limit: 1 });
    const page = result._unsafeUnwrap();
    expect(page.models.map((m) => m.modelCatalogId)).toEqual([modelX]);
    expect(page.nextCursor).toBe(modelX);
  });

  it('returns the remaining page after the cursor with no further cursor', async () => {
    const result = await readUsageBreakdown(stores, db, { userId, limit: 1, cursor: modelX });
    const page = result._unsafeUnwrap();
    expect(page.models.map((m) => m.modelCatalogId)).toEqual([modelY]);
    expect(page.nextCursor).toBeNull();
  });
});
