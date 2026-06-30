import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** A user row resolved to what the auth flows need. */
export interface IdentityUserRecord {
  readonly id: string;
  readonly email: string;
  readonly username: string;
  readonly opaqueRegistration: Uint8Array;
  readonly passwordWrappedPrivateKey: Uint8Array;
  readonly totpEnabled: boolean;
  readonly lockedAt: Date | null;
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
}

export interface IdentityStores {
  readonly users: IdentityUsersStore;
}

/** Stores are constructed per request from the pipeline's `c.var.db`. */
export type IdentityStoresFactory = (db: Database) => IdentityStores;
