export {
  ADMIN_CATALOG_MODEL_CAP,
  buildSmartModelCandidates,
  buildTrialSmartModelCandidates,
  CALL_SHAPE_FAMILIES,
  callBaseNanoUsd,
  compileWireParams,
  createEstimateRun,
  createModelPricingResolver,
  dispatchFamilyFor,
  EXCLUDE_REASONS,
  estimateCallNanoUsd,
  estimateRunCeilingNanoUsd,
  findAdminDisabledModel,
  findTierLockedModel,
  listAdminCatalog,
  listDescriptors,
  pickEffortClassifier,
  priceMediaBaseNanoUsd,
  priceUsageBaseNanoUsd,
  refreshCatalog,
  resolveMediaInputs,
  resolveToolRegistry,
  snapshotResolver,
  TOOL_REGISTRY,
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  trialEligibility,
  trialMessageBaseNanoUsd,
  upsertCatalog,
  WEB_SEARCH_ENGINE,
  WEB_SEARCH_TOOL_NAME,
  webSearch,
} from './domain/index.js';
export { createModelsManifest } from './routes.js';
export type {
  AdminCatalogModel,
  AdminCatalogPage,
  CallShapeFamily,
  CallUsage,
  DeclaredCeiling,
  ExcludeReason,
  EstimateRun,
  ListDescriptorsDeps,
  ModelPricingResolver,
  RefreshCatalogDeps,
  RefreshJitter,
  RefreshSummary,
  SmartModelCandidateEntry,
  SmartModelCandidates,
  TrialEligibility,
  TrialSmartModelCandidates,
  TrialSmartModelCandidatesInput,
  UpsertCatalogParams,
  WireParams,
} from './domain/index.js';
export {
  CALL_SHAPES,
  callShapeFor,
  createDispatchingProvider,
  createModelProvider,
} from './adapters/dispatch.js';
export { resolveModelProvider } from './adapters/resolve-model-provider.js';
export {
  MOCK_ECHO_PREFIX,
  createMockModelProvider,
  mockDirectivesFor,
  mockProviderEnabled,
  parseMockDirectives,
} from './adapters/mock-provider.js';
export type { MockDirectives } from './adapters/mock-provider.js';
export { disableModelWithinTx, enableModelWithinTx } from './adapters/catalog-admin.js';
export type { DisableModelOutcome, EnableModelOutcome } from './adapters/catalog-admin.js';
export { OPENROUTER_BASE_URL } from './adapters/openrouter-provider.js';
export {
  INFERENCE_ERROR_CODES,
  InferenceError,
  classifyInferenceFailure,
  unsupportedModalityError,
} from './adapters/inference-error.js';
export type { CallShape, CreateModelProviderOptions, DispatchTable } from './adapters/dispatch.js';
export type { InferenceErrorCode } from './adapters/inference-error.js';
export type {
  InferOptions,
  ModelProvider,
  ProviderToolSpec,
  ToolDefinition,
  ToolLoopOptions,
  ToolRegistry,
} from './ports/index.js';
