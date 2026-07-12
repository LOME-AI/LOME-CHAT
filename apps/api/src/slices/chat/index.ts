export { createChatManifest } from './manifest.js';
export { regenerateTurnBodySchema, startTurnBodySchema } from './routes.js';
export { createChatConversationRuntime } from './conversation-runtime.js';
export type { ChatConversationRuntimeDeps } from './conversation-runtime.js';
export { createChatStores } from './adapters/stores.js';
// The composition root composes this with the conversations presign reads to
// build media's PresignReaders (chat owns content_items + messages).
export { findContentItemForPresign } from './adapters/presign-reads.js';
export type { ContentItemPresignRow } from './adapters/presign-reads.js';
export { createForkMessageDeleter, deleteForkMessagesWithinTx } from './adapters/fork-messages.js';
// Identity's account-deletion transaction composes these published writes —
// the storage-key capture and the foreign-message sender scrub — inside its
// one settlement transaction (single-writer: chat owns messages/content_items).
export {
  captureContentStorageKeysWithinTx,
  detachMessageSendersWithinTx,
} from './adapters/account-deletion.js';
export {
  CHAT_STREAM_USER_RATE_LIMIT,
  CHAT_TURN_ROUTE,
  PER_WALLET_CONCURRENT_RUN_CAP,
  buildSingleModelTurn,
  createChatSettlementCommit,
  createConversationRuntime,
  createTurnCompileRegistries,
} from './domain/index.js';
export type {
  ChatRouteDeps,
  ChatSettlementDeps,
  ChatSettlementIdentity,
  ConversationRuntime,
  ConversationRuntimeDeps,
  EpochPublicKeyReader,
  NotifyNewMessage,
  TurnCompileRegistries,
} from './domain/index.js';
export type { ChatContentItemInput, ChatMessageInput, ChatStores } from './ports/stores.js';
