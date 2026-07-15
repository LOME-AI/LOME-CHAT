import { readLatestDescriptorRows } from './catalog-store.js';
import type { Database } from '@hushbox/db';
import type { StoredDescriptorRow } from './catalog-store.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * Turn-time admin kill-switch gate. A disabled model is already absent from
 * `listDescriptors` (so every snapshot resolver fails closed on it as
 * "unknown"), but that refusal is indistinguishable from a typo'd model id —
 * this seam reads the raw catalog rows and names the disabled model, so the
 * caller can refuse a direct API selection with the dedicated
 * `ERROR_CODES.MODEL_DISABLED` wire code (the `MODEL_TIER_LOCKED` pattern:
 * a slice verdict the route maps to its code).
 */

/**
 * The first selected model (selection order — mirrors `findTierLockedModel`'s
 * first-in-set behaviour) whose catalog row carries the admin kill switch.
 * Ids absent from the catalog are ignored: the turn build refuses unknown
 * models on its own, and absence is not an admin decision.
 */
export function firstAdminDisabledModel(
  rows: ReadonlyMap<string, StoredDescriptorRow>,
  models: readonly string[]
): string | undefined {
  return models.find((modelId) => {
    const stored = rows.get(modelId);
    return stored !== undefined && stored.adminDisabledAt !== null;
  });
}

/**
 * Reads the catalog (raw rows — the disabled model is deliberately invisible
 * through every exposed-descriptor read) and returns the first admin-disabled
 * model in the selection, or undefined when the whole selection is clean.
 */
export function findAdminDisabledModel(
  deps: { readonly db: Database },
  models: readonly string[]
): ResultAsync<string | undefined, DomainError> {
  return readLatestDescriptorRows(deps.db).map((rows) => firstAdminDisabledModel(rows, models));
}
