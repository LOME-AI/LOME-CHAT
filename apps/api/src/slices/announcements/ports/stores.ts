import type { BannerMessage } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The newest `banner_config` row. `messages` is untrusted jsonb (each message
 * carries its own severity variant), salvaged by the domain at read time, so
 * it is surfaced as `unknown`.
 */
export interface BannerConfigRow {
  readonly enabled: boolean;
  readonly messages: unknown;
}

export interface BannerConfigStore {
  /** Newest row wins, so a stray duplicate is deterministic; null when none. */
  readActive(): ResultAsync<BannerConfigRow | null, DomainError>;
  /**
   * Current config read under `FOR UPDATE` on the caller's transaction, so
   * concurrent admin executes serialize and the returned snapshot is exactly
   * what the transaction's write replaces (the undo snapshot). A missing row
   * is the defined empty state `{ enabled: false, messages: [] }`.
   */
  readForUpdateWithinTx(tx: SettlementTx): Promise<BannerConfigRow>;
  /**
   * Replace the config on the caller's transaction, keeping single-row
   * semantics: the newest row is locked and updated when one exists, else a
   * row is inserted (the public read takes the newest row, so a duplicate
   * from concurrent first-ever inserts stays deterministic).
   */
  setWithinTx(
    tx: SettlementTx,
    config: { enabled: boolean; messages: BannerMessage[] }
  ): Promise<void>;
}

export interface BannerDismissalStore {
  /** Whether this user's single stored dismissal matches `hash`. */
  isDismissed(userId: string, hash: string): ResultAsync<boolean, DomainError>;
  /**
   * Single INSERT … ON CONFLICT (user_id): one row per user, latest hash wins.
   * Resolves to the upserted row (the caller ignores it; success is all that matters).
   */
  upsertDismissal(userId: string, hash: string): ResultAsync<unknown, DomainError>;
}

export interface AnnouncementsStores {
  readonly config: BannerConfigStore;
  readonly dismissals: BannerDismissalStore;
}

/** Stores are constructed per request from the pipeline's `c.var.db`. */
export type AnnouncementsStoresFactory = (db: Database) => AnnouncementsStores;
