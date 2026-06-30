import { ModelDescriptor } from '@hushbox/shared';
import { dispatchFamilyFor } from './dispatch.js';
import { readLatestDescriptorRows, readOverrides } from './catalog-store.js';
import type { Database } from '@hushbox/db';
import type { CallShapeFamily } from './dispatch.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { ModelOverride } from './overrides.js';

export interface ListDescriptorsDeps {
  readonly db: Database;
  readonly telemetry: Telemetry;
}

/**
 * The exposure decision, fail-closed on every leg:
 * - ZDR-unreachable models stay hidden (unverified ⇒ unreachable);
 * - a model with no pricing (gateway-empty and not overridden — overrides
 *   merge into the persisted descriptor at refresh) stays hidden;
 * - image/video call shapes additionally require a DATED ZDR verification
 *   on the model's override row, read live so revoking the row hides the
 *   model without waiting for a refresh. The family comes from the same
 *   canonical derivation the adapter routes on, so a media-routed model
 *   (including no-text multi-output shapes like image+video) can never
 *   slip past this gate as "language".
 */
function isExposed(
  descriptor: ModelDescriptor,
  family: CallShapeFamily,
  override: ModelOverride | undefined
): boolean {
  if (!descriptor.zdrReachable) return false;
  if (Object.keys(descriptor.pricing).length === 0) return false;
  // No embedding adapter exists — dispatch refuses the family, so a listed
  // embedding model would error on every call. Hiding the family until an
  // adapter ships keeps the listing honest; refresh still persists these
  // descriptors, so they surface the moment one does.
  if (family === 'embedding') return false;
  if (family === 'image' || family === 'video') {
    return override !== undefined && override.zdrVerifiedAt !== null;
  }
  return true;
}

/**
 * The read API other slices consume via the barrel: the latest persisted
 * descriptor of every exposed model. A stored descriptor that fails its own
 * contract is skipped with an alert — one corrupt row never takes down the
 * whole catalog read, and a hidden model is the safe failure mode.
 */
export function listDescriptors(
  deps: ListDescriptorsDeps
): ResultAsync<ModelDescriptor[], DomainError> {
  return readLatestDescriptorRows(deps.db).andThen((latest) =>
    readOverrides(deps.db).map(({ overrides }) => {
      const exposed: ModelDescriptor[] = [];
      for (const [modelId, stored] of latest) {
        const parsed = ModelDescriptor.safeParse(stored.descriptor);
        if (!parsed.success) {
          deps.telemetry.error('stored model descriptor failed contract validation — hidden', {
            modelName: modelId,
            errorCode: 'model_descriptor_invalid',
          });
          continue;
        }
        const family = dispatchFamilyFor(parsed.data);
        if (family === undefined) {
          deps.telemetry.error('model outputs match no call-shape family — hidden', {
            modelName: modelId,
            errorCode: 'model_family_unclassifiable',
          });
          continue;
        }
        if (isExposed(parsed.data, family, overrides.get(modelId))) {
          exposed.push(parsed.data);
        }
      }
      return exposed;
    })
  );
}
