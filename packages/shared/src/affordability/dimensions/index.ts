/**
 * The dimension registry's published surface, not a directory barrel.
 *
 * `docs/BILLING.md` §Where the Code Lives names "the dimension registry as
 * data" a structural seam, and keeps the machinery around it unexported. So the
 * derivations in `derive.ts` — the reserve contribution, the prompt section, the
 * answer parser, the fallback, per-model resolution, the partition split — are
 * absent here rather than absent one level up: a name this file does not carry
 * cannot reach either package entry point, whichever of them stars it.
 * In-module consumers import `./derive.js` directly.
 */

export { DIMENSIONS, dimensionFor } from './registry.js';
export {
  DIMENSION_COST_CLASSES,
  DIMENSION_IDS,
  DIMENSION_RESOLUTIONS,
  DIMENSION_RESOURCES,
} from './types.js';
export type {
  DimensionCostClass,
  DimensionId,
  DimensionOption,
  DimensionResolution,
  DimensionResource,
  DimensionSpec,
  DimensionSupport,
  OpenDimension,
  OptionId,
  OptionLabel,
  ProviderParams,
  ReserveContribution,
} from './types.js';
