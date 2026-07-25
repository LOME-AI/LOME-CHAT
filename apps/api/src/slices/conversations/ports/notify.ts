import type { Database } from '@hushbox/db';
import type { Bindings } from '../../../lib/context/index.js';

/**
 * The best-effort notification capability the routes fire after a membership
 * mutation commits. Bound at the composition root because building it needs the
 * notifications barrel, which this slice may not import.
 *
 * Presence rides the CALLER's fire-time snapshot — there is no presence port
 * and the notifications slice never queries the room. The capability resolves
 * void and never throws: a notification failure can never fail the mutation
 * that triggered it.
 */
export interface ConversationEventNotification {
  readonly conversationId: string;
  /** The user who caused the event; excluded from their own notification. */
  readonly actorUserId: string | null;
  /** Narrows the notification to these users; absent means every active member. */
  readonly recipientUserIds?: readonly string[] | undefined;
  /** Users watching the conversation at fire time; suppressed downstream. */
  readonly presentUserIds: readonly string[];
}

export type NotifyConversationEvent = (
  notification: ConversationEventNotification
) => Promise<void>;

/**
 * Built per request, because the capability needs the request's env (push
 * configuration) and db. Construction itself may throw on a misconfigured
 * deploy, so callers build it inside the fire-and-forget task.
 */
export type NotifyConversationEventFactory = (
  env: Bindings,
  db: Database
) => NotifyConversationEvent;
