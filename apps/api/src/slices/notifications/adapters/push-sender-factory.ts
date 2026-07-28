import { createEnvUtilities } from '@hushbox/shared';
import { createMockPushSender } from './push-mock.js';
import { createFcmPushSender } from './push-fcm.js';
import { createWebPushSender } from './push-webpush.js';
import { createCompositePushSender } from './push-composite.js';
import { createCollapseAliasDeriver } from './collapse-alias.js';
import type { EnvContext } from '@hushbox/shared';
import type { MockPushSender } from './push-mock.js';
import type { PushMessage, PushSender } from '../ports/index.js';

interface PushSenderEnv extends EnvContext {
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
  NOTIFICATION_TAG_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface CapturedPush {
  readonly id: string;
  readonly message: PushMessage;
}

/**
 * The dev push log: every message a factory-built MOCK transport received,
 * across all instances (the factory constructs fresh mocks per request, so a
 * per-instance record would be invisible to the dev viewer). Module-level
 * state is admissible here only because the mock path never runs in
 * production — the real transports are never captured.
 */
const capturedPushes: CapturedPush[] = [];
let pushCounter = 0;

/**
 * Records what a mock transport is handed. The wrap sits on the mock
 * *partitions* the composite dispatches to, not on the composite itself: the
 * composite derives and stamps the collapse alias on its way down, so only a
 * message observed below it carries the alias and its platform partition. The
 * alias is never re-derived here — deriving it is the composite's job alone.
 */
function withPushCapture(mock: MockPushSender): PushSender {
  return {
    send: (message) =>
      mock.send(message).map((delivery) => {
        pushCounter += 1;
        capturedPushes.push({ id: `push-${String(pushCounter)}`, message });
        return delivery;
      }),
  };
}

/** Newest-last list of every mock-delivered push (dev push viewer). */
export function listCapturedPushes(): readonly CapturedPush[] {
  return [...capturedPushes];
}

/**
 * envUtils-gated composite sender. Every mode returns the composite (FCM +
 * Web Push behind one seam); local dev and CI back both partitions with the
 * in-process mock (no real push leaves either mode), production wires the real
 * FCM and in-house Web Push transports. The collapse-alias HMAC key is required
 * in every mode — it is stamped on the mock too — and missing FCM/VAPID
 * credentials in production fail fast (there is no degraded mode).
 */
export function createPushSenderFromEnv(env: PushSenderEnv): PushSender {
  // Explicit fail-fast at the selection seam: createEnvUtilities throws on an
  // absent NODE_ENV, and this guard restates that with a sender-specific message
  // so a production deploy that omitted it fails loudly instead of ever risking
  // the mock (which drops every notification).
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV must be set explicitly to select a push sender');
  }
  if (env.NOTIFICATION_TAG_SECRET === undefined) {
    throw new Error('NOTIFICATION_TAG_SECRET is required to derive push collapse aliases');
  }
  const deriveCollapseKey = createCollapseAliasDeriver(env.NOTIFICATION_TAG_SECRET);

  const { isLocalDev, isCI } = createEnvUtilities(env);

  if (isLocalDev || isCI) {
    return createCompositePushSender({
      fcm: withPushCapture(createMockPushSender()),
      webPush: withPushCapture(createMockPushSender()),
      deriveCollapseKey,
    });
  }

  if (env.FCM_PROJECT_ID === undefined || env.FCM_SERVICE_ACCOUNT_JSON === undefined) {
    throw new Error(
      'FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_JSON are required outside local dev and CI'
    );
  }
  if (
    env.VAPID_PUBLIC_KEY === undefined ||
    env.VAPID_PRIVATE_KEY === undefined ||
    env.VAPID_SUBJECT === undefined
  ) {
    throw new Error(
      'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT are required outside local dev and CI'
    );
  }

  return createCompositePushSender({
    fcm: createFcmPushSender({
      projectId: env.FCM_PROJECT_ID,
      serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON,
    }),
    webPush: createWebPushSender({
      vapid: {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      },
    }),
    deriveCollapseKey,
  });
}
