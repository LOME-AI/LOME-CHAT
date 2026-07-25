import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/**
 * A dead device reference — the prune key. `token` is the unique
 * `device_tokens.token` value (the FCM/APNs token for native rows, the Web
 * Push endpoint URL for web rows), so the user-scoped `deleteByToken(userId,
 * token)` prune reaches exactly one row.
 */
export interface PushDeviceRef {
  readonly userId: string;
  readonly token: string;
}

/**
 * A push target, tagged by platform so the composite sender can route it to
 * the right transport. Native rows carry the device token; web rows carry the
 * subscription endpoint and its encryption keys. `userId` rides along on every
 * arm so a dead target prunes with the user-scoped `deleteByToken`.
 */
export type PushRecipient =
  | { readonly platform: 'ios' | 'android'; readonly userId: string; readonly token: string }
  | {
      readonly platform: 'web';
      readonly userId: string;
      readonly endpoint: string;
      readonly p256dh: string;
      readonly auth: string;
    };

export interface PushMessage {
  readonly recipients: readonly PushRecipient[];
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
  /**
   * The per-conversation collapse alias (a truncated HMAC of the
   * conversationId, never the raw id — the generic-payload law). The composite
   * sender derives and stamps it before dispatch; each transport applies it as
   * its collapse identity (FCM `collapse_key` + notification `tag`, Web Push
   * `Topic`). Absent when the message is not conversation-scoped.
   */
  readonly collapseKey?: string;
}

export interface PushDelivery {
  readonly successCount: number;
  readonly failureCount: number;
  /**
   * Targets the push service accepted. The caller refreshes exactly these
   * through `touchLastSeen`, which is what keeps a device that only ever
   * receives pushes (never re-registering) out of the retention delete;
   * absent means none.
   */
  readonly deliveredTokens?: readonly PushDeviceRef[];
  /**
   * Targets the push service reported as permanently gone (FCM
   * `UNREGISTERED`/`NOT_FOUND`, Web Push 404/410). The caller prunes exactly
   * these via `deleteByToken`; absent means none.
   */
  readonly deadTokens?: readonly PushDeviceRef[];
}

/**
 * The push seam (a composite over FCM + in-house Web Push in production, the
 * in-process mock elsewhere). Best-effort by doctrine: per-target failures are
 * counted, never thrown, and device tokens/endpoints must never appear in
 * error messages or logs.
 */
export interface PushSender {
  send(message: PushMessage): ResultAsync<PushDelivery, DomainError>;
}
