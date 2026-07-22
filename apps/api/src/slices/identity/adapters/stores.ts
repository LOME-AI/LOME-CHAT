import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { accountDeletionEvents, users, verificationTokens } from '@hushbox/db';
import { isUniqueViolationOn, unavailableError } from '../../../lib/errors/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { SQL } from 'drizzle-orm';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  ConsumeEmailVerificationOutcome,
  DisableTotpOutcome,
  EnableTotpOutcome,
  IdentityStores,
  IdentityUserRecord,
  InsertRegisteredOutcome,
  LockUserOutcome,
  RegistrationValues,
  UnlockUserOutcome,
  UnverifiedUser,
  UserLockReason,
} from '../ports/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
function storeFailure(cause: unknown): DomainError {
  return unavailableError('identity store query failed', cause);
}

const RECORD_COLUMNS = {
  id: users.id,
  email: users.email,
  username: users.username,
  opaqueRegistration: users.opaqueRegistration,
  publicKey: users.publicKey,
  passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
  recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
  totpSecretEncrypted: users.totpSecretEncrypted,
  totpEnabled: users.totpEnabled,
  lockedAt: users.lockedAt,
  emailVerified: users.emailVerified,
  hasAcknowledgedPhrase: users.hasAcknowledgedPhrase,
} as const;

async function insertRegisteredUser(
  db: Database,
  values: RegistrationValues
): Promise<InsertRegisteredOutcome> {
  try {
    await db.insert(users).values({ ...values, emailVerified: false });
    // The caller supplies the uuid primary key, so a non-throwing INSERT
    // created exactly that row.
    return { kind: 'created', userId: values.id };
  } catch (error) {
    // The two discriminable unique violations are expected outcomes (the
    // unique constraint is the duplicate arbiter — byUpsert contract);
    // everything else stays a rejection for the unavailable mapper. Email is
    // checked first, mirroring the within-tx insert's constraint precedence.
    if (isUniqueViolationOn(error, 'users_email_unique')) return { kind: 'email-taken' };
    if (isUniqueViolationOn(error, 'users_username_unique')) return { kind: 'username-taken' };
    throw error;
  }
}

/**
 * The registration INSERT inside a settlement transaction. `ON CONFLICT DO
 * NOTHING` keeps a racing duplicate from poisoning the transaction (a throwing
 * unique violation would abort every sibling write): a conflict returns zero
 * rows, and the two discriminable outcomes are then read back — email first,
 * mirroring the standalone insert's constraint precedence.
 */
async function insertRegisteredUserWithinTx(
  tx: SettlementTx,
  values: RegistrationValues
): Promise<InsertRegisteredOutcome> {
  const inserted = await tx
    .insert(users)
    .values({ ...values, emailVerified: false })
    .onConflictDoNothing()
    .returning({ id: users.id });
  const created = inserted[0];
  if (created !== undefined) return { kind: 'created', userId: created.id };
  const byEmail = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, values.email))
    .limit(1);
  return byEmail.length > 0 ? { kind: 'email-taken' } : { kind: 'username-taken' };
}

async function enableTotpAtomic(
  db: Database,
  userId: string,
  encryptedSecret: Uint8Array
): Promise<EnableTotpOutcome> {
  const updated = await db
    .update(users)
    .set({ totpSecretEncrypted: encryptedSecret, totpEnabled: true })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, false)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'enabled' : 'already-enabled';
}

async function disableTotpAtomic(db: Database, userId: string): Promise<DisableTotpOutcome> {
  const updated = await db
    .update(users)
    .set({ totpSecretEncrypted: null, totpEnabled: false })
    .where(and(eq(users.id, userId), eq(users.totpEnabled, true)))
    .returning({ id: users.id });
  return updated.length > 0 ? 'disabled' : 'not-enabled';
}

/**
 * The deletion executor's opening lock: `SELECT email … FOR UPDATE` on the
 * users row. Serializes racing finishes (the loser blocks, then sees null once
 * the winner's delete commits) and captures the email before the cascade
 * destroys it — the post-commit notification's only source.
 */
async function lockForDeletionTx(
  tx: SettlementTx,
  userId: string
): Promise<{ email: string } | null> {
  const rows = await tx
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  return rows[0] ?? null;
}

/**
 * The chargeback auto-defense lock, run on the webhook's clawback `SettlementTx`
 * so the lock and the ledger clawback commit atomically (a lock failure rolls
 * the clawback back). An atomic conditional UPDATE guarded by `locked_at IS
 * NULL`, so exactly the first delivery flips the row and every later delivery
 * matches zero rows (idempotent — never check-then-act). `locked_at` and
 * `lock_reason` are written together to keep the users-table check constraint
 * (both null or both set) satisfied; `now()` is DB-side so the timestamp is
 * authoritative regardless of the caller's clock. Returns `locked` true with the
 * captured email when this delivery transitioned the row, else `locked` false
 * with a null email — the notification rides only the fresh transition.
 */
async function lockForChargebackWithinTx(
  tx: SettlementTx,
  userId: string
): Promise<{ locked: boolean; email: string | null }> {
  const updated = await tx
    .update(users)
    .set({ lockedAt: sql`now()`, lockReason: 'chargeback' })
    .where(and(eq(users.id, userId), isNull(users.lockedAt)))
    .returning({ email: users.email });
  const row = updated[0];
  return row === undefined ? { locked: false, email: null } : { locked: true, email: row.email };
}

/**
 * The general reason-parameterized lock on the caller's transaction. An atomic
 * conditional UPDATE guarded by `locked_at IS NULL` (never check-then-act);
 * `locked_at` and `lock_reason` are written together to keep the users-table
 * paired-null check constraint satisfied, and `now()` is DB-side so the
 * timestamp is authoritative regardless of the caller's clock. On 0 rows the
 * actual state is read back inside the same transaction to disambiguate: an
 * existing lock is reported as-is (`already-locked` — the original reason and
 * timestamp are never clobbered), a missing row is `not-found`.
 */
async function lockUserTx(
  tx: SettlementTx,
  userId: string,
  reason: UserLockReason
): Promise<LockUserOutcome> {
  const updated = await tx
    .update(users)
    .set({ lockedAt: sql`now()`, lockReason: reason })
    .where(and(eq(users.id, userId), isNull(users.lockedAt)))
    .returning({ id: users.id });
  if (updated.length > 0) return { kind: 'locked' };
  const current = await tx
    .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
    .from(users)
    .where(eq(users.id, userId));
  const row = current[0];
  if (row === undefined) return { kind: 'not-found' };
  if (row.lockedAt === null || row.lockReason === null) {
    // The zero-row UPDATE saw the row locked, but the read-back (a newer
    // READ COMMITTED snapshot) sees it unlocked — a concurrent unlock landed
    // between the two statements, or an invariant broke. Either way the
    // throw fails closed: the transaction rolls back and the caller retries
    // against the settled state.
    throw new Error('lockUserWithinTx: row exists unlocked after a zero-row lock transition');
  }
  return { kind: 'already-locked', lockedAt: row.lockedAt, lockReason: row.lockReason };
}

/**
 * The general unlock on the caller's transaction. `SELECT … FOR UPDATE` (the
 * deletion-lock pattern) captures the prior reason under the row lock — the
 * undo-inverse snapshot the admin engine needs — then clears `locked_at` and
 * `lock_reason` together (the paired-null check constraint forbids clearing
 * one alone). The row lock serializes read-then-clear against concurrent
 * lock/unlock writers, so the returned prior reason is exactly what this
 * transaction cleared. Unlocking an unlocked or unknown user changes nothing.
 */
async function unlockUserTx(tx: SettlementTx, userId: string): Promise<UnlockUserOutcome> {
  const rows = await tx
    .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
    .from(users)
    .where(eq(users.id, userId))
    .for('update');
  const row = rows[0];
  if (row === undefined) return { kind: 'not-found' };
  if (row.lockedAt === null || row.lockReason === null) return { kind: 'not-locked' };
  await tx.update(users).set({ lockedAt: null, lockReason: null }).where(eq(users.id, userId));
  return { kind: 'unlocked', priorLockReason: row.lockReason };
}

async function consumeEmailVerificationTx(
  db: Database,
  token: string,
  now: Date
): Promise<ConsumeEmailVerificationOutcome> {
  return db.transaction(async (tx) => {
    // The DELETE is the single-use arbiter (never check-then-act): concurrent
    // consumers serialize on the token row, and every loser deletes 0 rows —
    // exactly one transaction can answer `verified`.
    const deleted = await tx
      .delete(verificationTokens)
      .where(
        and(
          eq(verificationTokens.token, token),
          eq(verificationTokens.purpose, 'email_verification'),
          gt(verificationTokens.expiresAt, now)
        )
      )
      .returning({ userId: verificationTokens.userId });
    const row = deleted[0];
    if (!row) return { kind: 'invalid' };
    await tx.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId));
    return { kind: 'verified', userId: row.userId };
  });
}

/**
 * Drizzle implementation of the identity stores. Single-writer: the identity
 * slice owns the `users` and `verification_tokens` tables; other slices read
 * them through their own published surfaces.
 */
export function createIdentityStores(db: Database): IdentityStores {
  function findOne(condition: SQL): ResultAsync<IdentityUserRecord | null, DomainError> {
    return fromPromise(
      db.select(RECORD_COLUMNS).from(users).where(condition).limit(1),
      storeFailure
    ).map((rows) => rows[0] ?? null);
  }

  return {
    users: {
      findByEmail: (email) => findOne(eq(users.email, email)),
      findByUsername: (username) => findOne(eq(users.username, username)),
      findById: (userId) => findOne(eq(users.id, userId)),
      insertRegistered: (values) => fromPromise(insertRegisteredUser(db, values), storeFailure),
      insertRegisteredWithinTx: (tx, values) => insertRegisteredUserWithinTx(tx, values),
      enableTotp: (userId, encryptedSecret) =>
        fromPromise(enableTotpAtomic(db, userId, encryptedSecret), storeFailure),
      disableTotp: (userId) => fromPromise(disableTotpAtomic(db, userId), storeFailure),
      rotatePassword: (userId, opaqueRegistration, passwordWrappedPrivateKey) =>
        fromPromise(
          db
            .update(users)
            .set({ opaqueRegistration, passwordWrappedPrivateKey })
            .where(eq(users.id, userId)),
          storeFailure
        ).map((): void => undefined),
      lockForDeletionWithinTx: (tx, userId) => lockForDeletionTx(tx, userId),
      // Anonymous by design: the forensic event never references the user.
      insertDeletionEventWithinTx: async (tx, event) => {
        await tx.insert(accountDeletionEvents).values({
          deletedAt: event.deletedAt,
          ipAddress: event.ipAddress,
          userAgent: event.userAgent,
        });
      },
      deleteUserWithinTx: async (tx, userId) => {
        await tx.delete(users).where(eq(users.id, userId));
      },
      saveRecoveryKey: (userId, recoveryWrappedPrivateKey) =>
        fromPromise(
          db
            .update(users)
            .set({ recoveryWrappedPrivateKey, hasAcknowledgedPhrase: true })
            .where(eq(users.id, userId)),
          storeFailure
        ).map((): void => undefined),
      lockForChargebackWithinTx: (tx, userId) => lockForChargebackWithinTx(tx, userId),
      lockUserWithinTx: (tx, userId, reason) => lockUserTx(tx, userId, reason),
      unlockUserWithinTx: (tx, userId) => unlockUserTx(tx, userId),
    },
    verification: {
      issueEmailVerification: (userId, token, expiresAt) =>
        fromPromise(
          db
            .insert(verificationTokens)
            .values({ userId, token, purpose: 'email_verification', expiresAt }),
          storeFailure
        ).map((): void => undefined),
      issueVerificationDecoy: (token) =>
        // A DELETE against the fresh random token matches 0 rows by
        // construction — a single indexed write-path round-trip mirroring the
        // issue INSERT's cost without touching any state.
        fromPromise(
          db.delete(verificationTokens).where(eq(verificationTokens.token, token)),
          storeFailure
        ).map((): void => undefined),
      consumeEmailVerification: (token, now) =>
        fromPromise(consumeEmailVerificationTx(db, token, now), storeFailure),
      findUnverifiedByEmail: (email): ResultAsync<UnverifiedUser | null, DomainError> =>
        fromPromise(
          db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(and(eq(users.email, email), eq(users.emailVerified, false)))
            .limit(1),
          storeFailure
        ).map((rows) => rows[0] ?? null),
      findLatestVerificationToken: (email, now) =>
        fromPromise(
          db
            .select({ token: verificationTokens.token })
            .from(verificationTokens)
            .innerJoin(users, eq(verificationTokens.userId, users.id))
            .where(
              and(
                eq(users.email, email),
                eq(verificationTokens.purpose, 'email_verification'),
                gt(verificationTokens.expiresAt, now)
              )
            )
            .orderBy(desc(verificationTokens.createdAt))
            .limit(1),
          storeFailure
        ).map((rows) => rows[0]?.token ?? null),
    },
  };
}
