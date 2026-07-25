import { z } from 'zod';

/**
 * The closed set of push notification categories. One source feeding the wire
 * payload schema and the server-evaluated controls; adding a member is a
 * deliberate change, never ad-hoc data.
 */
export const NOTIFICATION_CATEGORIES = ['message', 'runCompletion', 'membership'] as const;

/** Zod schema for a notification category. */
export const notificationCategorySchema = z.enum(NOTIFICATION_CATEGORIES);

/** A push notification category. */
export type NotificationCategory = z.infer<typeof notificationCategorySchema>;

/**
 * Conversation ids are server-generated UUIDs (uuidv7). Push payloads are
 * untrusted, so the id is validated against this shape before it is
 * interpolated into a navigation path — blocking traversal/token injection.
 * The single shared implementation: the service worker, the push send path, and
 * the Capacitor tap handler all validate against this one schema, never a copy.
 */
export const conversationIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * The generic, content-free push wire payload: an event category plus the
 * conversation deep-link target. `strictObject` rejects unknown keys so a
 * payload can never smuggle sender names, titles, or message content past the
 * generic-payload law.
 */
export const pushEventPayloadSchema = z.strictObject({
  category: notificationCategorySchema,
  conversationId: conversationIdSchema,
});

/** A validated generic push payload. */
export type PushEventPayload = z.infer<typeof pushEventPayloadSchema>;

/** A fixed notification title and body — no user-generated content, ever. */
export interface NotificationCopy {
  readonly title: string;
  readonly body: string;
}

/**
 * The only text a delivered notification may carry, keyed solely by category.
 * There are two places a category becomes words — the worker fills the native
 * shade, the service worker fills the web notification from an encrypted
 * payload that carries no text — and this is the one table both read, so the
 * two surfaces cannot say different things about the same event.
 */
export const NOTIFICATION_COPY: Readonly<Record<NotificationCategory, NotificationCopy>> = {
  message: { title: 'New message', body: 'You have a new message.' },
  // Every category's words must read correctly for anyone who receives them:
  // a completed run notifies co-members of the conversation as well as the
  // person who started it, so this body stays impersonal.
  runCompletion: { title: 'Response ready', body: 'A response is ready to view.' },
  membership: { title: 'Conversation update', body: 'A conversation you are in was updated.' },
};

/** Resolve the generic copy for a notification category. */
export function notificationCopyForCategory(category: NotificationCategory): NotificationCopy {
  return NOTIFICATION_COPY[category];
}
