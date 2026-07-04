import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  jobs,
  ledgerEntries,
  messages,
  modelCatalog,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { notFoundError } from '../../../lib/errors/index.js';
import { runSettlement } from '../../../lib/idempotency/index.js';
import { createJobRegistry } from '../../../lib/jobs/index.js';
import { createBillingStores } from '../adapters/stores.js';
import { chargeWithinTx } from './charge.js';
import {
  TRUE_UP_JOB_TYPE,
  TRUE_UP_MAX_FAILURES,
  applyTrueUp,
  createTrueUpJobRegistration,
  enqueueTrueUpWithinTx,
} from './true-up.js';
import type { TrueUpDeps, TrueUpStatus } from './true-up.js';
import type { JobExecution } from '../../../lib/jobs/index.js';
import type { JobOutcome } from '../../../lib/jobs/index.js';
import type { GenerationCostClient } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for billing true-up integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createBillingStores();
const BYTES = new Uint8Array([1, 2, 3]);
const NOW = new Date('2026-07-03T12:00:00Z');
const createdUserIds: string[] = [];
const createdCatalogIds: string[] = [];
const createdConversationIds: string[] = [];
const createdJobIds: string[] = [];
let counter = 0;

async function trueUpStatus(deps: TrueUpDeps, usageRecordId: string): Promise<TrueUpStatus> {
  const result = await applyTrueUp(deps, { usageRecordId });
  return result._unsafeUnwrap();
}

function costClient(totalCostUsd: number): GenerationCostClient {
  return {
    fetchGenerationInfo: (generationId) => okAsync({ generationId, totalCostUsd }),
  };
}

const missingCostClient: GenerationCostClient = {
  fetchGenerationInfo: () => errAsync(notFoundError('generation not indexed yet')),
};

async function seedUser(): Promise<string> {
  counter += 1;
  const username = `bltru${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}${String(counter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@billing-trueup.test`,
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

interface Fixture {
  userId: string;
  walletId: string;
  usageRecordId: string;
  balanceAfterCharge: bigint;
}

function first<T>(rows: readonly T[], label: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${label} seed failed`);
  return row;
}

/** Seeds a charged run: wallet at $10, estimated base $1 charge ($1.15 marked up). */
async function seedChargedRun(generationId: string | null): Promise<Fixture> {
  const userId = await seedUser();
  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000_000n })
    .returning({ id: wallets.id });
  const walletId = first(walletRows, 'wallet').id;
  const catalogRows = await db
    .insert(modelCatalog)
    .values({
      modelId: `billing-trueup-test/model-${crypto.randomUUID()}`,
      version: 1,
      descriptor: {},
    })
    .returning({ id: modelCatalog.id });
  const modelCatalogId = first(catalogRows, 'model').id;
  createdCatalogIds.push(modelCatalogId);
  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = first(conversationRows, 'conversation').id;
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  const messageRows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const messageId = first(messageRows, 'message').id;
  const contentRows = await db
    .insert(contentItems)
    .values({ messageId, contentType: 'text', encryptedBlob: BYTES })
    .returning({ id: contentItems.id });
  const contentItemId = first(contentRows, 'content item').id;
  const charge = await runSettlement(db, (tx) =>
    chargeWithinTx(stores, tx, {
      walletId,
      userId,
      runId: crypto.randomUUID(),
      contentItemId,
      modelCatalogId,
      modality: 'text',
      ...(generationId === null ? {} : { generationId }),
      baseCostNanoUsd: 1_000_000_000n,
      isEstimated: true,
      idempotencyKey: `trueup-test:${crypto.randomUUID()}`,
      now: NOW,
    })
  );
  return {
    userId,
    walletId,
    usageRecordId: charge.usageRecordId,
    balanceAfterCharge: charge.balanceAfterNanoUsd,
  };
}

function fakeExecution(
  usageRecordId: string,
  claims: number
): JobExecution<{ usageRecordId: string }> & { completions: number } {
  const execution = {
    jobId: crypto.randomUUID(),
    payload: { usageRecordId },
    claims,
    completions: 0,
    heartbeat: () => Promise.resolve('alive' as const),
    completeWithinTx: (): Promise<JobOutcome> => {
      execution.completions += 1;
      return Promise.resolve({ kind: 'completed', completion: 'succeeded' } as JobOutcome);
    },
  };
  return execution as JobExecution<{ usageRecordId: string }> & { completions: number };
}

async function deleteLedgerRowsFor(walletIds: string[]): Promise<void> {
  if (walletIds.length === 0) return;
  const legRows = await db
    .select({ transactionId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .where(inArray(ledgerEntries.walletId, walletIds));
  const transactionIds = [...new Set(legRows.map((row) => row.transactionId))];
  if (transactionIds.length > 0) {
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, transactionIds));
  }
  await db.delete(wallets).where(inArray(wallets.id, walletIds));
}

async function deleteSeededRows(): Promise<void> {
  if (createdUserIds.length === 0) return;
  const walletRows = await db
    .select({ id: wallets.id })
    .from(wallets)
    .where(inArray(wallets.userId, createdUserIds));
  await db.delete(usageRecords).where(inArray(usageRecords.userId, createdUserIds));
  await deleteLedgerRowsFor(walletRows.map((row) => row.id));
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  await db.delete(users).where(inArray(users.id, createdUserIds));
}

afterAll(async () => {
  if (createdJobIds.length > 0) {
    await db.delete(jobs).where(inArray(jobs.id, createdJobIds));
  }
  await deleteSeededRows();
  if (createdCatalogIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.id, createdCatalogIds));
  }
  await db.$client.end();
});

describe('applyTrueUp', () => {
  it('posts a debit adjustment and finalizes when the authoritative cost is higher', async () => {
    const fixture = await seedChargedRun('gen-up');
    // Gateway base $1.30 → authoritative $1.495; estimate was $1.15 → +$0.345
    const deps = { db, stores, generationCost: costClient(1.3) };
    const status = await trueUpStatus(deps, fixture.usageRecordId);
    expect(status).toBe('trued-up');
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(false);
    expect(record[0]?.costNanoUsd).toBe(1_495_000_000n);
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(fixture.balanceAfterCharge - 345_000_000n);
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, fixture.usageRecordId));
    const trueUpLegs = legs.filter((leg) => leg.kind === 'true_up');
    expect(trueUpLegs).toHaveLength(2);
    expect(trueUpLegs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
  });

  it('credits the wallet when the authoritative cost is lower', async () => {
    const fixture = await seedChargedRun('gen-down');
    // Gateway base $0.80 → authoritative $0.92; estimate was $1.15 → −$0.23
    const deps = { db, stores, generationCost: costClient(0.8) };
    await trueUpStatus(deps, fixture.usageRecordId);
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(fixture.balanceAfterCharge + 230_000_000n);
  });

  it('clears the flag without legs when the authoritative cost matches', async () => {
    const fixture = await seedChargedRun('gen-equal');
    const deps = { db, stores, generationCost: costClient(1) };
    const status = await trueUpStatus(deps, fixture.usageRecordId);
    expect(status).toBe('unchanged');
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, fixture.usageRecordId));
    expect(legs.filter((leg) => leg.kind === 'true_up')).toHaveLength(0);
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(false);
  });

  it('replays as a no-op once finalized', async () => {
    const fixture = await seedChargedRun('gen-replay');
    const deps = { db, stores, generationCost: costClient(1.3) };
    await trueUpStatus(deps, fixture.usageRecordId);
    const second = await trueUpStatus(deps, fixture.usageRecordId);
    expect(second).toBe('already-final');
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, fixture.usageRecordId));
    expect(legs.filter((leg) => leg.kind === 'true_up')).toHaveLength(2);
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(fixture.balanceAfterCharge - 345_000_000n);
  });

  it('posts an authoritative cost sitting exactly at the sanity ceiling', async () => {
    const fixture = await seedChargedRun('gen-ceiling');
    // Ceiling = estimate × K = $1.15 × 5 = $5.75; gateway base $5 marks up to exactly $5.75.
    const deps = { db, stores, generationCost: costClient(5) };
    const status = await trueUpStatus(deps, fixture.usageRecordId);
    expect(status).toBe('trued-up');
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(fixture.balanceAfterCharge - 4_600_000_000n);
  });

  it('rejects a gateway cost above the sanity ceiling without posting the adjustment', async () => {
    const fixture = await seedChargedRun('gen-absurd');
    // Gateway base $5.01 marks up past the $5.75 ceiling.
    const result = await applyTrueUp(
      { db, stores, generationCost: costClient(5.01) },
      { usageRecordId: fixture.usageRecordId }
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(true);
    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.usageRecordId, fixture.usageRecordId));
    expect(legs.filter((leg) => leg.kind === 'true_up')).toHaveLength(0);
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(fixture.balanceAfterCharge);
  });

  it('rejects a negative provider cost and keeps the estimate flagged', async () => {
    const fixture = await seedChargedRun('gen-negative');
    const deps = { db, stores, generationCost: costClient(-0.5) };
    const result = await applyTrueUp(deps, { usageRecordId: fixture.usageRecordId });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('validation');
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(true);
  });
});

describe('applyTrueUp edge handling', () => {
  it('errors with validation when the record carries no generation id', async () => {
    const fixture = await seedChargedRun(null);
    const result = await applyTrueUp(
      { db, stores, generationCost: costClient(1.3) },
      { usageRecordId: fixture.usageRecordId }
    );
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('aborts the settlement when the record has no charge wallet leg', async () => {
    const fixture = await seedChargedRun('gen-orphan');
    const rows = await db
      .insert(usageRecords)
      .values({
        userId: fixture.userId,
        runId: crypto.randomUUID(),
        modelCatalogId: createdCatalogIds.at(-1) ?? '',
        modality: 'text',
        generationId: 'gen-orphan-2',
        // Keeps the $1.495 authoritative cost inside the sanity ceiling so the
        // test reaches the missing-charge-leg defect.
        costNanoUsd: 1_150_000_000n,
        isEstimated: true,
        idempotencyKey: `orphan:${crypto.randomUUID()}`,
      })
      .returning({ id: usageRecords.id });
    const orphanId = rows[0]?.id ?? '';
    const result = await applyTrueUp(
      { db, stores, generationCost: costClient(1.3) },
      { usageRecordId: orphanId }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('applyTrueUp race handling', () => {
  it('reports already-final when a racer finalized inside the settlement', async () => {
    const fixture = await seedChargedRun('gen-tx-race');
    const racedStores = {
      ...stores,
      finalizeUsageRecordCostWithinTx: () => Promise.resolve(false),
    };
    const status = await trueUpStatus(
      { db, stores: racedStores, generationCost: costClient(1.3) },
      fixture.usageRecordId
    );
    expect(status).toBe('already-final');
  });
});

describe('trueup.fetch.v1 handler', () => {
  function registrationWith(client: GenerationCostClient) {
    return createTrueUpJobRegistration({ db, stores, generationCost: client });
  }

  it('declares the versioned type, payload schema and txn idempotency', () => {
    const registration = registrationWith(costClient(1));
    expect(registration.type).toBe(TRUE_UP_JOB_TYPE);
    expect(registration.idempotency).toBe('txn');
    expect(registration.schema.safeParse({ usageRecordId: crypto.randomUUID() }).success).toBe(
      true
    );
    expect(registration.schema.safeParse({}).success).toBe(false);
  });

  it('returns ok without effects when the record is already final', async () => {
    const fixture = await seedChargedRun('gen-final');
    await trueUpStatus({ db, stores, generationCost: costClient(1) }, fixture.usageRecordId);
    const registration = registrationWith(costClient(1));
    const execution = fakeExecution(fixture.usageRecordId, 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('ok');
    expect(execution.completions).toBe(0);
  });

  it('returns fail while the gateway has not indexed the generation and retries remain', async () => {
    const fixture = await seedChargedRun('gen-pending');
    const registration = registrationWith(missingCostClient);
    const execution = fakeExecution(fixture.usageRecordId, 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('fail');
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(true);
  });

  it('returns fail (retriable) when the gateway cost is above the sanity ceiling', async () => {
    const fixture = await seedChargedRun('gen-absurd-job');
    const registration = registrationWith(costClient(5.01));
    const execution = fakeExecution(fixture.usageRecordId, 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('fail');
    expect(execution.completions).toBe(0);
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(true);
  });

  it('keeps failing at the retry cap so the dispatcher dead-letters the row', async () => {
    const fixture = await seedChargedRun('gen-exhausted');
    const registration = registrationWith(missingCostClient);
    const execution = fakeExecution(fixture.usageRecordId, TRUE_UP_MAX_FAILURES);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('fail');
    expect(execution.completions).toBe(0);
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(true);
    expect(record[0]?.costNanoUsd).toBe(1_150_000_000n);
  });

  it('dead-letters a record with no generation id, leaving the estimate flagged', async () => {
    const fixture = await seedChargedRun(null);
    const registration = registrationWith(costClient(1.3));
    const execution = fakeExecution(fixture.usageRecordId, 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('dead');
    expect(execution.completions).toBe(0);
    const record = await db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.id, fixture.usageRecordId));
    expect(record[0]?.isEstimated).toBe(true);
  });

  it('applies the true-up and completes within the settlement transaction', async () => {
    const fixture = await seedChargedRun('gen-success');
    const registration = registrationWith(costClient(1.3));
    const execution = fakeExecution(fixture.usageRecordId, 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('completed');
    expect(execution.completions).toBe(1);
    const walletRows = await db.select().from(wallets).where(eq(wallets.id, fixture.walletId));
    expect(walletRows[0]?.balanceNanoUsd).toBe(fixture.balanceAfterCharge - 345_000_000n);
  });

  it('returns fail when the charge-wallet lookup fails', async () => {
    const fixture = await seedChargedRun('gen-wallet-lookup');
    const brokenStores = {
      ...stores,
      readUsageChargeWallet: () => errAsync(notFoundError('lookup refused')),
    };
    const registration = createTrueUpJobRegistration({
      db,
      stores: brokenStores,
      generationCost: costClient(1.3),
    });
    const execution = fakeExecution(fixture.usageRecordId, 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('fail');
  });

  it('returns fail when the usage-record read itself fails', async () => {
    const badDb = createDb('postgresql://user:pw@localhost:1/nope', {
      neonDev: LOCAL_NEON_DEV_CONFIG,
    });
    const registration = createTrueUpJobRegistration({
      db: badDb,
      stores,
      generationCost: costClient(1),
    });
    const execution = fakeExecution(crypto.randomUUID(), 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('fail');
    await badDb.$client.end();
  });

  it('dead-letters a payload pointing at no usage record', async () => {
    const registration = registrationWith(costClient(1));
    const execution = fakeExecution(crypto.randomUUID(), 1);
    const outcome = await registration.handler(execution);
    expect(outcome.kind).toBe('dead');
  });
});

describe('enqueueTrueUpWithinTx', () => {
  it('inserts the job row inside the caller transaction with a per-record dedupe key', async () => {
    const registry = createJobRegistry();
    registry.register(createTrueUpJobRegistration({ db, stores, generationCost: costClient(1) }));
    const usageRecordId = crypto.randomUUID();
    const first = await db.transaction((tx) =>
      enqueueTrueUpWithinTx(tx, registry, { usageRecordId })
    );
    expect(first.enqueued).toBe(true);
    if (first.enqueued) createdJobIds.push(first.jobId);
    const second = await db.transaction((tx) =>
      enqueueTrueUpWithinTx(tx, registry, { usageRecordId })
    );
    expect(second).toEqual({ enqueued: false, reason: 'duplicate-active' });
    const rows = await db.select().from(jobs).where(eq(jobs.type, TRUE_UP_JOB_TYPE));
    const mine = rows.filter(
      (row) => (row.payload as { usageRecordId?: string }).usageRecordId === usageRecordId
    );
    expect(mine).toHaveLength(1);
  });
});
