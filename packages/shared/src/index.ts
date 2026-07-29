export * from './constants.js';
// Named, not `export *`: the minimum-answer constant, the two tier ratios and
// the per-call search rate are behind the money layer's export wall
// (`docs/BILLING.md` §Where the Code Lives).
export {
  CAPACITY_RED_THRESHOLD,
  CAPACITY_YELLOW_THRESHOLD,
  CHARACTERS_PER_KILOBYTE,
  CREDIT_CARD_FEE_RATE,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  EXPENSIVE_MODEL_THRESHOLD_PER_1K,
  HUSHBOX_FEE_RATE,
  KILOBYTES_PER_GIGABYTE,
  LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD,
  MAX_ALLOWED_NEGATIVE_BALANCE_CENTS,
  MAX_SEARCH_TOOL_CALLS,
  MAX_TRIAL_MESSAGE_COST_CENTS,
  MEDIA_MONTHLY_COST_PER_GB,
  MEDIA_STORAGE_COST_PER_BYTE,
  MONTHLY_COST_PER_GB,
  MONTHS_PER_YEAR,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_1K_CHARS,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_YEARS,
  TOTAL_FEE_RATE,
} from './affordability/constants.js';
export * from './websocket.js';
export * from './affordability/fees.js';
export * from './routes.js';
export * from './formatting.js';
export * from './affordability/pricing.js';
export * from './affordability/tiers.js';
// Named: the output-token clamp is behind the wall; the notice generator is not.
export { generateNotifications } from './affordability/budget.js';
export type { BudgetError, MessageSegment, NotificationInput } from './affordability/budget.js';
export * from './affordability/billing/funding-decision.js';
export * from './affordability/billing/client-billing.js';
export * from './env.js';
export * from './env.config.js';
export * from './schemas/dev-persona.js';
export * from './schemas/accessibility-preferences.js';
export * from './schemas/api/index.js';
export * from './capabilities/index.js';
export * from './prompt/index.js';
export * from './utils/date.js';
export * from './utils/pagination.js';
export * from './utils/username.js';
export * from './schemas/username.js';
export * from './random.js';
export * from './retry.js';
export * from './text-encoder.js';
export * from './utils/privileges.js';
export * from './utils/base64.js';
export * from './affordability/levenshtein.js';
export * from './utils/assert-never.js';
export * from './legal/index.js';
export * from './linear/index.js';
export * from './error-messages.js';
export * from './mobile.js';
export * from './platform.js';
export * from './documents/index.js';
export * from './models/index.js';
export * from './affordability/smart-model/index.js';
export * from './pre-inference/index.js';
// The canonical estimator's published surface. Named (not `export *`) so the
// barrel's surface stays explicit and cannot collide with the money/pricing
// re-exports below. The pricing machinery itself — rates, manifests, the two
// reducers, the ceiling solvers, the ladder, the tier ratios — is behind the
// wall and is not re-exported by the estimator's own barrel either.
export {
  estimateErr,
  estimateOk,
  getCushionNano,
  getEffectiveBalanceNano,
  isExpensiveModelNano,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  nanoPricePer1k,
  nanoPriceRangePer1k,
  nanoUnitPriceUsd,
  outputTokensOf,
  PAID_CUSHION_NANO_USD,
  planReasoning,
  planReasoningOff,
  REASONING_OFF_WIRE,
  ReasoningWire,
  reasoningBudgetForWire,
  reasoningPlanModelFrom,
  spendableFundsNanoUsd,
  STORAGE_COST_PER_CHARACTER_NANO,
} from './affordability/estimate/index.js';
export type {
  CallUsage,
  EffortChoice,
  EstimateError,
  EstimateErrorCode,
  EstimateResult,
  ReasoningPlanDescriptorInput,
  ReasoningPlanModel,
} from './affordability/estimate/index.js';
export * from './affordability/reasoning-effort.js';
// Premium classification and the narrow money projection it reads — two of the
// named structural seams of `docs/BILLING.md` §Where the Code Lives.
export * from './affordability/premium.js';
export * from './affordability/priceable-model.js';
// The feature surface of `docs/BILLING.md` §The public surface, published at the
// package root as well: one surface, two entry points, so a consumer cannot find
// a producer at one and its absence at the other.
export { getTurnOptions } from './affordability/turn-options.js';
export { minTurnCostNanoUsd } from './affordability/min-turn-cost.js';
export type { MinTurnCostInput } from './affordability/min-turn-cost.js';
export { chooseFrom, renderOptions, wireFor } from './affordability/classifier-choice.js';
export type { ChosenOptions } from './affordability/classifier-choice.js';
export * from './affordability/model-id.js';
export * from './affordability/turn-types.js';
export { NOTICE_COPY, NOTICE_REASONS, notices, noticeText } from './affordability/notices.js';
export type { Notice, NoticeCopy, NoticeReason } from './affordability/notices.js';

export * from './affordability/dimensions/index.js';
export * from './features.js';
export * from './comparison.js';
export * from './test-ids.js';
export * from './test-signals.js';
export * from './storage-keys.js';
export * from './usage-stats-windows.js';
export * from './admin/index.js';
export * from './notifications/index.js';

export {
  FEEDBACK_BODY_MAX_LENGTH,
  FEEDBACK_KINDS,
  FEEDBACK_STATUSES,
  FeedbackKind,
  FeedbackStatus,
} from './feedback.js';
export {
  NEWSLETTER_CONFIRM_TTL_MS,
  NEWSLETTER_CONSENT_SOURCES,
  NEWSLETTER_CONSENT_TEXT_VERSION,
  NEWSLETTER_DEFAULT_TOPIC,
  NEWSLETTER_DELIVERY_STATUSES,
  NEWSLETTER_ISSUE_STATUSES,
  NEWSLETTER_POSTAL_ADDRESS,
  NEWSLETTER_STATUSES,
  NEWSLETTER_SUPPRESS_REASONS,
  NewsletterConsentSource,
  NewsletterDeliveryStatus,
  NewsletterIssueStatus,
  NewsletterStatus,
  NewsletterSuppressReason,
} from './newsletter.js';
export { LEDGER_ENTRY_KINDS, PAYMENT_STATUSES } from './billing-enums.js';
export { IMAGE_MIME_TYPES } from './media-mime.js';
export { MEMBER_PRIVILEGES, MemberPrivilege } from './member-privilege.js';
export { MODALITIES, Modality } from './affordability/modality.js';
// Fee-seam: this barrel PUBLISHES the fee helpers to the sanctioned
// cross-package application seams; the vendored fee-seams lint rule confines
// who may import them (seam list in fee-seams.config.mjs).
export {
  MARKUP_BASIS_POINTS,
  applyMarkup,
  applyMarkupCeil,
  roundHalfEvenDiv,
  usdToNanoUsd,
} from './affordability/money.js';
export {
  NanoUSD,
  NANO_USD_PER_CENT,
  NANO_USD_PER_DOLLAR,
  nanoUSD,
  nanoUsdToCents,
  nanoUsdToDollarString,
  nanoUsdToFullDollarString,
  centsToNanoUsd,
  dollarsToCents,
  dollarsToNanoUsd,
  parseNanoUSD,
  serializeNanoUSD,
} from './affordability/nano-usd.js';
export {
  DOMAIN_ERROR_CODE_TO_WIRE_CODE,
  friendlyErrorMessage,
  ERROR_CODES,
  ERROR_MESSAGES,
  errorCodeSchema,
  errorResponseSchema,
} from './error-codes.js';
export type { ErrorCode, ErrorResponse } from './error-codes.js';
export { ContentValue, MediaValue } from './content-value.js';
export {
  deriveNodeSchemas,
  Edge,
  END_NODE_ID,
  formatTypeTag,
  isAssignable,
  jsonTag,
  listTag,
  MEDIA_TAG_MODALITIES,
  mediaTag,
  NodeId,
  optionalTag,
  PortId,
  PortRef,
  textTag,
  TYPE_TAG_LAWS,
  TypeTagSchema,
  zodFor,
} from './type-tag.js';
export type {
  DerivedNodeSchemas,
  JsonTag,
  ListTag,
  MediaTag,
  MediaTagModality,
  NodePortDeclaration,
  OptionalTag,
  SchemaNameRegistry,
  TextTag,
  TypeTag,
} from './type-tag.js';
export {
  compileParamSpec,
  PARAM_TYPES,
  PARAM_WIRES,
  ParamSpec,
} from './affordability/param-spec.js';
export type { ParamType, ParamWire } from './affordability/param-spec.js';
export { CONSTRAINT_KINDS } from './constraint-registry.js';
export type {
  ConstraintEntryOf,
  ConstraintKind,
  NamedConstraintEntry,
  NamedConstraintRegistry,
  ParameterConstraintEntry,
  PredicateConstraintEntry,
  ReducerConstraintEntry,
  SchemaConstraintEntry,
} from './constraint-registry.js';
export {
  CALL_SHAPE_FAMILIES,
  ModelDescriptor,
  ModelReasoning,
  PricingSchema,
  callShapeFamilyFor,
  isRunnableModelShape,
} from './affordability/model-descriptor.js';
export type { CallShapeFamily, Pricing } from './affordability/model-descriptor.js';
export {
  ChatHistoryMessage,
  FilePart,
  FINISH_REASONS,
  FinishReason,
  InferenceEvent,
  InferenceRequest,
  InputPart,
  MediaRef,
  PersistedToolStep,
  ProviderMetadata,
  ToolCall,
  ToolResult,
  Usage,
} from './inference.js';
export type { FilePartMapper, FilePartMediaEvents } from './inference.js';
export {
  AdmissionHookName,
  consumedProducerIds,
  DEADLINE_CLASS_MS,
  DEADLINE_CLASSES,
  isTurnClassifierNode,
  Node,
  NODE_TYPES,
  PolicyHooks,
  SettlementHookName,
  smartModelClassifierDimensions,
  StorageStamp,
  TURN_DECISION_REDUCER,
  WorkflowDefinition,
} from './workflow.js';
export type { DeadlineClass, NodeType } from './workflow.js';
export type {
  AdmissionDecision,
  AdmissionHook,
  AdmissionRequest,
  ClaimRun,
  FlowAdmissionOutcome,
  FlowExecutor,
  FlowHoldIdentity,
  FlowHookBindings,
  FlowInputs,
  FlowRunHandle,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStopReason,
  FlowStreamEvent,
  MediaPersistPlan,
  PaidRunIdentity,
  RegenerateAction,
  RunClaim,
  RunClaimRequest,
  RunContext,
  RunFence,
  RunIdentity,
  SenderPrincipal,
  CompletionTokens,
  MediaGenerationFacts,
  SettlementCharge,
  TrialRunIdentity,
  SettlementHook,
  SettlementRequest,
} from './flow-executor.js';
export { composeEnvConfig, composedEnvConfig, envConfigAdditions } from './env-composition.js';
export { mockDirectivesSchema } from './mock-directives.js';
export type { MockDirectives } from './mock-directives.js';
export * from './reasoning-format.js';
export * from './tts-hosts.js';
export * from './tts-model-download.js';
