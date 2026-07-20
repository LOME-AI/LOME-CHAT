import { fireAndForget } from './fire-and-forget.js';
import type { RealtimeEvent } from '@hushbox/realtime/events';
import type { Bindings } from '../types.js';

/**
 * Send a realtime event to all WebSocket connections in a conversation room.
 * The ConversationRoom DO fans out the event to all connected clients.
 *
 * No-ops gracefully if CONVERSATION_ROOM binding is unavailable (e.g., in tests)
 * or if env is undefined (tests that don't set c.env).
 */
export async function broadcastToRoom(
  env: Bindings | undefined,
  conversationId: string,
  event: RealtimeEvent
): Promise<{ sent: number }> {
  if (!env?.CONVERSATION_ROOM) {
    return { sent: 0 };
  }
  const id = env.CONVERSATION_ROOM.idFromName(conversationId);
  const stub = env.CONVERSATION_ROOM.get(id);

  const response = await stub.fetch(
    // eslint-disable-next-line sonarjs/no-clear-text-protocols -- internal DO routing, host is ignored
    new Request('http://internal/broadcast', {
      method: 'POST',
      body: JSON.stringify(event),
    })
  );
  const result: { sent: number } = await response.json();
  return result;
}

/**
 * Fire-and-forget broadcast of a realtime event to a conversation room.
 * Logs errors with event type and conversationId context.
 *
 * When `executionCtx` is provided, keeps the Cloudflare Worker isolate alive
 * until the broadcast completes (via `waitUntil`).
 */
export function broadcastFireAndForget(
  env: Bindings | undefined,
  conversationId: string,
  event: RealtimeEvent,
  executionCtx?: { waitUntil(p: Promise<unknown>): void }
): void {
  fireAndForget(
    broadcastToRoom(env, conversationId, event),
    `broadcast ${event.type} to ${conversationId}`,
    executionCtx
  );
}

/**
 * Query a conversation's Durable Object for the set of userIds currently
 * holding open WebSocket connections. Used at push-dispatch time to suppress
 * notifications for users who are actively viewing the conversation.
 *
 * Returns an empty set on any failure path (missing binding, non-OK response,
 * fetch rejection). Active-viewer suppression is best-effort optimization, not
 * a correctness requirement — falling back to "notify everyone" matches the
 * pre-feature behaviour and is the right failure mode.
 */
export async function getActiveConversationUserIds(
  env: Bindings | undefined,
  conversationId: string
): Promise<Set<string>> {
  if (!env?.CONVERSATION_ROOM) {
    return new Set();
  }

  try {
    const id = env.CONVERSATION_ROOM.idFromName(conversationId);
    const stub = env.CONVERSATION_ROOM.get(id);
    const response = await stub.fetch(
      // eslint-disable-next-line sonarjs/no-clear-text-protocols -- internal DO routing, host is ignored
      new Request('http://internal/presence', { method: 'GET' })
    );
    if (!response.ok) {
      console.error(`[presence:do-error] ${conversationId}: status ${String(response.status)}`);
      return new Set();
    }
    const body: { userIds: string[] } = await response.json();
    return new Set(body.userIds);
  } catch (error) {
    console.error(`[presence:do-error] ${conversationId}:`, error);
    return new Set();
  }
}
