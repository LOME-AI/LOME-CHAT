/**
 * Internal types for the roadmap pipeline. The public response shape lives
 * in `@hushbox/shared` (RoadmapResponseSchema); these types are the
 * in-flight representation used while building it.
 */

import type { RoadmapNode } from '@hushbox/shared';

export type NormalizedNode = RoadmapNode;

export interface NormalizedGraph {
  nodes: readonly NormalizedNode[];
}
