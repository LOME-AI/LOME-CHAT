import type { ExcludeReason } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Idempotent } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The catalog's soft-delete seam (BILLING.md §Catalog Admission 4). It exists as
 * a port because the write is a conditional `UPDATE … WHERE model_id`, and
 * query operators live only in adapters — while the refresh that decides the
 * verdict is domain code.
 */

export interface CatalogSighting {
  readonly modelId: string;
  /** The refresh clock; becomes the row's `last_seen_at`. */
  readonly seenAt: Date;
  /**
   * The refresh's verdict: a reason marks the row unsellable, `null` clears the
   * mark because the model is admissible again. `admin_disabled_at` is a
   * separate authority and is never touched either way.
   */
  readonly excludedReason: ExcludeReason | null;
}

/**
 * Records that the gateway still advertises a model whose row already exists,
 * carrying the refresh's admission verdict. It only ever UPDATEs, so a model
 * that was never admissible — several exclusion reasons exist precisely because
 * its descriptor is unbuildable — cannot acquire a row through this seam.
 */
export type RecordCatalogSighting = (
  sighting: CatalogSighting
) => ResultAsync<Idempotent<unknown>, DomainError>;
