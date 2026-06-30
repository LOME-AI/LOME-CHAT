import type { Database } from '@hushbox/db';
import type { AccessibilityPreferences } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** A user row resolved to what the invite-search response needs. */
export interface InvitableUserRow {
  readonly id: string;
  readonly username: string;
  readonly publicKey: Uint8Array;
}

export interface UserDirectory {
  /**
   * Authorization read for the search gate: whether `userId` is an ACTIVE
   * member (leftAt IS NULL) of `conversationId`. Without this gate the
   * member-exclusion below is a membership oracle — any session user holding
   * a conversation uuid could probe who is in it.
   */
  isActiveMember(params: {
    readonly conversationId: string;
    readonly userId: string;
  }): ResultAsync<boolean, DomainError>;

  /**
   * Username search for inviting to a conversation. The pattern is a complete
   * ILIKE pattern (already normalized and LIKE-escaped by the domain). The
   * query must exclude `excludeUserId` and every ACTIVE member
   * (leftAt IS NULL) of `conversationId` — a former member is invitable again.
   */
  searchInvitable(params: {
    readonly usernamePattern: string;
    readonly excludeUserId: string;
    readonly conversationId: string;
    readonly limit: number;
  }): ResultAsync<readonly InvitableUserRow[], DomainError>;
}

export interface InstructionsStore {
  read(userId: string): ResultAsync<Uint8Array | null, DomainError>;
  /**
   * Single `INSERT … ON CONFLICT (user_id) DO UPDATE` — the unique constraint
   * is the idempotency guard (`idempotent.byUpsert` contract).
   */
  upsert(userId: string, encryptedInstructions: Uint8Array): ResultAsync<null, DomainError>;
  /** One atomic DELETE; `null` when no row existed (already clear). */
  remove(userId: string): ResultAsync<{ readonly removed: true } | null, DomainError>;
}

export interface StoredAccessibility {
  /** The persisted jsonb blob, unvalidated at this layer. */
  readonly accessibility: unknown;
  readonly updatedAt: Date;
}

export interface PreferencesStore {
  read(userId: string): ResultAsync<StoredAccessibility | null, DomainError>;
  /**
   * Single `INSERT … ON CONFLICT (user_id) DO UPDATE … WHERE stored <= incoming`
   * — the LWW guard lives in the statement, never check-then-act. Resolves to
   * the applied row, or `null` when the guard rejected a stale write.
   */
  upsertIfNewer(
    userId: string,
    accessibility: AccessibilityPreferences,
    updatedAt: Date
  ): ResultAsync<StoredAccessibility | null, DomainError>;
}

export interface AccountStores {
  readonly users: UserDirectory;
  readonly instructions: InstructionsStore;
  readonly preferences: PreferencesStore;
}

/** Stores are constructed per request from the pipeline's `c.var.db`. */
export type AccountStoresFactory = (db: Database) => AccountStores;
