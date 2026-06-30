import { CALL_SHAPE_FAMILIES, callShapeFamilyFor } from '@hushbox/shared';
import type { CallShapeFamily, ModelDescriptor } from '@hushbox/shared';

export { CALL_SHAPE_FAMILIES } from '@hushbox/shared';
export type { CallShapeFamily } from '@hushbox/shared';

const FAMILY_SET: ReadonlySet<string> = new Set(CALL_SHAPE_FAMILIES);

/**
 * Gateway `modelType` → call-shape family. A missing type defaults to
 * language (the gateway's own SDK treats untyped entries as language
 * models); any other value — including gateway-known types our dispatch has
 * no call shape for, such as `reranking` — returns `undefined` so the
 * caller excludes the model with an alert, never a crash.
 */
export function familyForModelType(modelType?: string): CallShapeFamily | undefined {
  if (modelType === undefined) return 'language';
  return FAMILY_SET.has(modelType) ? (modelType as CallShapeFamily) : undefined;
}

/**
 * Descriptor → call-shape family, delegated to the canonical shared
 * derivation so the exposure gate here and the adapter routing can never
 * diverge. `undefined` (no classifiable output) flows to the callers'
 * exclude-with-alert paths — hidden, never guessed.
 */
export function dispatchFamilyFor(descriptor: ModelDescriptor): CallShapeFamily | undefined {
  return callShapeFamilyFor(descriptor.outputs);
}
