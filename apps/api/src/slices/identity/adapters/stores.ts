import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { users, verificationTokens } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
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
  RegistrationValues,
  UnverifiedUser,
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
  passwordWrappedPrivateKey: users.passwordWrappedPrivateKey,
  recoveryWrappedPrivateKey: users.recoveryWrappedPrivateKey,
  totpSecretEncrypted: users.totpSecretEncrypted,
  totpEnabled: users.totpEnabled,
  lockedAt: users.lockedAt,
  emailVerified: users.emailVerified,
} as const;

/**
 * Walks an insert rejection (drivers nest the Postgres error under `cause`)
 * for a unique violation (SQLSTATE 23505) and returns the constraint name.
 */
function uniqueViolationConstraint(error: unknown): string | null {
  let current: unknown = error;
  while (typeof current === 'object' && current !== null) {
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === '23505' && typeof candidate.constraint === 'string') {
      return candidate.constraint;
    }
    current = candidate.cause;
  }
  return null;
}

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
    // everything else stays a rejection for the unavailable mapper.
    const constraint = uniqueViolationConstraint(error);
    if (constraint === 'users_email_unique') return { kind: 'email-taken' };
    if (constraint === 'users_username_unique') return { kind: 'username-taken' };
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

async function requestDeletionAtomic(db: Database, userId: string): Promise<string | null> {
  const updated = await db
    .update(users)
    .set({ deletionRequestedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.deletionRequestedAt)))
    .returning({ id: users.id });
  return updated[0]?.id ?? null;
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
      requestDeletion: (userId) => fromPromise(requestDeletionAtomic(db, userId), storeFailure),
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
