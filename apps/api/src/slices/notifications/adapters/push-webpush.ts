import { pushEventPayloadSchema } from '@hushbox/shared';
import { ResultAsync, errAsync, okAsync } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { sendWebPush } from './webpush/index.js';
import type { VapidKeys, WebPushSendResult } from './webpush/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushRecipient,
  PushSender,
} from '../ports/index.js';

const NOTHING: PushDelivery = {
  successCount: 0,
  failureCount: 0,
  deliveredTokens: [],
  deadTokens: [],
};

/** RFC 8030 TTL: how long the push service retains an undelivered message. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

type WebRecipient = Extract<PushRecipient, { platform: 'web' }>;

export interface WebPushSenderConfig {
  readonly vapid: VapidKeys;
  readonly fetchImpl?: typeof fetch;
  /** Retention TTL header; defaults to 24h. */
  readonly ttl?: number;
}

/**
 * The Web Push transport as a `PushSender`, driving the in-house single-
 * recipient `sendWebPush` primitive over the web partition of a message. The
 * generic wire payload (`category` + `conversationId`) is encoded once and
 * encrypted per subscription; the collapse alias rides the RFC 8030 `Topic`
 * header. A 404/410 lands the subscription in `deadTokens` (keyed by its
 * endpoint, the unique `device_tokens.token`); every other rejection is a
 * counted best-effort failure with no retry.
 */
export function createWebPushSender(config: WebPushSenderConfig): PushSender {
  const ttl = config.ttl ?? DEFAULT_TTL_SECONDS;
  // Resolve the transport once: production omits `fetchImpl` and gets the
  // platform `fetch`; tests inject a capturing one.
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    send(message: PushMessage): ResultAsync<PushDelivery, DomainError> {
      const web = message.recipients.filter(
        (recipient): recipient is WebRecipient => recipient.platform === 'web'
      );
      if (web.length === 0) {
        return okAsync(NOTHING);
      }
      const parsed = pushEventPayloadSchema.safeParse(message.data);
      if (!parsed.success) {
        return errAsync(
          validationError('web push requires a generic {category, conversationId} payload')
        );
      }
      const payload = new TextEncoder().encode(JSON.stringify(parsed.data));
      const options = {
        ttl,
        ...(message.collapseKey === undefined ? {} : { topic: message.collapseKey }),
      };
      return ResultAsync.combine(
        web.map((recipient) =>
          sendWebPush(
            { endpoint: recipient.endpoint, p256dh: recipient.p256dh, auth: recipient.auth },
            payload,
            options,
            { vapid: config.vapid, fetchImpl }
          )
            .map((result) => ({ recipient, result }))
            // A transport exception is a best-effort failure, never a short-circuit.
            .orElse(() =>
              okAsync<{ recipient: WebRecipient; result: WebPushSendResult }, DomainError>({
                recipient,
                result: { outcome: 'failed', statusCode: 0 },
              })
            )
        )
      ).map((outcomes) => tally(outcomes));
    },
  };
}

function tally(
  outcomes: readonly { readonly recipient: WebRecipient; readonly result: WebPushSendResult }[]
): PushDelivery {
  let successCount = 0;
  let failureCount = 0;
  const deliveredTokens: PushDeviceRef[] = [];
  const deadTokens: PushDeviceRef[] = [];
  for (const { recipient, result } of outcomes) {
    if (result.outcome === 'delivered') {
      successCount++;
      deliveredTokens.push({ userId: recipient.userId, token: recipient.endpoint });
      continue;
    }
    failureCount++;
    if (result.outcome === 'dead') {
      deadTokens.push({ userId: recipient.userId, token: recipient.endpoint });
    }
  }
  return { successCount, failureCount, deliveredTokens, deadTokens };
}
