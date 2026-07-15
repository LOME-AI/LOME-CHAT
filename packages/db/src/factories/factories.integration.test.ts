import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';

import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '../client';
import { conversations, jobs, sharedLinks, users, wallets } from '../schema/index';
import { placeholderBytes } from './helpers';
import { userFactory, lockedUserFactory } from './user';
import { walletFactory, negativeBalanceWalletFactory } from './wallet';
import { jobFactory, deadJobFactory, discardedJobFactory } from './job';
import { sharedLinkFactory, revokedSharedLinkFactory } from './shared-link';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for integration tests');
}

let db: Database;
const userIds: string[] = [];
const jobIds: string[] = [];

beforeAll(() => {
  db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
});

afterAll(async () => {
  // Users cascade conversations → shared links; wallets SET NULL.
  if (jobIds.length > 0) await db.delete(jobs).where(inArray(jobs.id, jobIds));
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  await db.$client.end();
});

async function insertUser(locked = false): Promise<string> {
  const built = locked ? lockedUserFactory.build() : userFactory.build();
  const [row] = await db.insert(users).values(built).returning({ id: users.id });
  if (!row) throw new Error('user insert returned no row');
  userIds.push(row.id);
  return row.id;
}

describe('non-legacy factories insert valid rows', () => {
  it('user + locked user', async () => {
    await insertUser();
    const lockedId = await insertUser(true);
    const [row] = await db
      .select()
      .from(users)
      .where(inArray(users.id, [lockedId]));
    expect(row?.lockedAt).toBeInstanceOf(Date);
    expect(row?.lockReason).toBe('admin');
  });

  it('wallet + negative-balance wallet', async () => {
    const userId = await insertUser();
    const [wallet] = await db.insert(wallets).values(walletFactory.build({ userId })).returning();
    expect(wallet?.balanceNanoUsd).toBe(0n);

    const [negative] = await db
      .insert(wallets)
      .values(negativeBalanceWalletFactory.build({ userId, type: 'free' }))
      .returning();
    expect(negative?.balanceNanoUsd ?? 0n).toBeLessThan(0n);
  });

  it('job + dead job + discarded job', async () => {
    // 'bulk' shard so a concurrently running dispatcher pass never claims
    // the pending row (the jobs-test shard convention).
    const rows = await db
      .insert(jobs)
      .values([
        jobFactory.build({ shard: 'bulk' }),
        deadJobFactory.build({ shard: 'bulk' }),
        discardedJobFactory.build({ shard: 'bulk' }),
      ])
      .returning();
    expect(rows).toHaveLength(3);
    for (const row of rows) jobIds.push(row.id);
    expect(rows.map((row) => row.status).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'dead',
      'dead',
      'pending',
    ]);
    expect(rows.filter((row) => row.discardedAt !== null)).toHaveLength(1);
  });

  it('shared link + revoked shared link', async () => {
    const userId = await insertUser();
    const [conversation] = await db
      .insert(conversations)
      .values({ userId, title: placeholderBytes(16) })
      .returning({ id: conversations.id });
    if (!conversation) throw new Error('conversation insert returned no row');

    const inserted = await db
      .insert(sharedLinks)
      .values([
        sharedLinkFactory.build({ conversationId: conversation.id }),
        revokedSharedLinkFactory.build({ conversationId: conversation.id }),
      ])
      .returning();
    expect(inserted).toHaveLength(2);
    expect(inserted.filter((row) => row.revokedAt !== null)).toHaveLength(1);
  });
});
