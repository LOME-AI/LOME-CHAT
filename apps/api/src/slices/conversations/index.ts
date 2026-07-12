export { createConversationsManifest } from './routes.js';
export type { ConversationsRouteDeps } from './routes.js';
export { createConversationsStores } from './adapters/stores.js';
// The composition root composes these with chat's content-item read to build
// media's PresignReaders (this slice owns epochs, epoch_members,
// conversation_members, shared_links, shared_messages).
export {
  findMessageShare,
  isActiveConversationMember,
  isEpochMember,
  resolveEpochRowId,
} from './adapters/presign-reads.js';
export type { PresignMemberRef, PresignMessageShare } from './adapters/presign-reads.js';
export {
  MEMBERSHIP_CACHE_TTL_SECONDS,
  MEMBERSHIP_FRESHNESS_MS,
  MEMBERSHIP_LAST_KNOWN_GOOD_MS,
  createDbMembershipSource,
  createMembershipRevoker,
  createRedisMembershipCache,
  membershipCacheKey,
} from './adapters/membership.js';
// The `epochs` wrap-key read (node-safe — no realtime graph): chat composes it
// as the default reader its settlement and user-only writer wrap content to.
export { createEpochPublicKeyReader } from './adapters/epoch-reads.js';
export { createRealtimeBroadcast } from './adapters/realtime-do.js';
export type { ConversationRoomNamespace } from './adapters/realtime-do.js';
export { publicShareReadRateLimit } from './adapters/rate-limit.js';
// Identity's account-deletion transaction composes these published writes —
// the bulk membership leave and the owned-conversation-id capture — inside
// its one settlement transaction (single-writer: this slice owns both tables).
export {
  deleteOwnedConversationsWithinTx,
  leaveAllMembershipsWithinTx,
  ownedConversationIdsWithinTx,
} from './adapters/account-deletion.js';
// createRoomBindings is deliberately NOT re-exported: its only production
// consumer is the composition root (src/adapters/conversation-room.ts), which
// imports it directly and injects the chat runtime + identity liveness read —
// barrels this slice may not import.
// The unified parent-chain module — the published walk for message ancestry
// and epoch key chains; the chat slice consumes these instead of re-walking.
export {
  LINK_CREDENTIAL_HEADER,
  advanceForkTipWithinTx,
  assembleKeyChain,
  assertWrapEpochByMemberWithinTx,
  buildParentIndex,
  collectAncestorChain,
  exclusiveMessageIds,
  regenerableTailIds,
  reserveSequenceBlockWithinTx,
  resolveCallerMember,
  resolveCallerPublicKey,
  resolveConversationCaller,
  resolveForkTipWithinTx,
} from './domain/index.js';
export type {
  ConversationCaller,
  ParentChainRow,
  ParentIndex,
  WrapEpochByMemberAssertion,
} from './domain/index.js';
export type { ConversationsStores, MemberRecord, SenderChainRow } from './ports/index.js';
export type { MembershipRevoker, RealtimeBroadcast } from './ports/index.js';
