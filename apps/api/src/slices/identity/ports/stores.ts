import type { Database } from '@hushbox/db';
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
   * Atomic deletion-request marker (`… WHERE deletion_requested_at IS NULL`):
   * resolves the id when it flips, null when a request was already pending.
   */
  requestDeletion(userId: string): ResultAsync<string | null, DomainError>;
  /**
   * Persists a client-rewrapped recovery key and flags phrase acknowledgement
   * in one convergent UPDATE — repeats reach the same end state (idempotent).
   */
  saveRecoveryKey(
    userId: string,
    recoveryWrappedPrivateKey: Uint8Array
  ): ResultAsync<void, DomainError>;
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
