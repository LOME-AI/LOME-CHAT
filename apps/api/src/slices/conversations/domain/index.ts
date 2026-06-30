export { callerUserId } from './principal.js';
export { isRefusal, refusalSchema, refusalToWire } from './outcomes.js';
export {
  assembleKeyChain,
  buildParentIndex,
  collectAncestorChain,
  exclusiveMessageIds,
} from './parent-chain.js';
export { planEpochWraps } from './rotation.js';
export {
  conversationView,
  createConversation,
  createConversationOutcomeSchema,
  decodeCursor,
  deleteConversation,
  deleteConversationOutcomeSchema,
  encodeCursor,
  getConversation,
  listConversations,
  membershipView,
} from './conversations.js';
export { evictPrincipals } from './eviction.js';
export {
  addMemberBodySchema,
  conversationIdParamSchema,
  createConversationBodySchema,
  createForkBodySchema,
  forkParamSchema,
  leaveBodySchema,
  listConversationsQuerySchema,
  memberParamSchema,
  muteBodySchema,
  pinBodySchema,
  removeMemberBodySchema,
  renameForkBodySchema,
  rotationBodySchema,
  updateForkTipBodySchema,
} from './schemas.js';
export type { Outcome, Refusal, WireRefusal } from './outcomes.js';
export type { ParentChainRow, ParentIndex } from './parent-chain.js';
export type { MemberWrapInput, PlannedWrap } from './rotation.js';
export type {
  ConversationListEntry,
  ConversationView,
  CreateConversationOutcome,
  DeleteConversationOutcome,
  GetConversationResult,
  ListConversationsResult,
  MembershipView,
} from './conversations.js';
export type { EvictionDeps } from './eviction.js';
export type { AddMemberBody, RotationBody } from './schemas.js';

// Routes may import only this barrel and the middleware (boundaries), so the
// lib surface the route seam needs — the uniform error body constructor and
// the idempotency machinery the mutation wrappers compose with — is published
// here rather than imported from lib directly in routes.ts.
export { createErrorResponse } from '../../../lib/errors/index.js';
export {
  idempotencyExempt,
  idempotent,
  isIdempotencyConflict,
  readIdempotencyKey,
  runMutation,
} from '../../../lib/idempotency/index.js';
export type { DomainError, DomainErrorCode } from '../../../lib/errors/index.js';
export type {
  ConversationsStores,
  ConversationsStoresFactory,
  MembershipRevoker,
  RealtimeBroadcast,
} from '../ports/index.js';
