import { eq, isNull, and } from 'drizzle-orm';
import { jobs, sharedLinks, users } from '@hushbox/db';
import { MEDIA_RECLAIM_USER_JOB_TYPE } from '../../slices/media/index.js';
import { DevSeedError } from './factories.js';
import type { Database } from '@hushbox/db';

/**
 * Dev-seed states for the admin plane's op targets, so every registered op
 * is exercisable end-to-end against a locally seeded DB: `user.unlock` (a
 * chargeback-locked user), `job.redrive` (a dead job), `job.restore` (a
 * discarded job), `share.unrevoke` (a revoked share) — plus the negative
 * wallet `setWalletBalance` seeds separately for `wallet.credit`.
 * Idempotent: fixed ids + conflict-skipping inserts, lock applied only when
 * absent. Every state is verified by query before returning — a seed run
 * that cannot produce its states fails loudly.
 */

const ADMIN_TARGET_DEAD_JOB_ID = '00000000-0000-4000-8000-00000000ad01';
const ADMIN_TARGET_DISCARDED_JOB_ID = '00000000-0000-4000-8000-00000000ad02';
const ADMIN_TARGET_REVOKED_SHARE_ID = '00000000-0000-4000-8000-00000000ad03';

/** 32-byte deterministic key so the unique `link_public_key` upserts cleanly. */
const REVOKED_SHARE_LINK_PUBLIC_KEY = new TextEncoder().encode(
  'admin-target-revoked-share-key!!'.padEnd(32, '!').slice(0, 32)
);

export interface SeedAdminTargetsParams {
  /** Existing seeded user to place in the chargeback-locked state. */
  readonly lockedUserEmail: string;
  /** Existing seeded conversation the revoked share hangs off. */
  readonly conversationId: string;
}

export interface SeedAdminTargetsSummary {
  readonly lockedUserId: string;
  readonly deadJobId: string;
  readonly discardedJobId: string;
  readonly revokedShareId: string;
}

/** Mirrors the media-reclaim registration (failures exhausted → dead). */
function deadJobValues(userId: string, id: string): typeof jobs.$inferInsert {
  return {
    id,
    type: MEDIA_RECLAIM_USER_JOB_TYPE,
    shard: 'bulk',
    // A legal payload by the registered schema: a redrive must be able to
    // succeed (empty key list = the idempotent no-op).
    payload: { userId, storageKeys: [] },
    status: 'dead',
    claims: 8,
    maxClaims: 10,
    failures: 8,
    maxFailures: 8,
    leaseSeconds: 300,
    errors: [
      {
        at: new Date().toISOString(),
        claim: 8,
        error: 'seeded dead job (admin op target)',
      },
    ],
    finishedAt: new Date(),
  };
}

export async function seedAdminOpTargets(
  db: Database,
  params: SeedAdminTargetsParams
): Promise<SeedAdminTargetsSummary> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, params.lockedUserEmail.toLowerCase()));
  if (user === undefined) {
    throw new DevSeedError(`seed admin targets: user not found: ${params.lockedUserEmail}`);
  }

  // Chargeback lock, applied only when unlocked (re-runs keep the original
  // lockedAt; the paired-nullability check constraint stays satisfied).
  await db
    .update(users)
    .set({ lockedAt: new Date(), lockReason: 'chargeback' })
    .where(and(eq(users.id, user.id), isNull(users.lockedAt)));

  await db
    .insert(jobs)
    .values(deadJobValues(user.id, ADMIN_TARGET_DEAD_JOB_ID))
    .onConflictDoNothing({ target: jobs.id });
  await db
    .insert(jobs)
    .values({
      ...deadJobValues(user.id, ADMIN_TARGET_DISCARDED_JOB_ID),
      discardedAt: new Date(),
    })
    .onConflictDoNothing({ target: jobs.id });

  await db
    .insert(sharedLinks)
    .values({
      id: ADMIN_TARGET_REVOKED_SHARE_ID,
      conversationId: params.conversationId,
      linkPublicKey: REVOKED_SHARE_LINK_PUBLIC_KEY,
      displayName: 'Seeded revoked share (admin op target)',
      revokedAt: new Date(),
    })
    // Clean upsert: a stale row from an earlier seed (or a reset dev DB
    // state) re-points at the current conversation instead of dangling.
    .onConflictDoUpdate({
      target: sharedLinks.id,
      set: { conversationId: params.conversationId, revokedAt: new Date() },
    });

  await verifySeededStates(db, user.id);
  return {
    lockedUserId: user.id,
    deadJobId: ADMIN_TARGET_DEAD_JOB_ID,
    discardedJobId: ADMIN_TARGET_DISCARDED_JOB_ID,
    revokedShareId: ADMIN_TARGET_REVOKED_SHARE_ID,
  };
}

function assertState(present: boolean, state: string): void {
  if (!present) {
    throw new DevSeedError(`seed admin targets: ${state} state missing after seed`);
  }
}

async function jobState(
  db: Database,
  id: string
): Promise<{ status: string; discardedAt: Date | null } | undefined> {
  const [row] = await db
    .select({ status: jobs.status, discardedAt: jobs.discardedAt })
    .from(jobs)
    .where(eq(jobs.id, id));
  return row;
}

/** The scripted post-seed assertion: every op-target state must exist. */
async function verifySeededStates(db: Database, lockedUserId: string): Promise<void> {
  const [locked] = await db
    .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
    .from(users)
    .where(eq(users.id, lockedUserId));
  assertState(locked?.lockedAt != null && locked.lockReason === 'chargeback', 'chargeback lock');
  const dead = await jobState(db, ADMIN_TARGET_DEAD_JOB_ID);
  assertState(dead?.status === 'dead' && dead.discardedAt === null, 'dead job');
  const discarded = await jobState(db, ADMIN_TARGET_DISCARDED_JOB_ID);
  assertState(discarded?.status === 'dead' && discarded.discardedAt !== null, 'discarded job');
  const [share] = await db
    .select({ revokedAt: sharedLinks.revokedAt })
    .from(sharedLinks)
    .where(eq(sharedLinks.id, ADMIN_TARGET_REVOKED_SHARE_ID));
  assertState(share?.revokedAt != null, 'revoked share');
}
