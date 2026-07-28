import type { PushEventPayload } from '@hushbox/shared';
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
  /**
   * The generic wire payload — a category and the conversation it points at,
   * and nothing else. There is deliberately no title, body, or free-form text
   * field: each transport looks the words up in the shared copy table from the
   * category, exactly as the service worker does at display time. The remaining
   * field, `conversationId`, is a bare string in the type, so the composite
   * validates it against the shared conversation-id schema before dispatch —
   * that check, not the type, is what stops text riding it. The raw id itself
   * does reach FCM by design; the collapse-key note below covers that.
   */
  readonly payload: PushEventPayload;
  /**
   * The per-conversation collapse alias (a truncated HMAC of the
   * conversationId, never the raw id — the generic-payload law). The composite
   * sender derives and stamps it before dispatch; each transport applies it as
   * its collapse identity, and nowhere else: the FCM `collapse_key`, the APNs
   * `apns-collapse-id` header, and the Web Push `Topic` header. Absent only on
   * a message that has not passed through the composite yet — every production
   * send does, because the composite is the sole construction site.
   *
   * The Android notification `tag` is deliberately NOT this alias — it carries
   * the raw conversationId, and so does the FCM data payload, so the raw id
   * does reach FCM on the native path by design. The alias protects the
   * push-service-visible collapse fields, which is what the Web Push transport
   * (whose payload is encrypted) would otherwise leak. The FCM adapter carries
   * the reasoning where it sets the tag.
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
