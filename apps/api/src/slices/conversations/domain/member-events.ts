import { createEvent } from '@hushbox/realtime/events';
import type { MemberPrivilege } from '@hushbox/shared';
import type { RealtimeBroadcast } from '../ports/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The membership realtime events, broadcast POST-COMMIT for group live-sync: a
 * second device learns a member joined, left, or changed privilege — and, on a
 * rotation, re-fetches the new epoch keychain (without `rotation:complete` a
 * connected device silently fails to decrypt post-rotation messages).
 * Best-effort: a failed broadcast is logged by the route, never unwound — the
 * mutation already committed and a client resync recovers.
 */

export function broadcastMemberAdded(
  realtime: RealtimeBroadcast,
  params: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly userId?: string | undefined;
    readonly privilege: MemberPrivilege;
  }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('member:added', {
        conversationId: params.conversationId,
        memberId: params.memberId,
        ...(params.userId === undefined ? {} : { userId: params.userId }),
        privilege: params.privilege,
      })
    )
    .map((): void => undefined);
}

export function broadcastMemberRemoved(
  realtime: RealtimeBroadcast,
  params: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly userId?: string | undefined;
  }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('member:removed', {
        conversationId: params.conversationId,
        memberId: params.memberId,
        ...(params.userId === undefined ? {} : { userId: params.userId }),
      })
    )
    .map((): void => undefined);
}

export function broadcastMemberPrivilegeChanged(
  realtime: RealtimeBroadcast,
  params: {
    readonly conversationId: string;
    readonly memberId: string;
    readonly privilege: MemberPrivilege;
  }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('member:privilege-changed', {
        conversationId: params.conversationId,
        memberId: params.memberId,
        privilege: params.privilege,
      })
    )
    .map((): void => undefined);
}

export function broadcastRotationComplete(
  realtime: RealtimeBroadcast,
  params: { readonly conversationId: string; readonly newEpochNumber: number }
): ResultAsync<void, DomainError> {
  return realtime
    .broadcast(
      params.conversationId,
      createEvent('rotation:complete', {
        conversationId: params.conversationId,
        newEpochNumber: params.newEpochNumber,
      })
    )
    .map((): void => undefined);
}
