import { ResultAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushRecipient,
  PushSender,
} from '../ports/index.js';

export interface CompositePushSenderDeps {
  /** Handles the `ios`/`android` partition. */
  readonly fcm: PushSender;
  /** Handles the `web` partition. */
  readonly webPush: PushSender;
  /** Derives the per-conversation collapse alias (a truncated HMAC). */
  readonly deriveCollapseKey: (conversationId: string) => Promise<string>;
}

/**
 * The single `PushSender` the composition root binds. It derives the
 * per-conversation collapse alias, stamps it on every partition (so the push
 * services never see the raw conversationId in a visible header), routes native
 * targets to FCM and web targets to the in-house Web Push transport, and folds
 * the two deliveries into one. The domain stays channel-blind.
 */
export function createCompositePushSender(deps: CompositePushSenderDeps): PushSender {
  return {
    send(message: PushMessage): ResultAsync<PushDelivery, DomainError> {
      const conversationId = message.data?.['conversationId'];
      if (conversationId === undefined) {
        return fanOut(deps, message);
      }
      return fromPromise(deps.deriveCollapseKey(conversationId), (cause) =>
        unavailableError('collapse alias derivation failed', cause)
      ).andThen((collapseKey) => fanOut(deps, { ...message, collapseKey }));
    },
  };
}

/** Partitions the (already alias-stamped) message by platform and folds the two deliveries. */
function fanOut(
  deps: CompositePushSenderDeps,
  message: PushMessage
): ResultAsync<PushDelivery, DomainError> {
  const fcmTargets = message.recipients.filter((r) => r.platform !== 'web');
  const webTargets = message.recipients.filter((r) => r.platform === 'web');
  return ResultAsync.combine([
    dispatch(deps.fcm, message, fcmTargets),
    dispatch(deps.webPush, message, webTargets),
  ]).map(([fcm, web]) => combine(fcm, web));
}

function dispatch(
  sender: PushSender,
  message: PushMessage,
  targets: readonly PushRecipient[]
): ResultAsync<PushDelivery, DomainError> {
  if (targets.length === 0) {
    return okAsync({ successCount: 0, failureCount: 0, deliveredTokens: [], deadTokens: [] });
  }
  return sender.send({ ...message, recipients: targets });
}

function combine(a: PushDelivery, b: PushDelivery): PushDelivery {
  const deliveredTokens: PushDeviceRef[] = [
    ...(a.deliveredTokens ?? []),
    ...(b.deliveredTokens ?? []),
  ];
  const deadTokens: PushDeviceRef[] = [...(a.deadTokens ?? []), ...(b.deadTokens ?? [])];
  return {
    successCount: a.successCount + b.successCount,
    failureCount: a.failureCount + b.failureCount,
    deliveredTokens,
    deadTokens,
  };
}
