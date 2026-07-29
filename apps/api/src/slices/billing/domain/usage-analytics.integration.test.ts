import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, usageRecords, users } from '@hushbox/db';
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
let counter = 0;

// The model is captured as a plain string (no catalog FK). These are ordered so
// the keyset pagination — which sorts by modelId ascending — is deterministic.
const MODEL_X = 'usage-analytics/model-a';
const MODEL_Y = 'usage-analytics/model-b';
const MODEL_Z = 'usage-analytics/model-c';
const MODEL_SHARED = 'usage-analytics/model-shared';
const PROVIDER = 'usage-analytics-provider';

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

async function seedUsage(
  userId: string,
  modelId: string,
  costNanoUsd: bigint,
  isEstimated: boolean
): Promise<void> {
  await db.insert(usageRecords).values({
    payerUserId: userId,
    runId: crypto.randomUUID(),
    modelId,
    providerName: PROVIDER,
    modality: 'text',
    costNanoUsd,
    isEstimated,
    idempotencyKey: `usage-test:${crypto.randomUUID()}`,
  });
}

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  userId = await seedUser();
  otherUserId = await seedUser();
  await seedUsage(userId, MODEL_X, 1000n, false);
  await seedUsage(userId, MODEL_X, 2000n, true);
  await seedUsage(userId, MODEL_Y, 5000n, false);
  await seedUsage(otherUserId, MODEL_Z, 9000n, false);
});

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(usageRecords).where(inArray(usageRecords.payerUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('readUsageBreakdown (integration)', () => {
  it('aggregates cost and counts per model for the caller', async () => {
    const result = await readUsageBreakdown(stores, db, { userId });
    const models = result._unsafeUnwrap().models;
    const x = models.find((m) => m.modelId === MODEL_X);
    expect(x?.totalNanoUsd).toBe(3000n);
    expect(x?.recordCount).toBe(2);
    expect(x?.estimatedCount).toBe(1);
    const y = models.find((m) => m.modelId === MODEL_Y);
    expect(y?.totalNanoUsd).toBe(5000n);
    expect(y?.recordCount).toBe(1);
    expect(y?.estimatedCount).toBe(0);
  });

  it('never leaks another user usage into the caller breakdown', async () => {
    const result = await readUsageBreakdown(stores, db, { userId });
    const ids = result._unsafeUnwrap().models.map((m) => m.modelId);
    expect(ids).not.toContain(MODEL_Z);
  });

  it('sums only the caller rows for a model both users share', async () => {
    // A fresh user pair keeps the shared model out of the fixture-based
    // aggregation and pagination assertions above.
    const caller = await seedUser();
    const other = await seedUser();
    await seedUsage(caller, MODEL_SHARED, 1000n, false);
    await seedUsage(other, MODEL_SHARED, 8000n, false);
    const result = await readUsageBreakdown(stores, db, { userId: caller });
    const entry = result._unsafeUnwrap().models.find((m) => m.modelId === MODEL_SHARED);
    // The other user's 8000n row must be excluded, not summed in.
    expect(entry?.totalNanoUsd).toBe(1000n);
    expect(entry?.recordCount).toBe(1);
  });

  it('paginates by model id with a next cursor on a full page', async () => {
    const result = await readUsageBreakdown(stores, db, { userId, limit: 1 });
    const page = result._unsafeUnwrap();
    expect(page.models.map((m) => m.modelId)).toEqual([MODEL_X]);
    expect(page.nextCursor).toBe(MODEL_X);
  });

  it('returns the remaining page after the cursor with no further cursor', async () => {
    const result = await readUsageBreakdown(stores, db, { userId, limit: 1, cursor: MODEL_X });
    const page = result._unsafeUnwrap();
    expect(page.models.map((m) => m.modelId)).toEqual([MODEL_Y]);
    expect(page.nextCursor).toBeNull();
  });
});
