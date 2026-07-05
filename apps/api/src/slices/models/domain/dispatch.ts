import { callShapeFamilyFor } from '@hushbox/shared';
import type { CallShapeFamily, ModelDescriptor } from '@hushbox/shared';

export { CALL_SHAPE_FAMILIES } from '@hushbox/shared';
export type { CallShapeFamily } from '@hushbox/shared';

/**
 * Descriptor → call-shape family, delegated to the canonical shared
 * derivation so the exposure gate here and the adapter routing can never
 * diverge. `undefined` (no classifiable output) flows to the callers'
 * exclude-with-alert paths — hidden, never guessed.
 */
export function dispatchFamilyFor(descriptor: ModelDescriptor): CallShapeFamily | undefined {
  return callShapeFamilyFor(descriptor.outputs);
}
