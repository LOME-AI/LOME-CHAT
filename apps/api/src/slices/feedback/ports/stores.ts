import type { FeedbackKind } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/** The validated submission the composer sends (kind + trimmed body). */
export interface FeedbackSubmission {
  readonly kind: FeedbackKind;
  readonly body: string;
}

/**
 * The feedback slice's single-writer store over the `feedback` table. Only
 * `insert` lives here; the status transition rides a `SettlementTx` (the admin
 * `feedback.setStatus` op composes it) and the reads take a plain `db`, so both
 * are standalone barrel functions rather than store methods.
 */
export interface FeedbackStore {
  /**
   * One conditional INSERT … RETURNING id; the row defaults `status='new'`.
   * The insert is suppressed (resolves `null`) when an identical body already
   * exists for this user inside the recent dedup window — the domain turns that
   * `null` into a `FEEDBACK_DUPLICATE` refusal. A fresh id means the note landed.
   */
  insert(
    userId: string,
    input: FeedbackSubmission
  ): ResultAsync<{ readonly id: string } | null, DomainError>;
}

/** Stores are constructed per call from the pipeline's `c.var.db` or a byKey tx. */
export type FeedbackStoresFactory = (db: DbWriter) => FeedbackStore;
