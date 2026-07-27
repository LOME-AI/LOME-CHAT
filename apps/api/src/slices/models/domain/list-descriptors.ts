import { ModelDescriptor, isRunnableModelShape } from '@hushbox/shared';
import { unavailableError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { dispatchFamilyFor } from './dispatch.js';
import { readLatestDescriptorRows } from './catalog-store.js';
import { DESCRIPTOR_VERSION } from './normalize.js';
import type { Database } from '@hushbox/db';
import type { CallShapeFamily } from './dispatch.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';
import type { StoredDescriptorRow } from './catalog-store.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

export interface ListDescriptorsDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
}

/**
 * The exposure decision, fail-closed on every leg:
 * - ZDR-unreachable models stay hidden. `zdrReachable` is authoritative
 *   membership in OpenRouter's `/endpoints/zdr` set, so no separate dated
 *   verification is needed for image/video — the ZDR list is queryable and
 *   auto-updated.
 * - a model with no pricing (gateway-empty) stays hidden;
 * - embedding call shapes stay hidden until an adapter ships (dispatch
 *   refuses the family, so a listed one would error on every call).
 * The family comes from the same canonical derivation the adapter routes on,
 * so a media-routed model (including no-text multi-output shapes like
 * image+video) can never slip past this gate as "language".
 */
function isExposed(descriptor: ModelDescriptor, family: CallShapeFamily): boolean {
  if (!descriptor.zdrReachable) return false;
  if (Object.keys(descriptor.pricing).length === 0) return false;
  if (family === 'embedding') return false;
  // Defense-in-depth for rows persisted before admission enforced runnability:
  // a multi-output (or no-text-input) descriptor classifies to a family but no
  // turn can run it, so it stays hidden until the next refresh drops the row.
  if (!isRunnableModelShape(descriptor)) return false;
  return true;
}

/** One row's read decision: expose it, hide it quietly, or refuse the read. */
type RowOutcome =
  | { readonly kind: 'exposed'; readonly descriptor: ModelDescriptor }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'refused'; readonly error: DomainError };

function rowOutcome(
  modelId: string,
  stored: StoredDescriptorRow,
  telemetry: Telemetry
): RowOutcome {
  const parsed = ModelDescriptor.safeParse(stored.descriptor);
  if (!parsed.success) {
    telemetry.error('stored model descriptor failed contract validation — hidden', {
      modelName: modelId,
      errorCode: 'model_descriptor_invalid',
    });
    return { kind: 'hidden' };
  }
  if (parsed.data.version !== DESCRIPTOR_VERSION) {
    return {
      kind: 'refused',
      error: unavailableError(
        `model catalog row '${modelId}' carries descriptor version ` +
          `'${parsed.data.version}' (expected '${DESCRIPTOR_VERSION}'); its rates are not ` +
          'billable — run the catalog refresh to re-bake the catalog'
      ),
    };
  }
  const family = dispatchFamilyFor(parsed.data);
  if (family === undefined) {
    telemetry.error('model outputs match no call-shape family — hidden', {
      modelName: modelId,
      errorCode: 'model_family_unclassifiable',
    });
    return { kind: 'hidden' };
  }
  if (!isExposed(parsed.data, family)) return { kind: 'hidden' };
  // Rank lives in the column, never the descriptor jsonb; inject it here so
  // downstream projections carry it (null column → undefined field).
  return {
    kind: 'exposed',
    descriptor: { ...parsed.data, popularityRank: stored.popularityRank ?? undefined },
  };
}

/**
 * The read API other slices consume via the barrel: the persisted descriptor
 * of every exposed model. A stored descriptor that fails its own contract is
 * skipped with an alert — one corrupt row never takes down the whole catalog
 * read, and a hidden model is the safe failure mode. The one exception is a
 * descriptor-version mismatch: a v1 row carries PRE-fee provider rates, and
 * serving it would price turns below billable, so the whole read fails fast
 * instead (cheap structural enforcement — the next hourly refresh re-bakes
 * every row; zero-users ruling: no migration tooling).
 */
export function listDescriptors(
  deps: ListDescriptorsDeps
): ResultAsync<ModelDescriptor[], DomainError> {
  return readLatestDescriptorRows(deps.db).andThen(
    (latest): Result<ModelDescriptor[], DomainError> => {
      const exposed: ModelDescriptor[] = [];
      for (const [modelId, stored] of latest) {
        // The two unsellable authorities, both deliberately silent — an
        // operator decision and a derived admission verdict, neither data
        // corruption (BILLING.md §Catalog Admission 4: exposure filters on
        // `excludedReason IS NULL AND adminDisabledAt IS NULL`). Every exposure
        // and turn-time resolution surface derives from this read (`listModels`,
        // `createModelPricingResolver`/`snapshotResolver` snapshots), so the
        // gate holds everywhere at once.
        if (stored.adminDisabledAt !== null || stored.excludedReason !== null) continue;
        const outcome = rowOutcome(modelId, stored, deps.telemetry);
        if (outcome.kind === 'refused') return err(outcome.error);
        if (outcome.kind === 'exposed') exposed.push(outcome.descriptor);
      }
      return ok(exposed);
    }
  );
}
