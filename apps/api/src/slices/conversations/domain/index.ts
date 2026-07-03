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
  addMember,
  addMemberOutcomeSchema,
  leaveConversation,
  leaveOutcomeSchema,
  listMembers,
  removeMember,
  removeMemberOutcomeSchema,
  setMutedTransition,
  setPinnedTransition,
} from './members.js';
export { getKeyChain } from './keychain.js';
export {
  createFork,
  createForkOutcomeSchema,
  deleteFork,
  deleteForkOutcomeSchema,
  forkViewSchema,
  listForks,
  nextAutoName,
  renameFork,
  renameForkOutcomeSchema,
  updateForkTip,
  updateForkTipOutcomeSchema,
} from './forks.js';
export {
  addMemberBodySchema,
  conversationIdParameterSchema,
  createConversationBodySchema,
  createForkBodySchema,
  createLinkBodySchema,
  createSharedMessageBodySchema,
  forkParameterSchema,
  leaveBodySchema,
  linkIdParameterSchema,
  linkParameterSchema,
  listConversationsQuerySchema,
  memberParameterSchema,
  muteBodySchema,
  pinBodySchema,
  removeMemberBodySchema,
  renameForkBodySchema,
  rotationBodySchema,
  updateForkTipBodySchema,
} from './schemas.js';
export {
  createLinkOutcomeSchema,
  createSharedLink,
  createSharedMessage,
  createSharedMessageOutcomeSchema,
  listSharedLinks,
  publicShareViewSchema,
  readPublicShare,
  revokeLinkOutcomeSchema,
  revokeSharedLink,
  sharedLinkViewSchema,
} from './shares.js';
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
export type {
  AddMemberOutcome,
  LeaveOutcome,
  MemberView,
  MuteOutcome,
  PinOutcome,
  RemoveMemberOutcome,
} from './members.js';
export type { KeyChainView } from './keychain.js';
export type {
  CreateForkOutcome,
  DeleteForkOutcome,
  ForkView,
  RenameForkOutcome,
  UpdateForkTipOutcome,
} from './forks.js';
export type {
  CreateLinkOutcome,
  CreateSharedMessageOutcome,
  ListLinksResult,
  PublicShareView,
  RevokeLinkOutcome,
  SharedLinkView,
} from './shares.js';

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
export type { Result } from '../../../lib/result/index.js';
export type {
  ConversationsStores,
  ConversationsStoresFactory,
  MembershipRevoker,
  RealtimeBroadcast,
} from '../ports/index.js';
