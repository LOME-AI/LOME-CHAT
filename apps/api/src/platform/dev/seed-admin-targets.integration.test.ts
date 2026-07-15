import { Redis } from '@upstash/redis';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  createDb,
  jobs,
  ledgerEntries,
  sharedLinks,
  users,
  wallets,
} from '@hushbox/db';
import { eq, inArray } from 'drizzle-orm';
import { generateKeyPair } from '@hushbox/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDevConversation } from './factories.js';
import { seedAdminOpTargets } from './seed-admin-targets.js';
import { setWalletBalance } from './wallet.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for seed-admin-targets integration tests`);
  }
  return value;
}

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

let ownerEmail: string;
let ownerId: string;
let walletId: string;
let conversationId: string;
const seededJobIds: string[] = [];

beforeAll(async () => {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const keys = generateKeyPair();
  ownerEmail = `seedadmin-${suffix}@seed-dev.test`;
  const userRows = await db
    .insert(users)
    .values({
      email: ownerEmail,
      username: `sa${suffix}`,
      opaqueRegistration: new Uint8Array([1]),
      publicKey: keys.publicKey,
      passwordWrappedPrivateKey: new Uint8Array([1]),
      recoveryWrappedPrivateKey: new Uint8Array([1]),
    })
    .returning({ id: users.id });
  const createdUserId = userRows[0]?.id;
  if (createdUserId === undefined) throw new Error('user seed failed');
  ownerId = createdUserId;
  const walletRows = await db
    .insert(wallets)
    .values({ userId: ownerId, type: 'purchased' })
    .returning({ id: wallets.id });
  const createdWalletId = walletRows[0]?.id;
  if (createdWalletId === undefined) throw new Error('wallet seed failed');
  walletId = createdWalletId;
  const conversation = await createDevConversation(db, {
    ownerEmail,
    seedAiModel: 'dev/model',
  });
  conversationId = conversation.conversationId;
});

afterAll(async () => {
  if (seededJobIds.length > 0) {
    await db.delete(jobs).where(inArray(jobs.id, seededJobIds));
  }
  // Ledger legs delete by transaction group (deferred zero-sum trigger).
  const legRows = await db
    .select({ transactionId: ledgerEntries.transactionId })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.walletId, walletId));
  const txnIds = [...new Set(legRows.map((row) => row.transactionId))];
  if (txnIds.length > 0) {
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.transactionId, txnIds));
  }
  // Conversation first (cascades the share + memberships), then the user —
  // membership rows cannot outlive their user (identity check constraint).
  await db.delete(conversations).where(eq(conversations.id, conversationId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.$client.end();
});

describe('seedAdminOpTargets', () => {
  it('creates every admin op-target state, verifiable by query', async () => {
    const summary = await seedAdminOpTargets(db, {
      lockedUserEmail: ownerEmail,
      conversationId,
    });
    seededJobIds.push(summary.deadJobId, summary.discardedJobId);

    const [lockedUser] = await db.select().from(users).where(eq(users.id, summary.lockedUserId));
    expect(summary.lockedUserId).toBe(ownerId);
    expect(lockedUser?.lockedAt).not.toBeNull();
    expect(lockedUser?.lockReason).toBe('chargeback');

    const [deadJob] = await db.select().from(jobs).where(eq(jobs.id, summary.deadJobId));
    expect(deadJob?.status).toBe('dead');
    expect(deadJob?.discardedAt).toBeNull();

    const [discardedJob] = await db.select().from(jobs).where(eq(jobs.id, summary.discardedJobId));
    expect(discardedJob?.status).toBe('dead');
    expect(discardedJob?.discardedAt).not.toBeNull();

    const [share] = await db
      .select()
      .from(sharedLinks)
      .where(eq(sharedLinks.id, summary.revokedShareId));
    expect(share?.conversationId).toBe(conversationId);
    expect(share?.revokedAt).not.toBeNull();
  });

  it('is idempotent on re-run', async () => {
    const first = await seedAdminOpTargets(db, {
      lockedUserEmail: ownerEmail,
      conversationId,
    });
    const second = await seedAdminOpTargets(db, {
      lockedUserEmail: ownerEmail,
      conversationId,
    });
    expect(second).toEqual(first);
    const deadRows = await db.select().from(jobs).where(eq(jobs.id, first.deadJobId));
    expect(deadRows).toHaveLength(1);
  });

  it('fails the post-seed verification when the user is already locked for another reason', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const keys = generateKeyPair();
    const email = `seedadmin-locked-${suffix}@seed-dev.test`;
    const rows = await db
      .insert(users)
      .values({
        email,
        username: `sl${suffix}`,
        opaqueRegistration: new Uint8Array([1]),
        publicKey: keys.publicKey,
        passwordWrappedPrivateKey: new Uint8Array([1]),
        recoveryWrappedPrivateKey: new Uint8Array([1]),
        lockedAt: new Date(),
        lockReason: 'admin',
      })
      .returning({ id: users.id });
    const lockedId = rows[0]?.id;
    if (lockedId === undefined) throw new Error('locked-user seed failed');
    try {
      await expect(
        seedAdminOpTargets(db, { lockedUserEmail: email, conversationId })
      ).rejects.toThrow('chargeback lock');
    } finally {
      await db.delete(users).where(eq(users.id, lockedId));
    }
  });

  it('fails fast when the target user does not exist', async () => {
    await expect(
      seedAdminOpTargets(db, {
        lockedUserEmail: 'missing-user@hushbox.test',
        conversationId,
      })
    ).rejects.toThrow('missing-user@hushbox.test');
  });
});

describe('setWalletBalance with a negative target', () => {
  it('sets a negative purchased balance (a legal admin-op target state)', async () => {
    const redis = new Redis({
      url: requiredEnv('UPSTASH_REDIS_REST_URL'),
      token: requiredEnv('UPSTASH_REDIS_REST_TOKEN'),
    });
    const result = await setWalletBalance(db, redis, {
      email: ownerEmail,
      walletType: 'purchased',
      balance: '-2.5',
    });
    expect(result.newBalance).toBe('-2.500000000');
    const [row] = await db
      .select({ balance: wallets.balanceNanoUsd })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    expect(row?.balance).toBe(-2_500_000_000n);
  });
});
