import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { wrapEpochKeyForNewMember } from '@hushbox/crypto';
import { fromBase64, toBase64, type MemberPrivilege } from '@hushbox/shared';
import {
  useConversationMembers,
  useAddMember,
  useRemoveMember,
  useChangePrivilege,
  useLeaveConversation,
} from '@/hooks/realtime/use-conversation-members.js';
import {
  useConversationLinks,
  useRevokeLink,
  useChangeLinkPrivilege,
} from '@/hooks/realtime/use-conversation-links.js';
import { useConversationWebSocket } from '@/hooks/realtime/use-conversation-websocket.js';
import { usePresence } from '@/hooks/realtime/use-presence.js';
import { useRealtimeSync } from '@/hooks/realtime/use-realtime-sync.js';
import { useRemoteStreaming } from '@/hooks/realtime/use-remote-streaming.js';
import { useTypingIndicators } from '@/hooks/realtime/use-typing-indicators.js';
import { useAdminLinkName } from '@/hooks/realtime/use-link-name.js';
import { getCurrentEpoch, getEpochKey, subscribe, getSnapshot } from '@/lib/epoch-key-cache.js';
import { leaveConversation } from '@/lib/leave-conversation.js';
import { executeWithRotation } from '@/lib/rotation.js';
import type { MemberKeyResponse, RotationMember } from '@/lib/rotation.js';
import type { GroupChatProps } from '@/components/chat/message/types.js';

type RawMember = GroupChatProps['members'][number] & { linkId?: string | null };

/** A terminal access-revoked response (link revoked, member removed, gone). */
function isAccessRevokedStatus(status: unknown): boolean {
  return status === 401 || status === 403 || status === 404;
}

interface MemoPrerequisites {
  conversationId: string;
  callerId: string;
  allMembers: RawMember[];
  currentMember: RawMember;
  epochNumber: number;
  epochKey: Uint8Array;
}

/** Validates all prerequisites needed by the useMemo callback. */
function resolveMemoPrerequisites(
  conversationId: string | null,
  allMembers: RawMember[] | undefined,
  callerId: string | undefined
): MemoPrerequisites | undefined {
  if (!conversationId || !allMembers || !callerId) return undefined;

  const currentMember = allMembers.find((m) => m.userId === callerId || m.id === callerId);
  if (!currentMember) return undefined;

  const epochNumber = getCurrentEpoch(conversationId);
  if (epochNumber === undefined) return undefined;
  const epochKey = getEpochKey(conversationId, epochNumber);
  if (!epochKey) return undefined;

  return { conversationId, callerId, allMembers, currentMember, epochNumber, epochKey };
}

export function useGroupChat(
  conversationId: string | null,
  callerId: string | undefined,
  plaintextTitle?: string
): GroupChatProps | undefined {
  const navigate = useNavigate();

  const membersQuery = useConversationMembers(conversationId);
  const linksQuery = useConversationLinks(conversationId);
  const allMembers = (membersQuery.data as { members: RawMember[] } | undefined)?.members;
  const isGroup = (allMembers?.length ?? 0) > 1;
  // Tie the realtime socket to access. TanStack keeps the last members list on
  // error, so a terminal 401/403/404 (link revoked / member removed) would
  // otherwise leave `isGroup` true and the socket retrying a handshake that can
  // never succeed — each failed reconnect logs a browser error. Drop the socket
  // the moment access is gone; 4xx is terminal (the query layer never retries it).
  // Keyed on the members query — the canonical access signal for both members
  // and link guests (both fetch `/api/members/:id`).
  const accessRevoked = isAccessRevokedStatus(
    (membersQuery.error as { status?: unknown } | null)?.status
  );
  const ws = useConversationWebSocket(isGroup && !accessRevoked ? conversationId : null);
  const presenceMap = usePresence(ws);
  useRealtimeSync(ws, conversationId, callerId ?? null);
  const remoteStreamingMessages = useRemoteStreaming(ws);
  const typingUserIds = useTypingIndicators(ws);

  const removeMember = useRemoveMember();
  const changePrivilege = useChangePrivilege();
  const revokeLink = useRevokeLink();
  const changeLinkPrivilege = useChangeLinkPrivilege();
  const leaveMutation = useLeaveConversation();
  const addMember = useAddMember();
  const adminLinkName = useAdminLinkName();

  // Subscribe to epoch key cache changes for reactivity
  const cacheVersion = React.useSyncExternalStore(subscribe, getSnapshot);

  const links = (linksQuery.data as { links: GroupChatProps['links'] } | undefined)?.links;

  // Stable refs for mutation functions to avoid re-creating callbacks
  const removeMemberRef = React.useRef(removeMember.mutateAsync);
  removeMemberRef.current = removeMember.mutateAsync;

  const changePrivilegeRef = React.useRef(changePrivilege.mutateAsync);
  changePrivilegeRef.current = changePrivilege.mutateAsync;

  const revokeLinkRef = React.useRef(revokeLink.mutateAsync);
  revokeLinkRef.current = revokeLink.mutateAsync;

  const changeLinkPrivilegeRef = React.useRef(changeLinkPrivilege.mutateAsync);
  changeLinkPrivilegeRef.current = changeLinkPrivilege.mutateAsync;

  const leaveRef = React.useRef(leaveMutation.mutateAsync);
  leaveRef.current = leaveMutation.mutateAsync;

  const addMemberRef = React.useRef(addMember.mutateAsync);
  addMemberRef.current = addMember.mutateAsync;

  const adminNameRef = React.useRef(adminLinkName.mutateAsync);
  adminNameRef.current = adminLinkName.mutateAsync;

  return React.useMemo((): GroupChatProps | undefined => {
    const prereqs = resolveMemoPrerequisites(conversationId, allMembers, callerId);
    if (!prereqs) return undefined;
    const {
      conversationId: resolvedConversationId,
      callerId: resolvedCallerId,
      allMembers: resolvedMembers,
      currentMember,
      epochNumber,
      epochKey,
    } = prereqs;

    const onlineMemberIds = new Set<string>();
    for (const key of presenceMap.keys()) {
      onlineMemberIds.add(key);
    }

    // Filter out link guest members — they are displayed via the links array instead
    const displayMembers = resolvedMembers.filter((m) => !m.linkId);

    return {
      conversationId: resolvedConversationId,
      members: displayMembers.map((m) => ({
        id: m.id,
        userId: m.userId,
        username: m.username,
        privilege: m.privilege,
      })),
      links: (links ?? []).map((l) => ({
        id: l.id,
        displayName: l.displayName,
        privilege: l.privilege,
        createdAt: l.createdAt,
      })),
      onlineMemberIds,
      currentUserId: resolvedCallerId,
      currentUserLinkId: currentMember.linkId ?? null,
      currentUserPrivilege: currentMember.privilege as MemberPrivilege,
      currentEpochPrivateKey: epochKey,
      currentEpochNumber: epochNumber,
      typingUserIds,
      remoteStreamingMessages,
      ws: ws ?? undefined,
      onRemoveMember: async (memberId: string): Promise<void> => {
        const removedUserId = resolvedMembers.find((m) => m.id === memberId)?.userId;
        const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
          const result: RotationMember[] = [];
          for (const k of keys) {
            if (
              k.memberId !== memberId &&
              (removedUserId === undefined || k.userId !== removedUserId)
            ) {
              result.push({ publicKey: fromBase64(k.publicKey) });
            }
          }
          return result;
        };
        await executeWithRotation({
          conversationId: resolvedConversationId,
          currentEpochPrivateKey: epochKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) =>
            removeMemberRef.current({ conversationId: resolvedConversationId, memberId, rotation }),
        });
      },
      onChangePrivilege: async (memberId: string, newPrivilege: string): Promise<void> => {
        await changePrivilegeRef.current({
          conversationId: resolvedConversationId,
          memberId,
          privilege: newPrivilege,
        });
      },
      onRevokeLinkClick: async (linkId: string): Promise<void> => {
        const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
          const result: RotationMember[] = [];
          for (const k of keys) {
            if (k.linkId !== linkId) result.push({ publicKey: fromBase64(k.publicKey) });
          }
          return result;
        };
        await executeWithRotation({
          conversationId: resolvedConversationId,
          currentEpochPrivateKey: epochKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) =>
            revokeLinkRef.current({ conversationId: resolvedConversationId, linkId, rotation }),
        });
      },
      onSaveLinkName: async (linkId: string, newName: string): Promise<void> => {
        await adminNameRef.current({
          conversationId: resolvedConversationId,
          linkId,
          displayName: newName,
        });
      },
      onChangeLinkPrivilege: async (linkId: string, newPrivilege: string): Promise<void> => {
        await changeLinkPrivilegeRef.current({
          conversationId: resolvedConversationId,
          linkId,
          privilege: newPrivilege as 'read' | 'write',
        });
      },
      onLeave: async (): Promise<void> => {
        await leaveConversation({
          conversationId: resolvedConversationId,
          callerId: resolvedCallerId,
          plaintextTitle: plaintextTitle ?? '',
          privilege: currentMember.privilege as MemberPrivilege,
          leave: leaveRef.current,
        });
        void navigate({ to: '/chat' });
      },
      onAddMember: async (params: {
        userId: string;
        username: string;
        publicKey: string;
        privilege: string;
        giveFullHistory: boolean;
      }): Promise<void> => {
        if (params.giveFullHistory) {
          const wrap = wrapEpochKeyForNewMember(epochKey, fromBase64(params.publicKey));
          await addMemberRef.current({
            conversationId: resolvedConversationId,
            userId: params.userId,
            wrap: toBase64(wrap),
            privilege: params.privilege,
            giveFullHistory: true,
          });
          return;
        }
        const newMemberKey = fromBase64(params.publicKey);
        const filter = (keys: MemberKeyResponse[]): RotationMember[] => {
          const result: RotationMember[] = [];
          for (const k of keys) {
            result.push({ publicKey: fromBase64(k.publicKey) });
          }
          result.push({ publicKey: newMemberKey });
          return result;
        };
        await executeWithRotation({
          conversationId: resolvedConversationId,
          currentEpochPrivateKey: epochKey,
          currentEpochNumber: epochNumber,
          plaintextTitle: plaintextTitle ?? '',
          filterMembers: filter,
          execute: (rotation) =>
            addMemberRef.current({
              conversationId: resolvedConversationId,
              userId: params.userId,
              privilege: params.privilege,
              giveFullHistory: false,
              rotation,
            }),
        });
      },
    };
  }, [
    conversationId,
    allMembers,
    links,
    callerId,
    presenceMap,
    typingUserIds,
    remoteStreamingMessages,
    ws,
    navigate,
    cacheVersion,
  ]);
}
