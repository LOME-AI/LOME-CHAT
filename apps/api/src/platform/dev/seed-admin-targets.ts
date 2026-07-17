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
 *
 * The parameterized helpers below also back the `POST /dev/admin-targets`
 * route (`mint-admin-targets.ts`), which mints the same states under fresh
 * ids per call so parallel E2E specs never race over the fixed set.
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

/**
 * Chargeback lock, applied only when unlocked (re-runs keep the original
 * lockedAt; the paired-nullability check constraint stays satisfied).
 */
export async function applyChargebackLock(db: Database, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ lockedAt: new Date(), lockReason: 'chargeback' })
    .where(and(eq(users.id, userId), isNull(users.lockedAt)));
}

export interface AdminTargetJobParams {
  readonly id: string;
  /** Rides the job payload only; never dereferenced by the dead-job state. */
  readonly payloadUserId: string;
  readonly discarded: boolean;
}

/** A dead (optionally discarded) job row; an existing id is left standing. */
export async function insertAdminTargetJob(
  db: Database,
  params: AdminTargetJobParams
): Promise<void> {
  await db
    .insert(jobs)
    .values({
      ...deadJobValues(params.payloadUserId, params.id),
      ...(params.discarded ? { discardedAt: new Date() } : {}),
    })
    .onConflictDoNothing({ target: jobs.id });
}

export interface AdminTargetRevokedShareParams {
  readonly id: string;
  readonly conversationId: string;
  /** Must be unique per row (`link_public_key` unique constraint). */
  readonly linkPublicKey: Uint8Array;
}

/**
 * A revoked shared link. Clean upsert: a stale row from an earlier seed (or
 * a reset dev DB state) re-points at the current conversation instead of
 * dangling; fresh-id callers never hit the conflict.
 */
export async function insertAdminTargetRevokedShare(
  db: Database,
  params: AdminTargetRevokedShareParams
): Promise<void> {
  await db
    .insert(sharedLinks)
    .values({
      id: params.id,
      conversationId: params.conversationId,
      linkPublicKey: params.linkPublicKey,
      displayName: 'Seeded revoked share (admin op target)',
      revokedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sharedLinks.id,
      set: { conversationId: params.conversationId, revokedAt: new Date() },
    });
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

  await applyChargebackLock(db, user.id);
  await insertAdminTargetJob(db, {
    id: ADMIN_TARGET_DEAD_JOB_ID,
    payloadUserId: user.id,
    discarded: false,
  });
  await insertAdminTargetJob(db, {
    id: ADMIN_TARGET_DISCARDED_JOB_ID,
    payloadUserId: user.id,
    discarded: true,
  });
  await insertAdminTargetRevokedShare(db, {
    id: ADMIN_TARGET_REVOKED_SHARE_ID,
    conversationId: params.conversationId,
    linkPublicKey: REVOKED_SHARE_LINK_PUBLIC_KEY,
  });

  await verifyChargebackLock(db, user.id);
  await verifyAdminTargetJob(db, ADMIN_TARGET_DEAD_JOB_ID, false);
  await verifyAdminTargetJob(db, ADMIN_TARGET_DISCARDED_JOB_ID, true);
  await verifyAdminTargetRevokedShare(db, ADMIN_TARGET_REVOKED_SHARE_ID);
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

/** Post-seed assertion: the target user is chargeback-locked. */
export async function verifyChargebackLock(db: Database, userId: string): Promise<void> {
  const [locked] = await db
    .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
    .from(users)
    .where(eq(users.id, userId));
  assertState(locked?.lockedAt != null && locked.lockReason === 'chargeback', 'chargeback lock');
}

/** Post-seed assertion: the job row is dead, with the expected disposition. */
export async function verifyAdminTargetJob(
  db: Database,
  id: string,
  discarded: boolean
): Promise<void> {
  const [row] = await db
    .select({ status: jobs.status, discardedAt: jobs.discardedAt })
    .from(jobs)
    .where(eq(jobs.id, id));
  const disposition = discarded ? row?.discardedAt !== null : row?.discardedAt === null;
  assertState(row?.status === 'dead' && disposition, discarded ? 'discarded job' : 'dead job');
}

/** Post-seed assertion: the shared link is revoked. */
export async function verifyAdminTargetRevokedShare(db: Database, id: string): Promise<void> {
  const [share] = await db
    .select({ revokedAt: sharedLinks.revokedAt })
    .from(sharedLinks)
    .where(eq(sharedLinks.id, id));
  assertState(share?.revokedAt != null, 'revoked share');
}
