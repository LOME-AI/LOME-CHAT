import { createEvent } from '@hushbox/realtime/events';
import type { RealtimeBroadcast } from '../ports/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The fork realtime events, broadcast POST-COMMIT for multi-device sync (a
 * second tab or device sees a branch appear, rename, or disappear without a
 * refetch). Best-effort: a failed broadcast is logged by the route, never
 * unwound — the mutation already committed and a client resync recovers.
 */

export function broadcastForkCreated(
  realtime: RealtimeBroadcast,
  params: {
    readonly conversationId: string;
    readonly forkId: string;
    readonly name: string;
    readonly tipMessageId: string | null;
  }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('fork:created', {
        forkId: params.forkId,
        conversationId: params.conversationId,
        name: params.name,
        tipMessageId: params.tipMessageId,
      })
    )
    .map((): void => undefined);
}

export function broadcastForkRenamed(
  realtime: RealtimeBroadcast,
  params: { readonly conversationId: string; readonly forkId: string; readonly name: string }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('fork:renamed', {
        forkId: params.forkId,
        conversationId: params.conversationId,
        name: params.name,
      })
    )
    .map((): void => undefined);
}

export function broadcastForkDeleted(
  realtime: RealtimeBroadcast,
  params: { readonly conversationId: string; readonly forkId: string }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('fork:deleted', {
        forkId: params.forkId,
        conversationId: params.conversationId,
      })
    )
    .map((): void => undefined);
}
