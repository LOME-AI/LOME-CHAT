import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * A device token paired with its owning user. The prune on a dead token is
 * user-scoped (`deleteByToken(userId, token)`), so the userId must travel with
 * the token all the way to the send seam.
 */
export interface PushRecipient {
  readonly userId: string;
  readonly token: string;
}

export interface PushMessage {
  readonly recipients: readonly PushRecipient[];
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
}

export interface PushDelivery {
  readonly successCount: number;
  readonly failureCount: number;
  /**
   * Recipients FCM reported as permanently gone (`UNREGISTERED`/`NOT_FOUND`).
   * The caller prunes exactly these via `deleteByToken`; absent means none.
   */
  readonly deadTokens?: readonly PushRecipient[];
}

/**
 * The push seam (FCM in production, in-process mock elsewhere). Best-effort
 * by doctrine: per-token failures are counted, never thrown, and device
 * tokens must never appear in error messages or logs.
 */
export interface PushSender {
  send(message: PushMessage): ResultAsync<PushDelivery, DomainError>;
}
