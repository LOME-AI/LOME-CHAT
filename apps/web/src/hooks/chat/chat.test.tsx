import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  chatKeys,
  conversationQueryOptions,
  useConversations,
  useConversation,
  useMessages,
  useCreateConversation,
  useDeleteConversation,
  useUpdateConversation,
  useDecryptedConversations,
} from '@/hooks/chat/chat';
import { useSession } from '@/lib/auth';
import { client } from '@/lib/api-client';
import type { ReactNode } from 'react';

// Mock auth to break transitive import chain to api.ts (env parse)
let mockAuthState: Record<string, unknown> = { privateKey: null, user: { id: 'test-user' } };
vi.mock('@/lib/auth', () => ({
  useAuthStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) =>
    selector(mockAuthState)
  ),
  useSession: vi.fn(() => {
    const user = mockAuthState['user'];
    return {
      data: user ? { user, session: { id: (user as { id: string }).id } } : null,
      isPending: false,
    };
  }),
}));

// Mock crypto and epoch-key-cache (used by useDecryptedConversations)
const mockDecryptMessage = vi.fn();
vi.mock('@hushbox/crypto', () => ({
  decryptTextFromEpoch: (...args: unknown[]) => mockDecryptMessage(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
  };
});

const mockGetEpochKey = vi.fn(() => undefined as Uint8Array | undefined);
vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: () => mockGetEpochKey(),
  processKeyChain: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

const mockFetchJson = vi.fn();
vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      $get: vi.fn(),
      $post: vi.fn(),
      ':conversationId': {
        $get: vi.fn(),
        $delete: vi.fn(),
        $patch: vi.fn(),
        messages: {
          $get: vi.fn(),
        },
        keychain: {
          $get: vi.fn(),
        },
      },
      'member-keys': {
        batch: {
          $get: vi.fn(),
        },
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('chatKeys', () => {
  describe('all', () => {
    it('returns base chat key', () => {
      expect(chatKeys.all).toEqual(['chat']);
    });
  });

  describe('conversations', () => {
    it('returns conversations key array', () => {
      expect(chatKeys.conversations()).toEqual(['chat', 'conversations']);
    });
  });

  describe('conversation', () => {
    it('returns conversation key with id', () => {
      expect(chatKeys.conversation('conv-123')).toEqual(['chat', 'conversations', 'conv-123']);
    });
  });
});

describe('conversationQueryOptions', () => {
  it('returns correct queryKey for a given id', () => {
    const options = conversationQueryOptions('conv-abc');
    expect(options.queryKey).toEqual(['chat', 'conversations', 'conv-abc']);
  });

  it('returns a callable queryFn', () => {
    const options = conversationQueryOptions('conv-abc');
    expect(typeof options.queryFn).toBe('function');
  });

  it('uses the same queryKey as chatKeys.conversation', () => {
    const options = conversationQueryOptions('conv-xyz');
    expect(options.queryKey).toEqual(chatKeys.conversation('conv-xyz'));
  });
});

describe('useConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches conversations from API', async () => {
    const mockConversations = [
      {
        id: '1',
        userId: 'user-1',
        title: 'Test',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
      },
    ];
    mockFetchJson.mockResolvedValueOnce({
      conversations: mockConversations,
      nextCursor: null,
    });

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockConversations);
  });

  it('handles API errors', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetchJson).toHaveBeenCalled();
  });

  it('does not fetch when user is not authenticated', async () => {
    const previousState = mockAuthState;
    mockAuthState = { privateKey: null, user: null };

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    // Wait a tick to ensure query would have fired if enabled
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();

    mockAuthState = previousState;
  });

  it('does not fetch when masked by link-guest session', async () => {
    // Guards the link-guest path: Zustand still holds the logged-in user, but
    // useSession() returns null because getLinkGuestAuth() is active. The query
    // must respect the session mask — if it reads useAuthStore directly it will
    // fire under `credentials: 'omit'` and 401.
    vi.mocked(useSession).mockReturnValueOnce({ data: null, isPending: false });

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

describe('useConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('merges membership privilege and the session caller id onto the conversation', async () => {
    const mockConversation = {
      id: 'conv-1',
      title: 'Test',
      titleEpochNumber: 1,
      currentEpoch: 1,
      nextSequence: 0,
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    mockFetchJson.mockResolvedValueOnce({
      conversation: mockConversation,
      membership: {
        privilege: 'write',
        muted: false,
        pinned: false,
        accepted: true,
        visibleFromEpoch: 1,
      },
      forks: [],
    });

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    // Caller id comes from the session (mockAuthState.user.id), privilege from
    // membership — neither field is on the conversation payload anymore.
    expect(result.current.data).toEqual({
      ...mockConversation,
      callerId: 'test-user',
      callerPrivilege: 'write',
    });
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useConversation(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

describe('useMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches history and maps the slim view to MessageResponse', async () => {
    const historyMessages = [
      {
        id: 'msg-1',
        parentMessageId: null,
        sequenceNumber: 0,
        epochNumber: 1,
        senderType: 'user',
        senderId: 'user-1',
        wrappedContentKey: 'wrap-1',
        batchId: 'batch-1',
        contentItems: [
          {
            id: 'ci-1',
            position: 0,
            contentType: 'text',
            mimeType: null,
            byteLength: 12,
            encryptedBlob: 'blob-1',
          },
        ],
      },
      {
        id: 'msg-2',
        parentMessageId: 'msg-1',
        sequenceNumber: 1,
        epochNumber: 1,
        senderType: 'assistant',
        senderId: null,
        wrappedContentKey: 'wrap-2',
        batchId: 'batch-1',
        contentItems: [],
      },
    ];
    mockFetchJson.mockResolvedValueOnce({ messages: historyMessages, nextCursor: null });

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual([
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        wrappedContentKey: 'wrap-1',
        senderType: 'user',
        senderId: 'user-1',
        epochNumber: 1,
        sequenceNumber: 0,
        parentMessageId: null,
        batchId: 'batch-1',
        createdAt: '',
        contentItems: [
          {
            id: 'ci-1',
            contentType: 'text',
            position: 0,
            encryptedBlob: 'blob-1',
            storageKey: null,
            mimeType: null,
            sizeBytes: 12,
            width: null,
            height: null,
            durationMs: null,
            modelName: null,
            cost: null,
            isSmartModel: false,
          },
        ],
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        wrappedContentKey: 'wrap-2',
        senderType: 'ai',
        senderId: null,
        epochNumber: 1,
        sequenceNumber: 1,
        parentMessageId: 'msg-1',
        batchId: 'batch-1',
        createdAt: '',
        contentItems: [],
      },
    ]);
  });

  it('follows the cursor to load every page of history', async () => {
    mockFetchJson
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'msg-1',
            parentMessageId: null,
            sequenceNumber: 0,
            epochNumber: 1,
            senderType: 'user',
            senderId: 'user-1',
            wrappedContentKey: 'wrap-1',
            batchId: 'batch-1',
            contentItems: [],
          },
        ],
        nextCursor: '0',
      })
      .mockResolvedValueOnce({
        messages: [
          {
            id: 'msg-2',
            parentMessageId: 'msg-1',
            sequenceNumber: 1,
            epochNumber: 1,
            senderType: 'assistant',
            senderId: null,
            wrappedContentKey: 'wrap-2',
            batchId: 'batch-1',
            contentItems: [],
          },
        ],
        nextCursor: null,
      });

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    expect(result.current.data?.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('is disabled when conversationId is empty', () => {
    const { result } = renderHook(() => useMessages(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('handles API errors', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useMessages('invalid-id'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });
});

describe('useCreateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls POST /conversations with correct body', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: 'New Chat',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      title: 'New Chat',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockResponse);
  });

  it('sends an Idempotency-Key header', async () => {
    mockFetchJson.mockResolvedValueOnce({ conversation: { id: 'conv-1' } });

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(vi.mocked(client.conversations.$post)).toHaveBeenCalledWith(expect.anything(), {
      headers: { 'Idempotency-Key': expect.any(String) },
    });
  });

  it('creates conversation without firstMessage field', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('handles API errors correctly', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-error',
      title: 'Test',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

describe('useDeleteConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls DELETE /conversations/:id', async () => {
    const mockResponse = { deleted: true };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockResponse);
  });

  it('sends an Idempotency-Key header', async () => {
    mockFetchJson.mockResolvedValueOnce({ deleted: true });

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(vi.mocked(client.conversations[':conversationId'].$delete)).toHaveBeenCalledWith(
      expect.anything(),
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
  });

  it('handles 404 error when conversation already deleted', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('deleted-id');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles unauthorized error', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

describe('useUpdateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls PATCH /conversations/:id with title', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Updated Title',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: 'Updated Title', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data?.conversation.title).toBe('Updated Title');
  });

  it('sends an Idempotency-Key header', async () => {
    mockFetchJson.mockResolvedValueOnce({ conversation: { id: 'conv-1', title: 'x' } });

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: 'x', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(vi.mocked(client.conversations[':conversationId'].$patch)).toHaveBeenCalledWith(
      expect.anything(),
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
  });

  it('handles 404 error for non-existent conversation', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'invalid-id',
      data: { title: 'New Title', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles validation error for empty title', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Title is required'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: '', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title is required');
  });

  it('handles validation error for title exceeding max length', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Title too long'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    const longTitle = 'a'.repeat(256);
    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: longTitle, titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title too long');
  });
});

describe('useDecryptedConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('shows Encrypted conversation placeholder when decryption throws', async () => {
    const mockConversations = [
      {
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64encryptedblob',
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 0,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
      },
    ];
    mockFetchJson.mockResolvedValueOnce({ conversations: mockConversations, nextCursor: null });

    // Epoch key is available so decryption path is reached
    mockGetEpochKey.mockReturnValue(new Uint8Array(32).fill(1));
    // Decryption throws (e.g., wrong key or corrupt blob)
    mockDecryptMessage.mockImplementation(() => {
      throw new Error('Decryption failed');
    });

    const { result } = renderHook(() => useDecryptedConversations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data![0]!.title).toBe('Encrypted conversation');
  });

  it('calls batch endpoint instead of individual key endpoints', async () => {
    const mockConversations = [
      {
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64blob1',
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 0,
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
        muted: false,
      },
      {
        id: 'conv-2',
        userId: 'user-1',
        title: 'base64blob2',
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 0,
        createdAt: '2024-01-02',
        updatedAt: '2024-01-02',
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
        muted: false,
      },
    ];

    // First call: GET /conversations
    // Second call: GET /conversations/member-keys/batch
    mockFetchJson
      .mockResolvedValueOnce({ conversations: mockConversations, nextCursor: null })
      .mockResolvedValueOnce({
        keys: {
          'conv-1': { wraps: [], chainLinks: [], currentEpoch: 1 },
          'conv-2': { wraps: [], chainLinks: [], currentEpoch: 1 },
        },
        missing: [],
      });

    // Simulate needing keys (no cached epoch keys)
    mockGetEpochKey.mockReset();
    mockAuthState = { privateKey: new Uint8Array(32).fill(1), user: { id: 'test-user' } };

    const { result } = renderHook(() => useDecryptedConversations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    // Should have called fetchJson twice: once for conversations, once for batch keys
    expect(mockFetchJson).toHaveBeenCalledTimes(2);

    // Titles should show as Decrypting... since wraps are empty (no keys to unwrap)
    expect(result.current.data).toBeDefined();
    expect(result.current.data).toHaveLength(2);
  });
});
