import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
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
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../../slices/media/index.js';
import { mintAdminTargets } from './mint-admin-targets.js';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for mint-admin-targets integration tests`);
  }
  return value;
}

const db = createDb(requiredEnv('DATABASE_URL'), { neonDev: LOCAL_NEON_DEV_CONFIG });

const mintedUserIds: string[] = [];
const mintedJobIds: string[] = [];

function track(minted: {
  lockedUser?: { userId: string };
  deadJob?: { jobId: string };
  discardedJob?: { jobId: string };
  revokedShare?: { linkId: string; conversationId: string };
}): void {
  if (minted.lockedUser !== undefined) mintedUserIds.push(minted.lockedUser.userId);
  if (minted.deadJob !== undefined) mintedJobIds.push(minted.deadJob.jobId);
  if (minted.discardedJob !== undefined) mintedJobIds.push(minted.discardedJob.jobId);
}

/** The revoked share's fresh owner is discoverable only via the conversation. */
async function trackShareOwner(conversationId: string): Promise<string> {
  const [row] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (row?.userId == null) throw new Error('minted share conversation has no owner');
  mintedUserIds.push(row.userId);
  return row.userId;
}

/** Narrows an all-kinds mint to non-optional targets (fails loudly if any is absent). */
function requireAllKinds(minted: Awaited<ReturnType<typeof mintAdminTargets>>): {
  lockedUser: { userId: string; email: string };
  deadJob: { jobId: string };
  discardedJob: { jobId: string };
  revokedShare: { linkId: string; conversationId: string };
} {
  const { lockedUser, deadJob, discardedJob, revokedShare } = minted;
  if (
    lockedUser === undefined ||
    deadJob === undefined ||
    discardedJob === undefined ||
    revokedShare === undefined
  ) {
    throw new Error('all-kinds mint returned an incomplete target set');
  }
  return { lockedUser, deadJob, discardedJob, revokedShare };
}

afterAll(async () => {
  if (mintedJobIds.length > 0) {
    await db.delete(jobs).where(inArray(jobs.id, mintedJobIds));
  }
  if (mintedUserIds.length > 0) {
    // Both welcome-credit legs (user + house) delete together so each
    // transaction stays zero-sum under the ledger balance trigger.
    const welcomeKeys = mintedUserIds.flatMap((id) => [
      `welcome:${id}:user`,
      `welcome:${id}:house`,
    ]);
    await db.delete(ledgerEntries).where(inArray(ledgerEntries.idempotencyKey, welcomeKeys));
    await db.delete(wallets).where(inArray(wallets.userId, mintedUserIds));
    // Conversations first (cascades shares/members/epochs), then the users.
    await db.delete(conversations).where(inArray(conversations.userId, mintedUserIds));
    await db.delete(users).where(inArray(users.id, mintedUserIds));
  }
  await db.$client.end();
});

describe('mintAdminTargets', () => {
  it('mints a fresh chargeback-locked user with registered wallets', async () => {
    const minted = await mintAdminTargets(db, ['lockedUser']);
    track(minted);

    expect(minted.lockedUser).toBeDefined();
    const lockedUser = minted.lockedUser;
    if (lockedUser === undefined) throw new Error('lockedUser missing');

    const [row] = await db.select().from(users).where(eq(users.id, lockedUser.userId));
    expect(row?.email).toBe(lockedUser.email);
    expect(row?.lockedAt).not.toBeNull();
    expect(row?.lockReason).toBe('chargeback');

    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, lockedUser.userId));
    expect(walletRows).toHaveLength(2);
  });

  it('mints a fresh dead job in the redrivable state', async () => {
    const minted = await mintAdminTargets(db, ['deadJob']);
    track(minted);

    const jobId = minted.deadJob?.jobId;
    if (jobId === undefined) throw new Error('deadJob missing');
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row?.type).toBe(MEDIA_RECLAIM_USER_JOB_TYPE);
    expect(row?.status).toBe('dead');
    expect(row?.discardedAt).toBeNull();
  });

  it('mints a fresh discarded job', async () => {
    const minted = await mintAdminTargets(db, ['discardedJob']);
    track(minted);

    const jobId = minted.discardedJob?.jobId;
    if (jobId === undefined) throw new Error('discardedJob missing');
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(row?.status).toBe('dead');
    expect(row?.discardedAt).not.toBeNull();
  });

  it('mints a fresh revoked share on a fresh conversation', async () => {
    const minted = await mintAdminTargets(db, ['revokedShare']);

    const share = minted.revokedShare;
    if (share === undefined) throw new Error('revokedShare missing');
    await trackShareOwner(share.conversationId);

    const [row] = await db.select().from(sharedLinks).where(eq(sharedLinks.id, share.linkId));
    expect(row?.conversationId).toBe(share.conversationId);
    expect(row?.revokedAt).not.toBeNull();
  });

  it('mints only the requested kinds', async () => {
    const minted = await mintAdminTargets(db, ['deadJob']);
    track(minted);

    expect(minted.deadJob).toBeDefined();
    expect(minted.lockedUser).toBeUndefined();
    expect(minted.discardedJob).toBeUndefined();
    expect(minted.revokedShare).toBeUndefined();
  });

  it('mints distinct ids on every call', async () => {
    const kinds = ['lockedUser', 'deadJob', 'discardedJob', 'revokedShare'] as const;
    const first = requireAllKinds(await mintAdminTargets(db, kinds));
    const second = requireAllKinds(await mintAdminTargets(db, kinds));
    track(first);
    track(second);
    await trackShareOwner(first.revokedShare.conversationId);
    await trackShareOwner(second.revokedShare.conversationId);

    expect(first.lockedUser.userId).not.toBe(second.lockedUser.userId);
    expect(first.lockedUser.email).not.toBe(second.lockedUser.email);
    expect(first.deadJob.jobId).not.toBe(second.deadJob.jobId);
    expect(first.discardedJob.jobId).not.toBe(second.discardedJob.jobId);
    expect(first.revokedShare.linkId).not.toBe(second.revokedShare.linkId);
    expect(first.revokedShare.conversationId).not.toBe(second.revokedShare.conversationId);
  });
});
