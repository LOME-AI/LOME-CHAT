import type { Database, userLockReasonEnum } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** A user row resolved to what the auth flows need. */
export interface IdentityUserRecord {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly opaqueRegistration: Uint8Array;
  /** The X25519 account public key clients wrap content to. */
  readonly publicKey: Uint8Array;
  readonly passwordWrappedPrivateKey: Uint8Array;
  readonly recoveryWrappedPrivateKey: Uint8Array;
  /** Null until TOTP enrollment is confirmed. */
  readonly totpSecretEncrypted: Uint8Array | null;
  readonly totpEnabled: boolean;
  readonly lockedAt: Date | null;
  /** False until the email-verification token is consumed; gates login. */
  readonly emailVerified: boolean;
  /** True once the user has saved their recovery phrase (one-shot flag). */
  readonly hasAcknowledgedPhrase: boolean;
}

export interface RegistrationValues {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly opaqueRegistration: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly passwordWrappedPrivateKey: Uint8Array;
  readonly recoveryWrappedPrivateKey: Uint8Array;
}

/**
 * The two discriminable unique violations surface as values (the signup UI
 * renders them); any other failure is the error channel.
 */
export type InsertRegisteredOutcome =
  | { readonly kind: 'created'; readonly userId: string }
  | { readonly kind: 'email-taken' }
  | { readonly kind: 'username-taken' };

/** Why a user account is locked — derived from the `user_lock_reason` pgEnum. */
export type UserLockReason = (typeof userLockReasonEnum.enumValues)[number];

/**
 * Outcome of the general lock transition. `already-locked` reports the
 * standing lock (original reason + timestamp) so a caller can surface or
 * snapshot it — the row is never re-written, preserving the first lock's
 * reason and time (already-done is a no-op).
 */
export type LockUserOutcome =
  | { readonly kind: 'locked' }
  | {
      readonly kind: 'already-locked';
      readonly lockedAt: Date;
      readonly lockReason: UserLockReason;
    }
  | { readonly kind: 'not-found' };

/**
 * Outcome of the general unlock transition. `unlocked` carries the prior
 * reason — the admin engine snapshots it as the undo inverse's input, so a
 * chargeback lock undone-and-redone restores `chargeback`, never a default.
 */
export type UnlockUserOutcome =
  | { readonly kind: 'unlocked'; readonly priorLockReason: UserLockReason }
  | { readonly kind: 'not-locked' }
  | { readonly kind: 'not-found' };

/** Outcome of an atomic conditional TOTP-enable transition. */
export type EnableTotpOutcome = 'enabled' | 'already-enabled';
/** Outcome of an atomic conditional TOTP-disable transition. */
export type DisableTotpOutcome = 'disabled' | 'not-enabled';

export interface IdentityUsersStore {
  /** Lookup by already-lowercased email. */
  findByEmail(email: string): ResultAsync<IdentityUserRecord | null, DomainError>;
  /** Lookup by already-normalized username. */
  findByUsername(username: string): ResultAsync<IdentityUserRecord | null, DomainError>;
  findById(userId: string): ResultAsync<IdentityUserRecord | null, DomainError>;
  /**
   * Single INSERT whose unique constraints (email, username) are the
   * idempotency guard — the database arbitrates duplicates
   * (`idempotent.byUpsert` contract). Inserts with `emailVerified: false`.
   */
  insertRegistered(values: RegistrationValues): ResultAsync<InsertRegisteredOutcome, DomainError>;
  /**
   * The registration INSERT composed INSIDE a settlement transaction, so the
   * new user row and its wallets + welcome credit commit atomically (a crash
   * leaves neither). Uses `ON CONFLICT DO NOTHING` — never a throwing insert —
   * so a racing duplicate resolves to `email-taken` / `username-taken` as a
   * value without poisoning the transaction; the caller rolls back by simply
   * not provisioning when the outcome is not `created`. Inserts unverified.
   */
  insertRegisteredWithinTx(
    tx: SettlementTx,
    values: RegistrationValues
  ): Promise<InsertRegisteredOutcome>;
  /**
   * Atomic conditional enable (`… WHERE totp_enabled = false`): 0 rows means
   * TOTP was already enabled — never check-then-act.
   */
  enableTotp(
    userId: string,
    encryptedSecret: Uint8Array
  ): ResultAsync<EnableTotpOutcome, DomainError>;
  /** Atomic conditional disable (`… WHERE totp_enabled = true`). */
  disableTotp(userId: string): ResultAsync<DisableTotpOutcome, DomainError>;
  /** Rewrites the OPAQUE record + password-wrapped key in one UPDATE. */
  rotatePassword(
    userId: string,
    opaqueRegistration: Uint8Array,
    passwordWrappedPrivateKey: Uint8Array
  ): ResultAsync<void, DomainError>;
  /**
   * The deletion executor's opening lock: `SELECT email … FOR UPDATE` on the
   * users row. Serializes racing finishes (the loser sees null once the
   * winner's delete commits) and captures the email before the cascade
   * destroys it. Throws on infra failure — inside the deletion transaction a
   * throw aborts the whole commit.
   */
  lockForDeletionWithinTx(
    tx: SettlementTx,
    userId: string
  ): Promise<{ readonly email: string } | null>;
  /**
   * The anonymous forensic deletion event (deletedAt/ipAddress/userAgent —
   * deliberately no user reference), committed with the delete it records.
   */
  insertDeletionEventWithinTx(
    tx: SettlementTx,
    event: {
      readonly deletedAt: Date;
      readonly ipAddress: string | null;
      readonly userAgent: string | null;
    }
  ): Promise<void>;
  /** The hard delete; the FK graph cascades/pseudonymizes everything else. */
  deleteUserWithinTx(tx: SettlementTx, userId: string): Promise<void>;
  /**
   * Persists a client-rewrapped recovery key and flags phrase acknowledgement
   * in one convergent UPDATE — repeats reach the same end state (idempotent).
   */
  saveRecoveryKey(
    userId: string,
    recoveryWrappedPrivateKey: Uint8Array
  ): ResultAsync<void, DomainError>;
  /**
   * The chargeback auto-defense lock, composed INSIDE the webhook's clawback
   * settlement transaction so the ledger clawback and the lock commit
   * atomically — a lock failure rolls the clawback back, and the provider's
   * redelivery re-drives both together (no money-reversed-but-not-locked
   * divergence). An atomic conditional
   * `UPDATE users SET locked_at = now(), lock_reason = 'chargeback'
   * WHERE id = ? AND locked_at IS NULL RETURNING email` on the caller's `tx`.
   * Never check-then-act — the `locked_at IS NULL` predicate is the guard, so
   * exactly the first delivery transitions: `locked` is true (with the captured
   * email) only for that delivery, and false with a null email when the account
   * was already locked or the id is unknown (the email rides the transition
   * only, since the best-effort lock notification fires only on a fresh lock).
   * `locked_at` and `lock_reason` are set together to satisfy the users-table
   * check constraint tying their nullness. Throws on infra failure — inside the
   * settlement transaction a throw aborts the whole commit.
   */
  lockForChargebackWithinTx(
    tx: SettlementTx,
    userId: string
  ): Promise<{ readonly locked: boolean; readonly email: string | null }>;
  /**
   * The general reason-parameterized lock, composed inside the caller's
   * transaction (the admin slice's operations engine is the intended composer
   * — `users` is identity's table, single-writer). An atomic conditional
   * `UPDATE … WHERE id = ? AND locked_at IS NULL` (never check-then-act);
   * `locked_at` and `lock_reason` are written together to satisfy the
   * users-table paired-null check constraint. On 0 rows the actual state is
   * read back to disambiguate `already-locked` (the standing lock is reported,
   * never clobbered) from `not-found`. Throws on infra failure — inside the
   * settlement transaction a throw aborts the whole commit.
   */
  lockUserWithinTx(
    tx: SettlementTx,
    userId: string,
    reason: UserLockReason
  ): Promise<LockUserOutcome>;
  /**
   * The general unlock, composed inside the caller's transaction. Takes the
   * row lock (`SELECT … FOR UPDATE`, the deletion-lock pattern) to read the
   * prior reason, then clears `locked_at` and `lock_reason` together (the
   * paired-null check constraint forbids clearing one alone) — the row lock
   * makes read-then-clear atomic against concurrent lock/unlock writers.
   * Returns the prior reason on a fresh unlock (the undo-inverse snapshot);
   * `not-locked` / `not-found` are idempotent no-ops. Throws on infra failure.
   */
  unlockUserWithinTx(tx: SettlementTx, userId: string): Promise<UnlockUserOutcome>;
}

/** Result of consuming an email-verification token. */
export type ConsumeEmailVerificationOutcome =
  | { readonly kind: 'verified'; readonly userId: string }
  | { readonly kind: 'invalid' };

/** The unverified account a resend targets. */
export interface UnverifiedUser {
  readonly id: string;
  readonly username: string;
}

export interface IdentityVerificationStore {
  /** Inserts a fresh single-use email-verification token. */
  issueEmailVerification(
    userId: string,
    token: string,
    expiresAt: Date
  ): ResultAsync<void, DomainError>;
  /**
   * Enumeration decoy: one write-shaped database round-trip of comparable
   * cost to `issueEmailVerification` that changes nothing. The resend flow
   * runs it for an unknown (or already-verified) email so its timing mirrors
   * the known-unverified path instead of returning early.
   */
  issueVerificationDecoy(token: string): ResultAsync<void, DomainError>;
  /**
   * Consumes a token and flips `emailVerified` in ONE transaction: an unexpired
   * `email_verification` token deletes itself and verifies its user; a missing
   * or expired token is `invalid`. Single-use — a replay finds nothing.
   */
  consumeEmailVerification(
    token: string,
    now: Date
  ): ResultAsync<ConsumeEmailVerificationOutcome, DomainError>;
  /** The unverified account for an email, or null (verified or unknown). */
  findUnverifiedByEmail(email: string): ResultAsync<UnverifiedUser | null, DomainError>;
  /**
   * DEV-ONLY: the newest live email-verification token for an email, so a
   * local signup can be completed without a real inbox. Never reachable in
   * production (the route's `dev-only` class 404s there).
   */
  findLatestVerificationToken(email: string, now: Date): ResultAsync<string | null, DomainError>;
}

export interface IdentityStores {
  readonly users: IdentityUsersStore;
  readonly verification: IdentityVerificationStore;
}

/** Stores are constructed per request from the pipeline's `c.var.db`. */
export type IdentityStoresFactory = (db: Database) => IdentityStores;
