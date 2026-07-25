export { CALL_SHAPE_FAMILIES, dispatchFamilyFor } from './dispatch.js';
export {
  callBillableNanoUsd,
  estimateRunCeilingNanoUsd,
  mediaCallUsageFor,
  priceMediaBillableNanoUsd,
  priceUsageBillableNanoUsd,
} from './estimate.js';
export { createEstimateRun } from './estimate-run.js';
export { findAdminDisabledModel } from './admin-disabled.js';
export { ADMIN_CATALOG_MODEL_CAP, listAdminCatalog } from './admin-catalog.js';
export type { AdminCatalogModel, AdminCatalogPage } from './admin-catalog.js';
export { listDescriptors } from './list-descriptors.js';
export { listModels } from './list-models.js';
// The route file may import only its own slice's domain barrel + middleware,
// so the error helper it needs is re-exported here (the account/announcements
// pattern).
export { createErrorResponse, domainWireCode } from '../../../lib/errors/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
export { createModelPricingResolver, snapshotResolver } from './pricing-resolver.js';
export {
  CLASSIFIER_CHARS_PER_TOKEN,
  buildSmartModelCandidates,
  pickEffortClassifier,
} from './smart-model-candidates.js';
export type {
  SmartModelCandidateEntry,
  SmartModelCandidates,
  SmartModelCandidatesInput,
} from './smart-model-candidates.js';
export { buildTrialSmartModelCandidates } from './trial-smart-model-candidates.js';
export type {
  TrialSmartModelCandidates,
  TrialSmartModelCandidatesInput,
} from './trial-smart-model-candidates.js';
export { refreshCatalog } from './refresh.js';
export { upsertCatalog } from './catalog-store.js';
export type { UpsertCatalogParams } from './catalog-store.js';
export { DESCRIPTOR_VERSION, EXCLUDE_REASONS } from './normalize.js';
export type { ExcludeReason } from './normalize.js';
export { findTierLockedModel } from './tier-gate.js';
export {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  trialEligibility,
  trialMessageBillableNanoUsd,
} from './trial-eligibility.js';
export {
  TOOL_REGISTRY,
  WEB_SEARCH_ENGINE,
  WEB_SEARCH_TOOL_NAME,
  resolveToolRegistry,
  webSearch,
} from './tool-registry.js';
export type { CallShapeFamily } from './dispatch.js';
export type { CallUsage, DeclaredCeiling } from './estimate.js';
export type { EstimateRun, ModelPricingResolver } from './estimate-run.js';
export type { ListDescriptorsDeps } from './list-descriptors.js';
export type { TrialEligibility } from './trial-eligibility.js';
export type { RefreshCatalogDeps, RefreshJitter, RefreshSummary } from './refresh.js';
