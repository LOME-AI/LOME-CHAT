export { callerUserId } from './principal.js';
export {
  CHAT_TURN_HOOKS,
  CHAT_TURN_INPUT,
  CHAT_TURN_NODE_ID,
  CHAT_TURN_ROUTE,
  PER_WALLET_CONCURRENT_RUN_CAP,
} from './constants.js';
export {
  buildSingleModelTurn,
  buildTurnDefinition,
  createTurnCompileRegistries,
} from './turn-definition.js';
export type { SingleModelTurnParams, TurnCompileRegistries } from './turn-definition.js';
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
