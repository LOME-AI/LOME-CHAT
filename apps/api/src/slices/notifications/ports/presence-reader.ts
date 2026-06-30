import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * Narrow read-only view of conversation presence (who has an open socket),
 * used to suppress push for users already watching the conversation. The
 * authoritative source is the conversations slice's realtime surface
 * (ConversationRoom DO `presence()`); the conversations slice publishes no
 * barrel yet, so the composition root binds this port to it when that surface
 * lands — this slice never imports another slice's internals.
 */
export interface PresenceReader {
  /** Deduplicated authenticated userIds with an open socket. */
  presence(conversationId: string): ResultAsync<readonly string[], DomainError>;
}
