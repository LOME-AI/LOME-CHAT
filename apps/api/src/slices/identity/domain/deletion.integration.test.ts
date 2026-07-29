import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  accountDeletionEvents,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  jobs,
  messages,
  payments,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { createAppJobRegistry, enqueueWithinTx } from '../../../lib/jobs/index.js';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { MEDIA_RECLAIM_USER_JOB_TYPE, createMediaReclaimUserJob } from '../../media/index.js';
import {
  captureContentStorageKeysWithinTx,
  detachMessageSendersWithinTx,
} from '../../chat/index.js';
import { createIdentityStores } from '../adapters/stores.js';
import { IDENTITY_KEYS } from './keys.js';
import { executeAccountDeletion } from './deletion.js';
import type { Storage } from '../../media/index.js';
import type { AccountDeletionPurge, EvictUserPort } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and Upstash vars are required for deletion executor tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const stores = createIdentityStores(db);

/** Unique per run so concurrent suites on the shared DB never collide. */
const PREFIX = `zd${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
const createdUserIds: string[] = [];
let counter = 0;

const BYTES = new Uint8Array([1, 2, 3]);

/**
 * Enqueue-only registry: the reclaim handler runs in the dispatcher DO, never
 * here, so the storage the registration demands is a dead placeholder — the
 * enqueue path reads only the schema/lease/shard metadata.
 */
const reclaimRegistry = createAppJobRegistry([
  createMediaReclaimUserJob({ storage: {} as Storage }),
]);

const sentDeleted: string[] = [];
const evicted: string[] = [];

function purge(overrides: Partial<AccountDeletionPurge> = {}): AccountDeletionPurge {
  return {
    captureContentStorageKeysWithinTx,
    detachMessageSendersWithinTx,
    enqueueMediaReclaimWithinTx: async (tx, args) => {
      await enqueueWithinTx(tx, reclaimRegistry, {
        type: MEDIA_RECLAIM_USER_JOB_TYPE,
        payload: args,
      });
    },
    ...overrides,
  };
}

const evictUser: EvictUserPort = {
  evictUser: (userId) => {
    evicted.push(userId);
    return Promise.resolve();
  },
};

function executorArgs(userId: string, overrides: Partial<AccountDeletionPurge> = {}) {
  return {
    redis,
    store: stores.users,
    db,
    purge: purge(overrides),
    accountDeletedEmail: {
      sendAccountDeletedEmail: (args: { readonly to: string }) => {
        sentDeleted.push(args.to);
        return okAsync();
      },
    },
    evictUser,
    userId,
    ipAddress: '203.0.113.7',
    // Per-call marker: deletion events are anonymous, so a unique userAgent
    // is each test's only handle on its own rows.
    userAgent: `${PREFIX}-agent-${crypto.randomUUID()}`,
    now: new Date(),
  };
}

async function seedUser(): Promise<{ id: string; email: string }> {
  counter += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `${PREFIX}u${String(counter)}@deletion-executor.test`,
      username: `${PREFIX}u${String(counter)}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id, email: users.email });
  if (!row) throw new Error('user seed failed');
  createdUserIds.push(row.id);
  return row;
}

async function seedConversation(ownerUserId: string): Promise<string> {
  const [conversation] = await db
    .insert(conversations)
    .values({ userId: ownerUserId, title: BYTES })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error('conversation seed failed');
  await db.insert(epochs).values({
    conversationId: conversation.id,
    epochNumber: 1,
    epochPublicKey: BYTES,
    confirmationHash: BYTES,
  });
  await db
    .insert(conversationMembers)
    .values({ conversationId: conversation.id, userId: ownerUserId, visibleFromEpoch: 1 });
  return conversation.id;
}

let sequence = 0;

async function seedMessage(conversationId: string, senderId: string): Promise<string> {
  sequence += 1;
  const [row] = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      senderId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: sequence,
    })
    .returning({ id: messages.id });
  if (!row) throw new Error('message seed failed');
  return row.id;
}

function mediaKey(): string {
  return `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${crypto.randomUUID()}`;
}

async function seedMediaItem(messageId: string, storageKey: string): Promise<void> {
  await db.insert(contentItems).values({
    messageId,
    contentType: 'image',
    storageKey,
    mimeType: 'image/png',
    sizeBytes: 3,
  });
}

async function seedFinancialRows(
  userId: string
): Promise<{ paymentId: string; usageId: string; walletId: string }> {
  const [wallet] = await db
    .insert(wallets)
    .values({ userId, type: 'purchased' })
    .returning({ id: wallets.id });
  const [payment] = await db
    .insert(payments)
    .values({
      userId,
      amountNanoUsd: 5_000_000_000n,
      idempotencyKey: `${PREFIX}-pay-${crypto.randomUUID()}`,
    })
    .returning({ id: payments.id });
  const [usage] = await db
    .insert(usageRecords)
    .values({
      payerUserId: userId,
      runId: crypto.randomUUID(),
      modelId: 'test/model',
      providerName: 'test',
      modality: 'text',
      costNanoUsd: 1000n,
      idempotencyKey: `${PREFIX}-usage-${crypto.randomUUID()}`,
    })
    .returning({ id: usageRecords.id });
  if (!payment || !usage || !wallet) throw new Error('financial seed failed');
  return { paymentId: payment.id, usageId: usage.id, walletId: wallet.id };
}

afterAll(async () => {
  for (const userId of createdUserIds) {
    await db
      .delete(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${userId}`
        )
      );
  }
  await db.delete(accountDeletionEvents).where(like(accountDeletionEvents.userAgent, `${PREFIX}%`));
  await db.delete(payments).where(like(payments.idempotencyKey, `${PREFIX}%`));
  await db.delete(usageRecords).where(like(usageRecords.idempotencyKey, `${PREFIX}%`));
  await db.delete(conversations).where(inArray(conversations.userId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
  await db.$client.end();
});

describe('executeAccountDeletion', () => {
  it('hard-deletes the account in one transaction and reclaims, revokes, and notifies after commit', async () => {
    const account = await seedUser();
    const other = await seedUser();
    const owned = await seedConversation(account.id);
    const foreign = await seedConversation(other.id);
    // Membership + a message in the OTHER user's conversation.
    await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, userId: account.id, visibleFromEpoch: 1 });
    const foreignMessage = await seedMessage(foreign, account.id);
    const ownedMessage = await seedMessage(owned, account.id);
    const keyA = mediaKey();
    const keyB = mediaKey();
    await seedMediaItem(ownedMessage, keyA);
    await seedMediaItem(ownedMessage, keyB);
    const { paymentId, usageId, walletId } = await seedFinancialRows(account.id);
    const args = executorArgs(account.id);

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });

    // The users row and the owned conversation graph are gone.
    expect(await db.select().from(users).where(eq(users.id, account.id))).toHaveLength(0);
    expect(await db.select().from(conversations).where(eq(conversations.id, owned))).toHaveLength(
      0
    );
    expect(await db.select().from(messages).where(eq(messages.id, ownedMessage))).toHaveLength(0);

    // The foreign conversation's message survives, sender detached.
    const [survivor] = await db
      .select({ senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, foreignMessage));
    expect(survivor).toEqual({ senderId: null });

    // Memberships carry leftAt with userId nulled by the FK.
    const memberRows = await db
      .select({ userId: conversationMembers.userId, leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, foreign));
    expect(memberRows.some((row) => row.userId === null && row.leftAt !== null)).toBe(true);

    // Financial rows survive pseudonymized: present, userId severed.
    const [walletRow] = await db
      .select({ userId: wallets.userId })
      .from(wallets)
      .where(eq(wallets.id, walletId));
    expect(walletRow).toEqual({ userId: null });
    const [paymentRow] = await db
      .select({ userId: payments.userId })
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(paymentRow).toEqual({ userId: null });
    const [usageRow] = await db
      .select({ payerUserId: usageRecords.payerUserId })
      .from(usageRecords)
      .where(eq(usageRecords.id, usageId));
    expect(usageRow).toEqual({ payerUserId: null });

    // The anonymous forensic event exists.
    const events = await db
      .select({ ipAddress: accountDeletionEvents.ipAddress })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, args.userAgent));
    expect(events).toEqual([{ ipAddress: '203.0.113.7' }]);

    // The reclaim job carries exactly the owned storage keys, on the bulk shard.
    const jobRows = await db
      .select({ shard: jobs.shard, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.id}`
        )
      );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]?.shard).toBe('bulk');
    const payload = jobRows[0]?.payload as { storageKeys: string[] };
    expect([...payload.storageKeys].toSorted((a, b) => a.localeCompare(b))).toEqual(
      [keyA, keyB].toSorted((a, b) => a.localeCompare(b))
    );

    // Post-commit: watermark written, rooms evicted, notification sent.
    const watermark = await redis.get(IDENTITY_KEYS.passwordChangedAt.buildKey(account.id));
    expect(Number(watermark)).toBe(args.now.getTime());
    expect(evicted).toContain(account.id);
    expect(sentDeleted).toContain(account.email);

    // Scoped cleanup: the pseudonymized wallet row has no user to cascade from.
    await db.delete(wallets).where(eq(wallets.id, walletId));
  });

  it('enqueues no reclaim job for an account without stored media', async () => {
    const account = await seedUser();
    await seedConversation(account.id);

    const outcome = await executeAccountDeletion(executorArgs(account.id));
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });

    const jobRows = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
          sql`${jobs.payload} ->> 'userId' = ${account.id}`
        )
      );
    expect(jobRows).toHaveLength(0);
  });

  it('answers not-found for a user that no longer exists, writing nothing', async () => {
    const ghost = crypto.randomUUID();
    const args = executorArgs(ghost);

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'not-found' });

    const events = await db
      .select({ id: accountDeletionEvents.id })
      .from(accountDeletionEvents)
      .where(eq(accountDeletionEvents.userAgent, args.userAgent));
    expect(events).toHaveLength(0);
    expect(await redis.get(IDENTITY_KEYS.passwordChangedAt.buildKey(ghost))).toBeNull();
  });

  it('leaves NOTHING changed when a step inside the transaction fails', async () => {
    const account = await seedUser();
    const other = await seedUser();
    const foreign = await seedConversation(other.id);
    await db
      .insert(conversationMembers)
      .values({ conversationId: foreign, userId: account.id, visibleFromEpoch: 1 });
    const foreignMessage = await seedMessage(foreign, account.id);
    const args = executorArgs(account.id, {
      detachMessageSendersWithinTx: () => {
        throw new Error('injected failure before the users delete');
      },
    });

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrapErr().code).toBe('unavailable');

    // Atomicity: the user survives, membership still active, sender intact,
    // no event row, no job row, no revocation side effects.
    expect(await db.select().from(users).where(eq(users.id, account.id))).toHaveLength(1);
    const [member] = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, foreign),
          eq(conversationMembers.userId, account.id)
        )
      );
    expect(member?.leftAt).toBeNull();
    const [message] = await db
      .select({ senderId: messages.senderId })
      .from(messages)
      .where(eq(messages.id, foreignMessage));
    expect(message?.senderId).toBe(account.id);
    expect(
      await db
        .select({ id: accountDeletionEvents.id })
        .from(accountDeletionEvents)
        .where(eq(accountDeletionEvents.userAgent, args.userAgent))
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, MEDIA_RECLAIM_USER_JOB_TYPE),
            sql`${jobs.payload} ->> 'userId' = ${account.id}`
          )
        )
    ).toHaveLength(0);
    expect(await redis.get(IDENTITY_KEYS.passwordChangedAt.buildKey(account.id))).toBeNull();
  });

  it('still reports deleted when the notification send fails (best-effort tail)', async () => {
    const account = await seedUser();
    const args = {
      ...executorArgs(account.id),
      accountDeletedEmail: {
        sendAccountDeletedEmail: () => errAsync(unavailableError('email sender down')),
      },
      evictUser: undefined,
    };

    const outcome = await executeAccountDeletion(args);
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'deleted' });
    expect(await db.select().from(users).where(eq(users.id, account.id))).toHaveLength(0);
  });
});
