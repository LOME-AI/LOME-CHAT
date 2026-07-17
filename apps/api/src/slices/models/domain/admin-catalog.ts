import { ModelDescriptor } from '@hushbox/shared';
import { dispatchFamilyFor } from './dispatch.js';
import { readLatestDescriptorRows } from './catalog-store.js';
import type { Database } from '@hushbox/db';
import type { CallShapeFamily } from './dispatch.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { StoredDescriptorRow } from './catalog-store.js';

/**
 * One catalog row projected for the admin Models screen: identity + status,
 * never the descriptor jsonb (ParamSpecs and pricing matrices stay
 * server-side — the screen needs the kill-switch state, not a dump). The
 * projection fields are null when the stored descriptor fails its own
 * contract: unlike the product read, the admin read never hides a row —
 * seeing the corrupt/disabled/unexposed rows is its purpose.
 */
export interface AdminCatalogModel {
  readonly modelId: string;
  readonly name: string | null;
  readonly family: CallShapeFamily | null;
  readonly zdrReachable: boolean | null;
  /** The admin kill switch (`model.disable`); null when enabled. */
  readonly adminDisabledAt: Date | null;
}

export interface AdminCatalogPage {
  readonly models: readonly AdminCatalogModel[];
  readonly truncated: boolean;
}

/**
 * Single-page hard cap. The catalog is small-by-design (one row per model,
 * whole-table reads are this slice's established pattern) and the live
 * OpenRouter set is a few hundred models, so there is no cursor; the cap
 * plus the `truncated` flag keep the response bounded and the truncation
 * visible if the catalog ever outgrows the assumption.
 */
export const ADMIN_CATALOG_MODEL_CAP = 1000;

/** Pure projection over the folded whole-table read (unit-tested). */
export function projectAdminCatalog(
  latest: ReadonlyMap<string, StoredDescriptorRow>
): AdminCatalogPage {
  const models: AdminCatalogModel[] = [];
  for (const [modelId, stored] of latest) {
    const parsed = ModelDescriptor.safeParse(stored.descriptor);
    models.push({
      modelId,
      name: parsed.success ? (parsed.data.name ?? null) : null,
      family: parsed.success ? (dispatchFamilyFor(parsed.data) ?? null) : null,
      zdrReachable: parsed.success ? parsed.data.zdrReachable : null,
      adminDisabledAt: stored.adminDisabledAt,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models: models.slice(0, ADMIN_CATALOG_MODEL_CAP),
    truncated: models.length > ADMIN_CATALOG_MODEL_CAP,
  };
}

/**
 * The admin plane's catalog read, published via the barrel: every persisted
 * model INCLUDING `admin_disabled_at`-flagged and exposure-gate-hidden ones
 * (the product read, `listDescriptors`, deliberately drops both).
 */
export function listAdminCatalog(db: Database): ResultAsync<AdminCatalogPage, DomainError> {
  return readLatestDescriptorRows(db).map((latest) => projectAdminCatalog(latest));
}
