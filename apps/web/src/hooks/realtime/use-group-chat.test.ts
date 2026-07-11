import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMembers = [
  { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
  { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
];

const mockLinks = [
  { id: 'l1', displayName: 'Dave', privilege: 'read', createdAt: '2026-01-01T00:00:00Z' },
];

const mockPresenceMap = new Map([
  ['u1', { userId: 'u1', displayName: 'alice', isGuest: false, connectedAt: 1 }],
]);

const mockRemoveMutateAsync = vi.fn().mockResolvedValue({});
const mockChangeMutateAsync = vi.fn().mockResolvedValue({});
const mockRevokeMutateAsync = vi.fn().mockResolvedValue({});
const mockLeaveMutateAsync = vi.fn().mockResolvedValue({});
const mockAddMutateAsync = vi.fn().mockResolvedValue({});
const mockAdminNameMutateAsync = vi.fn().mockResolvedValue({});
const mockChangeLinkPrivilegeMutateAsync = vi.fn().mockResolvedValue({});
const mockNavigate = vi.fn();

vi.mock('@/lib/auth.js', () => ({
  useAuthStore: Object.assign(
    vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        user: { id: 'u1', email: 'a@b.com', username: 'alice' },
      })
    ),
    { getState: vi.fn(() => ({ user: { id: 'u1' } })) }
  ),
}));

vi.mock('@/hooks/realtime/use-conversation-members.js', () => ({
  useConversationMembers: vi.fn(() => ({
    data: { members: mockMembers },
    isLoading: false,
    isError: false,
  })),
  useAddMember: vi.fn(() => ({ mutateAsync: mockAddMutateAsync })),
  useRemoveMember: vi.fn(() => ({ mutateAsync: mockRemoveMutateAsync })),
  useChangePrivilege: vi.fn(() => ({ mutateAsync: mockChangeMutateAsync })),
  useLeaveConversation: vi.fn(() => ({ mutateAsync: mockLeaveMutateAsync })),
}));

vi.mock('@/hooks/realtime/use-conversation-links.js', () => ({
  useConversationLinks: vi.fn(() => ({
    data: { links: mockLinks },
    isLoading: false,
    isError: false,
  })),
  useRevokeLink: vi.fn(() => ({ mutateAsync: mockRevokeMutateAsync })),
  useChangeLinkPrivilege: vi.fn(() => ({ mutateAsync: mockChangeLinkPrivilegeMutateAsync })),
}));

vi.mock('@/hooks/realtime/use-conversation-websocket.js', () => ({
  useConversationWebSocket: vi.fn(() => null),
}));

vi.mock('@/hooks/realtime/use-presence.js', () => ({
  usePresence: vi.fn(() => mockPresenceMap),
}));

const mockUseRealtimeSync = vi.fn();
vi.mock('@/hooks/realtime/use-realtime-sync.js', () => ({
  useRealtimeSync: (...args: unknown[]) => mockUseRealtimeSync(...args),
}));

const mockRemoteStreamingMap = new Map();
vi.mock('@/hooks/realtime/use-remote-streaming.js', () => ({
  useRemoteStreaming: vi.fn(() => mockRemoteStreamingMap),
}));

const mockTypingUserIds = new Set<string>();
vi.mock('@/hooks/realtime/use-typing-indicators.js', () => ({
  useTypingIndicators: vi.fn(() => mockTypingUserIds),
}));

vi.mock('@/hooks/realtime/use-link-name.js', () => ({
  useAdminLinkName: vi.fn(() => ({ mutateAsync: mockAdminNameMutateAsync })),
}));

vi.mock('@/lib/epoch-key-cache.js', () => ({
  getCurrentEpoch: vi.fn(() => 3),
  getEpochKey: vi.fn(() => new Uint8Array(32).fill(7)),
  subscribe: vi.fn(() => vi.fn()),
  getSnapshot: vi.fn(() => 0),
}));

const mockExecuteWithRotation = vi.fn().mockResolvedValue({
  params: {
    expectedEpoch: 3,
    epochPublicKey: 'ep',
    confirmationHash: 'ch',
    chainLink: 'cl',
    encryptedTitle: 'et',
    memberWraps: [],
  },
  newEpochPrivateKey: new Uint8Array(32).fill(8),
  newEpochNumber: 4,
});
vi.mock('@/lib/rotation.js', () => ({
  executeWithRotation: (...args: unknown[]) => mockExecuteWithRotation(...args),
}));

vi.mock('@hushbox/crypto', () => ({
  wrapEpochKeyForNewMember: vi.fn(() => new Uint8Array(32).fill(9)),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
    toBase64: vi.fn(() => 'base64wrap'),
  };
});

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => mockNavigate),
}));

import { wrapEpochKeyForNewMember } from '@hushbox/crypto';
import { useGroupChat } from '@/hooks/realtime/use-group-chat.js';
import { useConversationMembers } from '@/hooks/realtime/use-conversation-members.js';
import { useConversationLinks } from '@/hooks/realtime/use-conversation-links.js';
import { getCurrentEpoch, getEpochKey, getSnapshot } from '@/lib/epoch-key-cache.js';
import { useRemoteStreaming } from '@/hooks/realtime/use-remote-streaming.js';
import { useTypingIndicators } from '@/hooks/realtime/use-typing-indicators.js';
import { useConversationWebSocket } from '@/hooks/realtime/use-conversation-websocket.js';

describe('useGroupChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentEpoch).mockReturnValue(3);
    vi.mocked(getEpochKey).mockReturnValue(new Uint8Array(32).fill(7));
    mockExecuteWithRotation.mockResolvedValue({
      params: {
        expectedEpoch: 3,
        epochPublicKey: 'ep',
        confirmationHash: 'ch',
        chainLink: 'cl',
        encryptedTitle: 'et',
        memberWraps: [],
      },
      newEpochPrivateKey: new Uint8Array(32).fill(8),
      newEpochNumber: 4,
    });
    vi.mocked(useConversationMembers).mockReturnValue({
      data: { members: mockMembers },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);
    vi.mocked(useConversationLinks).mockReturnValue({
      data: { links: mockLinks },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationLinks>);
  });

  it('returns undefined for null conversationId', () => {
    const { result } = renderHook(() => useGroupChat(null, 'u1'));

    expect(result.current).toBeUndefined();
  });

  it.each([
    { scenario: 'the invite link is revoked', status: 401 },
    { scenario: 'the caller is no longer a member', status: 404 },
  ])('drops the websocket when $scenario ($status)', ({ status }) => {
    // Stale members keep `isGroup` true, but a terminal 4xx means access is gone.
    // The socket must be torn down so it stops retrying a doomed handshake.
    vi.mocked(useConversationMembers).mockReturnValue({
      data: { members: mockMembers },
      error: Object.assign(new Error('access denied'), { status }),
      isError: true,
    } as unknown as ReturnType<typeof useConversationMembers>);

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useConversationWebSocket).toHaveBeenCalledWith(null);
  });

  it('returns undefined when callerId is undefined', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- callerId is a required positional argument
    const { result } = renderHook(() => useGroupChat('conv-1', undefined));

    expect(result.current).toBeUndefined();
  });

  it('returns undefined while members are loading', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeUndefined();
  });

  it('returns GroupChatProps with correct members shape', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeDefined();
    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
      { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
    ]);
  });

  it('returns GroupChatProps with correct links shape', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.links).toEqual([
      { id: 'l1', displayName: 'Dave', privilege: 'read', createdAt: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('uses callerId to find current member instead of auth store', () => {
    // Set callerId to 'u2' (bob) — should find bob's member, not alice
    const { result } = renderHook(() => useGroupChat('conv-1', 'u2'));

    expect(result.current!.currentUserId).toBe('u2');
    expect(result.current!.currentUserPrivilege).toBe('write');
  });

  it('derives currentUserPrivilege from members list', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.currentUserPrivilege).toBe('owner');
  });

  it('reads currentEpochPrivateKey from epoch cache', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.currentEpochPrivateKey).toEqual(new Uint8Array(32).fill(7));
    expect(getEpochKey).toHaveBeenCalledWith('conv-1', 3);
  });

  it('reads currentEpochNumber from epoch cache', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.currentEpochNumber).toBe(3);
  });

  it('onRemoveMember calls executeWithRotation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRemoveMember!('m2');
    });

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(7),
        currentEpochNumber: 3,
        plaintextTitle: 'My Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('onRemoveMember filterMembers excludes removed member and includes metadata', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRemoveMember!('m2');
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0] as {
      filterMembers: (
        keys: {
          memberId: string;
          userId: string | null;
          publicKey: string;
          privilege: string;
          visibleFromEpoch: number;
        }[]
      ) => { publicKey: Uint8Array }[];
    };
    const testKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'pk1',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm2',
        userId: 'u2',
        linkId: null,
        publicKey: 'pk2',
        privilege: 'write',
        visibleFromEpoch: 1,
      },
    ];
    const filtered = call.filterMembers(testKeys);
    // Should exclude m2 (the removed member) — only m1 remains
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
  });

  it('onChangePrivilege calls mutation with correct params', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    act(() => {
      void result.current!.onChangePrivilege!('m2', 'admin');
    });

    expect(mockChangeMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      memberId: 'm2',
      privilege: 'admin',
    });
  });

  it('onRevokeLinkClick calls executeWithRotation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRevokeLinkClick!('l1');
    });

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        plaintextTitle: 'My Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('onRevokeLinkClick filterMembers excludes link member and includes metadata', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onRevokeLinkClick!('l1');
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0] as {
      filterMembers: (
        keys: {
          linkId: string | null;
          publicKey: string;
          privilege: string;
          visibleFromEpoch: number;
        }[]
      ) => { publicKey: Uint8Array }[];
    };
    const testKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'pk1',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm3',
        userId: null,
        linkId: 'l1',
        publicKey: 'pk3',
        privilege: 'read',
        visibleFromEpoch: 1,
      },
    ];
    const filtered = call.filterMembers(testKeys);
    // Should exclude l1 (the revoked link) — only m1 remains
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
  });

  it('onSaveLinkName calls admin link name mutation with new name', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    act(() => {
      void result.current!.onSaveLinkName!('l1', 'NewName');
    });

    expect(mockAdminNameMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      linkId: 'l1',
      displayName: 'NewName',
    });
  });

  it('onChangeLinkPrivilege calls change link privilege mutation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    act(() => {
      void result.current!.onChangeLinkPrivilege!('l1', 'write');
    });

    expect(mockChangeLinkPrivilegeMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      linkId: 'l1',
      privilege: 'write',
    });
  });

  it('onLeave as owner calls mutation directly without rotation', async () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    // eslint-disable-next-line @typescript-eslint/require-await -- async needed so act() returns Promise and flushes .then() chain
    await act(async () => {
      void result.current!.onLeave!();
    });

    // Owner leave — no rotation needed (deletes conversation)
    expect(mockLeaveMutateAsync).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('onLeave as non-owner calls executeWithRotation then navigates', async () => {
    // Make current user a non-owner member
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'write' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'owner' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    // eslint-disable-next-line @typescript-eslint/require-await -- async needed so act() returns Promise and flushes .then() chain
    await act(async () => {
      void result.current!.onLeave!();
    });

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        plaintextTitle: 'My Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('onLeave filterMembers excludes self and includes metadata', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'write' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'owner' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onLeave!();
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0] as {
      filterMembers: (
        keys: {
          userId: string | null;
          publicKey: string;
          privilege: string;
          visibleFromEpoch: number;
        }[]
      ) => { publicKey: Uint8Array }[];
    };
    const testKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'pk1',
        privilege: 'write',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm2',
        userId: 'u2',
        linkId: null,
        publicKey: 'pk2',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
    ];
    const filtered = call.filterMembers(testKeys);
    // Should exclude u1 (self) — only m2 remains
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
  });

  it('onAddMember with full history wraps epoch key directly', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onAddMember!({
        userId: 'u3',
        username: 'charlie',
        publicKey: 'cGssPublic',
        privilege: 'write',
        giveFullHistory: true,
      });
    });

    expect(wrapEpochKeyForNewMember).toHaveBeenCalled();
    expect(mockAddMutateAsync).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      userId: 'u3',
      wrap: 'base64wrap',
      privilege: 'write',
      giveFullHistory: true,
    });
    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
  });

  it('onAddMember without history calls executeWithRotation', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onAddMember!({
        userId: 'u3',
        username: 'charlie',
        publicKey: 'cGssPublic',
        privilege: 'write',
        giveFullHistory: false,
      });
    });

    expect(wrapEpochKeyForNewMember).not.toHaveBeenCalled();
    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        plaintextTitle: 'My Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('onAddMember without history filterMembers includes new member with metadata', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1', 'My Chat'));

    act(() => {
      void result.current!.onAddMember!({
        userId: 'u3',
        username: 'charlie',
        publicKey: 'cGssPublic',
        privilege: 'write',
        giveFullHistory: false,
      });
    });

    const call = mockExecuteWithRotation.mock.calls[0]![0] as {
      filterMembers: (
        keys: { publicKey: string; privilege: string; visibleFromEpoch: number }[]
      ) => { publicKey: Uint8Array }[];
    };
    const testKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'pk1',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
    ];
    const filtered = call.filterMembers(testKeys);
    // Should include existing member + new member → 2 entries
    expect(filtered).toHaveLength(2);
    // Both entries only have publicKey (no metadata)
    expect(filtered[0]!.publicKey).toBeInstanceOf(Uint8Array);
    expect(filtered[1]!.publicKey).toBeInstanceOf(Uint8Array);
  });

  it('onlineMemberIds derived from presence map', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.onlineMemberIds).toEqual(new Set(['u1']));
  });

  it('handles links query error gracefully with empty array', () => {
    vi.mocked(useConversationLinks).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useConversationLinks>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.links).toEqual([]);
  });

  it('returns props for solo conversation with one member', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeDefined();
    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    ]);
    expect(result.current!.currentUserId).toBe('u1');
    expect(result.current!.currentUserPrivilege).toBe('owner');
  });

  it('does not create WebSocket for solo conversation', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useConversationWebSocket).toHaveBeenCalledWith(null);
  });

  it('returns undefined if current user not found in members', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [{ id: 'm9', userId: 'u99', username: 'stranger', privilege: 'write' }],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current).toBeUndefined();
  });

  it('calls useRealtimeSync with ws, conversationId, and userId', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(mockUseRealtimeSync).toHaveBeenCalledWith(mockWs, 'conv-1', 'u1');
  });

  it('calls useRemoteStreaming with the shared ws', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useRemoteStreaming).toHaveBeenCalledWith(mockWs);
  });

  it('calls useTypingIndicators with ws', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(useTypingIndicators).toHaveBeenCalledWith(mockWs);
  });

  it('returns typingUserIds in GroupChatProps', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.typingUserIds).toBe(mockTypingUserIds);
  });

  it('returns remoteStreamingMessages in GroupChatProps', () => {
    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.remoteStreamingMessages).toBe(mockRemoteStreamingMap);
  });

  it('returns ws in GroupChatProps', () => {
    const mockWs = { on: vi.fn(), send: vi.fn(), close: vi.fn() };
    vi.mocked(useConversationWebSocket).mockReturnValue(
      mockWs as unknown as ReturnType<typeof useConversationWebSocket>
    );

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.ws).toBe(mockWs);
  });

  it('excludes link guest members from returned members array', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
          { id: 'm3', userId: 'l1', linkId: 'l1', username: 'Guest 1', privilege: 'read' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'u1'));

    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
      { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
    ]);
  });

  it('link guest can authenticate as currentMember via callerId matching member id', () => {
    vi.mocked(useConversationMembers).mockReturnValue({
      data: {
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm3', userId: 'l1', linkId: 'l1', username: 'Guest 1', privilege: 'read' },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationMembers>);
    vi.mocked(useConversationLinks).mockReturnValue({
      data: {
        links: [
          {
            id: 'l1',
            displayName: 'Guest 1',
            privilege: 'read',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useConversationLinks>);

    const { result } = renderHook(() => useGroupChat('conv-1', 'l1'));

    expect(result.current).toBeDefined();
    expect(result.current!.currentUserId).toBe('l1');
    expect(result.current!.currentUserPrivilege).toBe('read');
    // Link guest should not appear in the display members — shown as LinkRow instead
    expect(result.current!.members).toEqual([
      { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    ]);
  });

  it('re-computes epoch key when cache version changes', () => {
    // Initial render with cache version 0 — epoch key is fill(7)
    vi.mocked(getSnapshot).mockReturnValue(0);
    const { result, rerender } = renderHook(() => useGroupChat('conv-1', 'u1'));
    expect(result.current!.currentEpochPrivateKey).toEqual(new Uint8Array(32).fill(7));

    // Simulate cache update: new epoch key cached, version bumps
    const newKey = new Uint8Array(32).fill(42);
    vi.mocked(getEpochKey).mockReturnValue(newKey);
    vi.mocked(getSnapshot).mockReturnValue(1);

    rerender();

    expect(result.current!.currentEpochPrivateKey).toEqual(newKey);
  });
});
