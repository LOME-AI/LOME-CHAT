export { callerUserId } from './principal.js';
export {
  LINK_CREDENTIAL_HEADER,
  resolveCallerMember,
  resolveCallerPublicKey,
  resolveConversationCaller,
} from './caller.js';
export type { ConversationCaller } from './caller.js';
export {
  getMyName,
  myNameViewSchema,
  setMyNameTransition,
  setMyNameOutcomeSchema,
} from './my-name.js';
export type { MyNameView, SetMyNameOutcome } from './my-name.js';
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
export { assertWrapEpochByMemberWithinTx } from './wrap-epoch.js';
export type { WrapEpochByMemberAssertion } from './wrap-epoch.js';
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
export {
  conversationBudgetsViewSchema,
  getConversationBudgets,
  memberBudgetViewSchema,
  setBudgetOutcomeSchema,
  setConversationBudget,
  setConversationBudgetBodySchema,
  setMemberBudget,
  setMemberBudgetBodySchema,
} from './budgets.js';
export type { BudgetBilling, ConversationBudgetsView, SetBudgetOutcome } from './budgets.js';
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
  changeLinkNameBodySchema,
  changeLinkPrivilegeBodySchema,
  createForkBodySchema,
  createLinkBodySchema,
  createSharedMessageBodySchema,
  forkParameterSchema,
  leaveBodySchema,
  linkParameterSchema,
  shareIdParameterSchema,
  setMyNameBodySchema,
  listConversationsQuerySchema,
  memberKeysBatchQuerySchema,
  memberParameterSchema,
  messageHistoryQuerySchema,
  muteBodySchema,
  pinBodySchema,
  removeMemberBodySchema,
  renameForkBodySchema,
  revokeLinkBodySchema,
  rotationBodySchema,
  updateForkTipBodySchema,
  updateTitleBodySchema,
} from './schemas.js';
export {
  adminRevokeLinkOutcomeSchema,
  adminRevokeSharedLink,
  adminUnrevokeLinkOutcomeSchema,
  adminUnrevokeSharedLink,
  changeLinkName,
  changeLinkNameOutcomeSchema,
  changeLinkPrivilege,
  changeLinkPrivilegeOutcomeSchema,
  createLinkOutcomeSchema,
  createSharedLink,
  createSharedMessage,
  createSharedMessageOutcomeSchema,
  listSharedLinks,
  readSharedMessage,
  revokeLinkOutcomeSchema,
  revokeSharedLink,
  sharedLinkViewSchema,
  sharedMessageViewSchema,
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
  AdminRevokeLinkOutcome,
  AdminSharedLinkParams,
  AdminUnrevokeLinkOutcome,
  ChangeLinkNameOutcome,
  ChangeLinkPrivilegeOutcome,
  CreateLinkOutcome,
  CreateSharedMessageOutcome,
  ListLinksResult,
  RevokeLinkOutcome,
  SharedLinkView,
  SharedMessageView,
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
  UpgradePrincipal,
} from '../ports/index.js';
// Re-exported so routes (which import only this barrel + middleware) can type
// the injected link-resolution dependency without reaching into identity.
export type { LinkResolutionPort } from '../../identity/index.js';
