import { listDescriptors } from './list-descriptors.js';
import type { ModelDescriptor } from '@hushbox/shared';
import type { ListDescriptorsDeps } from './list-descriptors.js';
import type { ModelPricingResolver } from './estimate-run.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The synchronous model id → descriptor map admission, estimation, and the flow
 * engine's model resolver read on the turn hot path — where an async catalog
 * read per call is undesirable. It resolves over a catalog SNAPSHOT: consumers
 * need a `(modelId) => ModelDescriptor | undefined` they can call without
 * awaiting, and the descriptor carries the pricing they price against.
 */

/**
 * Builds the sync lookup from an in-memory descriptor snapshot. Kept pure and
 * separate from the async catalog read so the lookup semantics — last-wins on a
 * repeated id, unknown id → `undefined` — are directly testable. An unknown id
 * yields `undefined` by omission; every consumer fails closed on `undefined`.
 */
export function snapshotResolver(descriptors: readonly ModelDescriptor[]): ModelPricingResolver {
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  return (modelId) => byId.get(modelId);
}

/**
 * Produces a sync pricing/descriptor resolver from a catalog snapshot read ONCE
 * at construction. Freshness model: the returned resolver closes over that
 * snapshot and never re-reads — staleness is bounded by the catalog's hourly
 * cron refresh, and a caller wanting fresher data reconstructs the resolver.
 * Only exposed models (ZDR-reachable, priced, dispatchable) are resolvable: the
 * snapshot is `listDescriptors`' already-filtered set, so an unexposed or
 * unknown id returns `undefined` — the same fail-closed source the async read
 * uses, never a second catalog-read path.
 */
export function createModelPricingResolver(
  deps: ListDescriptorsDeps
): ResultAsync<ModelPricingResolver, DomainError> {
  return listDescriptors(deps).map((descriptors) => snapshotResolver(descriptors));
}
