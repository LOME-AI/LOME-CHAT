import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

export interface PushMessage {
  readonly tokens: readonly string[];
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
}

export interface PushDelivery {
  readonly successCount: number;
  readonly failureCount: number;
}

/**
 * The push seam (FCM in production, in-process mock elsewhere). Best-effort
 * by doctrine: per-token failures are counted, never thrown, and device
 * tokens must never appear in error messages or logs.
 */
export interface PushSender {
  send(message: PushMessage): ResultAsync<PushDelivery, DomainError>;
}
