export { callerUserId } from './principal.js';
export { isRefusal, refusalSchema, refusalToWire } from './outcomes.js';
export {
  assembleKeyChain,
  buildParentIndex,
  collectAncestorChain,
  exclusiveMessageIds,
  regenerableTailIds,
} from './parent-chain.js';
export { planEpochWraps } from './rotation.js';
export { reserveSequenceBlockWithinTx } from './sequence-block.js';
export type { SequenceBlockRequest } from './sequence-block.js';
export { advanceForkTipWithinTx, resolveForkTipWithinTx } from './fork-tip.js';
export type {
  AdvanceForkTipRequest,
  ForkTipResolution,
  ResolveForkTipRequest,
} from './fork-tip.js';
export { assertWrapEpochWithinTx } from './wrap-epoch.js';
export type { WrapEpochAssertion } from './wrap-epoch.js';
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
  updateConversationTitle,
  updateTitleOutcomeSchema,
} from './conversations.js';
export { evictPrincipals } from './eviction.js';
export { broadcastForkCreated, broadcastForkDeleted, broadcastForkRenamed } from './fork-events.js';
export {
  broadcastMemberAdded,
  broadcastMemberPrivilegeChanged,
  broadcastMemberRemoved,
  broadcastRotationComplete,
} from './member-events.js';
export {
  acceptInviteTransition,
  addMember,
  addMemberOutcomeSchema,
  changeMemberPrivilege,
  changePrivilegeOutcomeSchema,
  declineInviteTransition,
  declineOutcomeSchema,
  leaveConversation,
  leaveOutcomeSchema,
  listMembers,
  removeMember,
  removeMemberOutcomeSchema,
  setMutedTransition,
  setPinnedTransition,
} from './members.js';
export { getKeyChain, getKeyChainBatch } from './keychain.js';
export { getMemberKeys, memberKeyViewSchema, memberKeysViewSchema } from './member-keys.js';
export { getMessageHistory, historyMessageSchema, messageHistorySchema } from './history.js';
export { contentItemView, contentItemViewSchema } from './content-item-view.js';
export type { KeyChainBatchView } from './keychain.js';
export type { MemberKeyView, MemberKeysView } from './member-keys.js';
export type { HistoryMessage, MessageHistoryView } from './history.js';
export type { ContentItemView } from './content-item-view.js';
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
  changePrivilegeBodySchema,
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
  memberKeysBatchQuerySchema,
  memberParameterSchema,
  messageHistoryQuerySchema,
  muteBodySchema,
  pinBodySchema,
  removeMemberBodySchema,
  renameForkBodySchema,
  rotationBodySchema,
  updateForkTipBodySchema,
  updateTitleBodySchema,
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
  UpdateTitleOutcome,
} from './conversations.js';
export type { EvictionDeps } from './eviction.js';
export type { AddMemberBody, RotationBody } from './schemas.js';
export type {
  AcceptOutcome,
  AddMemberOutcome,
  ChangePrivilegeOutcome,
  DeclineOutcome,
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
  ForkMessageDeleter,
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
export type { DbWriter } from '../../../lib/idempotency/index.js';
export type { Result } from '../../../lib/result/index.js';
export type {
  ConversationsStores,
  ConversationsStoresFactory,
  MembershipRevoker,
  RealtimeBroadcast,
} from '../ports/index.js';
