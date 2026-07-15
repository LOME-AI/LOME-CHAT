import { ModelDescriptor } from '@hushbox/shared';
import { dispatchFamilyFor } from './dispatch.js';
import { readLatestDescriptorRows } from './catalog-store.js';
import type { Database } from '@hushbox/db';
import type { CallShapeFamily } from './dispatch.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
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
  return true;
}

/**
 * The read API other slices consume via the barrel: the persisted descriptor
 * of every exposed model. A stored descriptor that fails its own contract is
 * skipped with an alert — one corrupt row never takes down the whole catalog
 * read, and a hidden model is the safe failure mode.
 */
export function listDescriptors(
  deps: ListDescriptorsDeps
): ResultAsync<ModelDescriptor[], DomainError> {
  return readLatestDescriptorRows(deps.db).map((latest) => {
    const exposed: ModelDescriptor[] = [];
    for (const [modelId, stored] of latest) {
      // The admin kill switch: a disabled row is deliberately hidden — no
      // alert (an operator decision, not data corruption). Every exposure and
      // turn-time resolution surface derives from this read (`listModels`,
      // `createModelPricingResolver`/`snapshotResolver` snapshots), so the
      // gate holds everywhere at once.
      if (stored.adminDisabledAt !== null) continue;
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
      if (isExposed(parsed.data, family)) exposed.push(parsed.data);
    }
    return exposed;
  });
}
