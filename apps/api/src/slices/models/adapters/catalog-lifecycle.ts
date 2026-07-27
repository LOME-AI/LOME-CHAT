import { eq, sql } from 'drizzle-orm';
import { modelCatalog } from '@hushbox/db';
import { unavailableError } from '../../../lib/errors/index.js';
import { idempotent } from '../../../lib/idempotency/index.js';
import { fromPromise } from '../../../lib/result/index.js';
import type { Database } from '@hushbox/db';
import type { RecordCatalogSighting } from '../ports/index.js';

/**
 * The catalog soft delete's only write (BILLING.md §Catalog Admission 4): one
 * conditional UPDATE keyed on the unique `model_id`, so duplicate and racing
 * refreshes converge on one end state — `idempotent.byUpsert`'s convergent
 * single-key contract.
 *
 * Three deliberate properties:
 * - It never inserts, so a model that was never admissible stays row-less.
 * - It never touches `descriptor`, so the skip-unchanged refresh keeps avoiding
 *   a jsonb rewrite for every model it re-sights every hour.
 * - It never touches `admin_disabled_at`. That column is asserted by a person
 *   while `excluded_reason` is derived by this refresh; sharing them would force
 *   the refresh either to overwrite a human's decision or to trap a model out.
 */
export function createCatalogSightingRecorder(db: Database): RecordCatalogSighting {
  return ({ modelId, seenAt, excludedReason }) =>
    idempotent.byUpsert(() =>
      fromPromise(
        db
          .update(modelCatalog)
          .set({
            lastSeenAt: seenAt,
            excludedReason,
            // COALESCE keeps the moment the row FIRST became inadmissible
            // across every later refresh that reaches the same verdict, the
            // same way `admin_disabled_at` keeps the first disable's moment.
            // Clearing the reason clears the stamp, so a model that leaves and
            // later re-enters exclusion is stamped afresh.
            excludedAt:
              excludedReason === null
                ? null
                : sql`coalesce(${modelCatalog.excludedAt}, ${seenAt.toISOString()}::timestamptz)`,
          })
          .where(eq(modelCatalog.modelId, modelId)),
        (cause) => unavailableError('model catalog sighting write failed', cause)
      )
    );
}
