export { createConversationsManifest } from './routes.js';
export type { ConversationsRouteDeps } from './routes.js';
export { createConversationsStores } from './adapters/stores.js';
export {
  MEMBERSHIP_CACHE_TTL_SECONDS,
  MEMBERSHIP_FRESHNESS_MS,
  MEMBERSHIP_LAST_KNOWN_GOOD_MS,
  createDbMembershipSource,
  createMembershipRevoker,
  createRedisMembershipCache,
  membershipCacheKey,
} from './adapters/membership.js';
export { createRealtimeBroadcast } from './adapters/realtime-do.js';
export { publicShareReadRateLimit } from './adapters/rate-limit.js';
// createRoomBindings is deliberately NOT re-exported: it value-imports the
// realtime barrel (workerd-only via `cloudflare:workers`), and this barrel
// must stay loadable in node tests. Its only consumer is the DO class in
// ./adapters/realtime-room.ts, which src/index.ts exports directly.
// The unified parent-chain module — the published walk for message ancestry
// and epoch key chains; the chat slice consumes these instead of re-walking.
export {
  assembleKeyChain,
  assertWrapEpochWithinTx,
  buildParentIndex,
  collectAncestorChain,
  exclusiveMessageIds,
} from './domain/index.js';
export type { ParentChainRow, ParentIndex, WrapEpochAssertion } from './domain/index.js';
export type { ConversationsStores } from './ports/index.js';
export type { MembershipRevoker, RealtimeBroadcast } from './ports/index.js';
