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
  buildSingleModelTurn,
  buildTurnDefinition,
  createTurnCompileRegistries,
} from './turn-definition.js';
export { consumeTrialQuota, hashIp } from './trial-quota.js';
export type { ConsumeTrialQuotaArgs, TrialQuotaResult } from './trial-quota.js';

// The trial route needs the identity slice's trial-session resolver; the route
// may import only this barrel, so it is re-published here. (The realtime
// room-name helper is NOT re-exported: value-importing the `@hushbox/realtime`
// barrel drags in the workerd-only DO class, so it is injected via ChatRouteDeps
// instead — the same isolation the conversations adapters use.)
export { resolveTrialSessionPrincipal } from '../../identity/index.js';
export type { TrialSessionPrincipal } from '../../identity/index.js';
export type { SingleModelTurnParams, TurnCompileRegistries } from './turn-definition.js';
export { canRegenerate, regenerateBlockedByOtherUser } from './regenerate-guard.js';
export type { CanRegenerateParams, RegenerateDecision } from './regenerate-guard.js';
export { resolveTurnContext } from './turn-context.js';
export type {
  ChatRouteDeps,
  ConversationsStoresFactory,
  ResolveTurnContextDeps,
  TurnContext,
} from './turn-context.js';
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
export { createErrorResponse } from '../../../lib/errors/index.js';
export { hashCanonicalJson, readIdempotencyKey } from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
