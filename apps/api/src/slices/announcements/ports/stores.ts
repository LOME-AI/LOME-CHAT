import type { Database } from '@hushbox/db';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The newest `banner_config` row. `messages` is untrusted jsonb (hand-edited),
 * salvaged by the domain at read time, so it is surfaced as `unknown`.
 */
export interface BannerConfigRow {
  readonly enabled: boolean;
  readonly variant: string;
  readonly messages: unknown;
}

export interface BannerConfigStore {
  /** Newest row wins, so a stray duplicate is deterministic; null when none. */
  readActive(): ResultAsync<BannerConfigRow | null, DomainError>;
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
