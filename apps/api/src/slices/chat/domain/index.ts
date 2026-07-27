export { callerUserId } from './principal.js';
export {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  CHAT_TURN_ROUTE,
  PER_WALLET_CONCURRENT_RUN_CAP,
  TRIAL_TURN_HOOKS,
} from './constants.js';
export {
  assertModelProducesModality,
  buildMediaTurn,
  buildMediaTurnDefinition,
  buildMultiModelTurn,
  buildMultiModelTurnDefinition,
  buildSingleModelTurn,
  buildTurnDefinition,
  createTurnCompileRegistries,
  trialReasoningSelection,
  turnModelPricings,
} from './turn-definition.js';
export type { MediaTurnModality, TurnBudget, TurnModelPricing } from './turn-definition.js';
export {
  buildAutoEffortTurnDefinition,
  buildSmartModelTurn,
  buildSmartModelTurnDefinition,
  buildTrialSmartModelTurnDefinition,
} from './smart-model-turn.js';
export type {
  AutoEffortTurnBuild,
  SmartModelTurnBuild,
  SmartModelTurnDeps,
  SmartModelTurnParams,
  TrialSmartModelTurnDeps,
} from './smart-model-turn.js';
export { consumeTrialQuota, hashIp } from './trial-quota.js';
export type { ConsumeTrialQuotaArgs, TrialQuotaResult } from './trial-quota.js';
export { CHAT_STREAM_USER_RATE_LIMIT, consumeChatStreamUserLimit } from './rate-limit.js';
export type { RateLimitDecision } from './rate-limit.js';

// The trial route's pre-run MODEL/AFFORDABILITY gate composes the models
// barrel (single-writer): the exposed catalog read, the eligibility predicate,
// the per-message cost estimate, and the 1¢ cap constant.
export {
  TRIAL_MESSAGE_COST_CAP_NANO_USD,
  findAdminDisabledModel,
  findTierLockedModel,
  listDescriptors,
  mockProviderEnabled,
  parseMockDirectives,
  trialEligibility,
  trialMessageBillableNanoUsd,
} from '../../models/index.js';
export type { TrialEligibility } from '../../models/index.js';

// The trial route needs the identity slice's trial-session resolver; the route
// may import only this barrel, so it is re-published here. (The realtime
// room-name helper is NOT re-exported: value-importing the `@hushbox/realtime`
// barrel drags in the workerd-only DO class, so it is injected via ChatRouteDeps
// instead — the same isolation the conversations adapters use.)
export { resolveTrialSessionPrincipal } from '../../identity/index.js';
export type { TrialSessionPrincipal } from '../../identity/index.js';
export type { SingleModelTurnParams, TurnCompileRegistries } from './turn-definition.js';
export { canRegenerate, regenerateBlockedByOtherUser } from './regenerate-guard.js';
export type {
  CanRegenerateParams,
  RegenerateDecision,
  RegenerateVerdict,
} from './regenerate-guard.js';
export { resolveTurnContext } from './turn-context.js';
export type {
  ChatRouteDeps,
  ConversationsStoresFactory,
  FundingDecisionInputs,
  NotifyNewMessage,
  PayerFunding,
  ResolveTurnContextDeps,
  TurnContext,
  TurnSender,
} from './turn-context.js';
// The public guest-send seam resolves and gates the caller through the
// conversations barrel (routes may import only this barrel + middleware).
export {
  LINK_CREDENTIAL_HEADER,
  resolveCallerMember,
  resolveConversationCaller,
} from '../../conversations/index.js';
export type { ConversationCaller } from '../../conversations/index.js';
export { broadcastUserMessageNew, saveUserOnlyMessage } from './user-message.js';
export type {
  SaveUserOnlyMessageArgs,
  SaveUserOnlyMessageDeps,
  UserOnlyMessageOutcome,
} from './user-message.js';
export { createChatSettlementCommit } from './settlement.js';
export type {
  ChatSettlementDeps,
  ChatSettlementIdentity,
  EpochPublicKeyReader,
} from './settlement.js';
export { createConversationRuntime } from './runtime.js';
export type { ConversationRuntime, ConversationRuntimeDeps } from './runtime.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs is published here rather than reached
// directly in routes.ts.
export { createErrorResponse, domainWireCode } from '../../../lib/errors/index.js';
export {
  hashCanonicalJson,
  idempotencyExempt,
  idempotent,
  readIdempotencyKey,
  runMutation,
} from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
