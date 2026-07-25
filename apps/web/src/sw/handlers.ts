import {
  pushEventPayloadSchema,
  conversationIdSchema,
  notificationCopyForCategory,
} from '@hushbox/shared';
import type { PushEventPayload } from '@hushbox/shared';

// The service worker is compiled against the DOM lib (the app's single tsconfig),
// which lacks the WebWorker service-worker globals (ServiceWorkerGlobalScope,
// PushEvent, ...). These narrow structural interfaces mirror the slice of that
// API the push-only worker uses, so the handlers stay fully typed without pulling
// the WebWorker lib into a DOM compilation (the two libs collide on shared names).

/** A window client the worker can focus, navigate, or message. */
export interface WindowClientLike {
  readonly focused: boolean;
  readonly url: string;
  // The worker awaits these for ordering but ignores their resolved values, so
  // the return types stay deliberately opaque.
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
  postMessage(message: unknown): void;
}

interface ClientsLike {
  matchAll(options?: {
    readonly type?: string;
    readonly includeUncontrolled?: boolean;
  }): Promise<readonly WindowClientLike[]>;
  openWindow(url: string): Promise<unknown>;
}

interface PushSubscriptionLike {
  toJSON(): unknown;
}

interface PushManagerLike {
  subscribe(options: {
    readonly userVisibleOnly: boolean;
    readonly applicationServerKey: ArrayBuffer;
  }): Promise<PushSubscriptionLike>;
}

interface RegistrationLike {
  readonly pushManager: PushManagerLike;
  showNotification(
    title: string,
    options: { readonly body: string; readonly tag: string; readonly data: PushEventPayload }
  ): Promise<void>;
}

/** The push-only surface of the service worker global scope. */
export interface ServiceWorkerScope {
  readonly clients: ClientsLike;
  readonly registration: RegistrationLike;
  // Only the three push-related events are ever registered — no `fetch`, so the
  // worker can never serve cached assets or become a second update mechanism.
  addEventListener(type: 'push', listener: (event: PushEventLike) => void): void;
  addEventListener(
    type: 'notificationclick',
    listener: (event: NotificationClickEventLike) => void
  ): void;
  addEventListener(
    type: 'pushsubscriptionchange',
    listener: (event: PushSubscriptionChangeEventLike) => void
  ): void;
}

interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}

/** A push delivery. `data` is null when the push carried no body. */
export interface PushEventLike extends ExtendableEventLike {
  readonly data: { json(): unknown } | null;
}

/** A click on a delivered notification; `data` is what we stored at show time. */
export interface NotificationClickEventLike extends ExtendableEventLike {
  readonly notification: { readonly data: unknown; close(): void };
}

/** The push service rotated the subscription; re-subscribe from the old key. */
export interface PushSubscriptionChangeEventLike extends ExtendableEventLike {
  readonly oldSubscription: {
    readonly options: { readonly applicationServerKey: ArrayBuffer | null };
  } | null;
}

const WINDOW_QUERY = { type: 'window', includeUncontrolled: true } as const;

/**
 * The conversation deep link. Written once because two rules read it: where a
 * click navigates, and which open page counts as "already looking at this
 * conversation". If those two drifted, a notification would be suppressed for
 * a page the click could never land on.
 */
const CONVERSATION_PATH_SEGMENT = 'chat';

function conversationUrl(conversationId: string): string {
  return `/${CONVERSATION_PATH_SEGMENT}/${conversationId}`;
}

/**
 * Whether an open page is the conversation the push is about. Matched on whole
 * path segments — a substring test would let one conversation's id swallow a
 * longer id that merely starts with it.
 */
function viewsConversation(client: WindowClientLike, conversationId: string): boolean {
  const segments = new URL(client.url).pathname.split('/').filter((part) => part.length > 0);
  return segments[0] === CONVERSATION_PATH_SEGMENT && segments[1] === conversationId;
}

function readPushData(event: PushEventLike): unknown {
  if (event.data === null) return undefined;
  try {
    return event.data.json();
  } catch {
    // A push whose body is not JSON cannot be one of ours — drop it silently.
    return undefined;
  }
}

/**
 * Validate the push body, then raise a generic, content-free OS notification
 * tagged by conversation so a newer push for the same conversation collapses
 * onto the older one.
 *
 * The one case that gets nothing is the user already reading the conversation
 * the push is about: an OS notification would interrupt the screen they are
 * looking at, and it carries nothing that screen is not already showing. Any
 * other focused page — a different conversation, the blog, settings — still
 * gets the notification, because nothing there reveals the new activity.
 */
export async function handlePush(scope: ServiceWorkerScope, event: PushEventLike): Promise<void> {
  const parsed = pushEventPayloadSchema.safeParse(readPushData(event));
  if (!parsed.success) return;
  const payload = parsed.data;

  const windows = await scope.clients.matchAll(WINDOW_QUERY);
  if (windows.some((client) => client.focused && viewsConversation(client, payload.conversationId)))
    return;

  const copy = notificationCopyForCategory(payload.category);
  await scope.registration.showNotification(copy.title, {
    body: copy.body,
    tag: payload.conversationId,
    data: payload,
  });
}

function extractConversationId(data: unknown): unknown {
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)['conversationId']
    : undefined;
}

/**
 * Close the notification and focus (or open) a window on the conversation. The id
 * is re-validated against the shared conversation-id schema before it reaches the
 * URL — an untrusted or malformed data blob is dropped rather than navigated.
 */
export async function handleNotificationClick(
  scope: ServiceWorkerScope,
  event: NotificationClickEventLike
): Promise<void> {
  event.notification.close();
  const parsed = conversationIdSchema.safeParse(extractConversationId(event.notification.data));
  if (!parsed.success) return;

  const url = conversationUrl(parsed.data);
  const windows = await scope.clients.matchAll(WINDOW_QUERY);
  const existing = windows[0];
  if (existing) {
    await existing.focus();
    await existing.navigate(url);
    return;
  }
  await scope.clients.openWindow(url);
}

/**
 * On subscription rotation, re-subscribe with the same application server key,
 * then ask any open client to re-register the new subscription. The worker never
 * calls the API itself (it cannot carry the session cookie to the cross-origin
 * API); the next authenticated app start plus server-side dead-endpoint pruning
 * are the backstops when no client is open.
 */
export async function handlePushSubscriptionChange(
  scope: ServiceWorkerScope,
  event: PushSubscriptionChangeEventLike
): Promise<void> {
  const applicationServerKey = event.oldSubscription?.options.applicationServerKey ?? null;
  if (applicationServerKey === null) return;

  // Re-subscribing can reject (permission revoked, push service unreachable).
  // Notification delivery is best-effort: drop it and let the backstops — the next authenticated
  // app start re-registers, and the server prunes dead endpoints on 404/410 — carry
  // it, rather than surfacing an unhandled rejection through `waitUntil`.
  let subscription: PushSubscriptionLike;
  try {
    subscription = await scope.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  } catch {
    return;
  }

  const windows = await scope.clients.matchAll(WINDOW_QUERY);
  for (const client of windows) {
    client.postMessage({ type: 'pushsubscriptionchange', subscription: subscription.toJSON() });
  }
}
