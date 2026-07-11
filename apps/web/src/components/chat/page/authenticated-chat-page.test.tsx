import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { setEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import { AuthenticatedChatPage } from '@/components/chat/page/authenticated-chat-page';
import type { Message } from '@/lib/api';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  // Models TanStack's <Navigate>: it guards re-navigation by comparing its props
  // object by reference, so it fires once for a stable element but re-fires when
  // an inline element hands it fresh props each render. This lets a test detect
  // the render-loop regression that a value-only stub would hide.
  Navigate: (props: { to: string }) => {
    const previousPropsRef = React.useRef<object | null>(null);
    React.useLayoutEffect(() => {
      if (previousPropsRef.current !== props) {
        mockNavigate(props.to);
        previousPropsRef.current = props;
      }
    });
    return <div data-testid="navigate" data-to={props.to} />;
  },
}));

const mockSetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn().mockResolvedValue(null);

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidateQueries,
  }),
}));

interface MockChatLayoutProps {
  messages: Message[];
  onSubmit: (fundingSource: string) => void;
  onSubmitUserOnly?: () => void;
  inputValue: string;
  onInputChange: (v: string) => void;
  inputDisabled: boolean;
  isProcessing: boolean;
  historyCharacters: number;
  isAuthenticated: boolean;
  isLinkGuest?: boolean;
  callerPrivilege?: string;
  title?: string;
  isDecrypting?: boolean;
  conversationId?: string;
  groupChat?: { conversationId: string };
  streamingMessageIds?: Set<string>;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  onForkRename?: (forkId: string, currentName: string) => void;
  onForkDelete?: (forkId: string) => void;
}

function resolveConversationId(
  conversationId: string | undefined,
  groupChat: { conversationId: string } | undefined
): string {
  return conversationId ?? groupChat?.conversationId ?? '';
}

function resolveStreamingAttribute(
  streamingMessageIds: Set<string> | undefined
): Record<string, string> {
  if (!streamingMessageIds || streamingMessageIds.size === 0) return {};
  return { 'data-streaming-ids': [...streamingMessageIds].join(',') };
}

function boolAttribute(value: unknown): string {
  return value ? 'true' : 'false';
}

let capturedChatLayoutProps: MockChatLayoutProps | undefined;

vi.mock('@/components/chat/layout/chat-layout', () => ({
  ChatLayout: (props: MockChatLayoutProps) => {
    capturedChatLayoutProps = props;
    return (
      <div
        data-testid="chat-layout"
        data-decrypting={props.isDecrypting ? 'true' : undefined}
        data-conversation-id={resolveConversationId(props.conversationId, props.groupChat)}
        {...resolveStreamingAttribute(props.streamingMessageIds)}
        data-is-authenticated={boolAttribute(props.isAuthenticated)}
        data-is-link-guest={boolAttribute(props.isLinkGuest)}
        data-caller-privilege={props.callerPrivilege ?? 'none'}
        data-has-on-regenerate={boolAttribute(props.onRegenerate)}
        data-has-on-edit={boolAttribute(props.onEdit)}
        data-has-on-fork={boolAttribute(props.onFork)}
      >
        <div data-testid="message-count">{props.messages.length}</div>
        <div data-testid="history-characters">{props.historyCharacters}</div>
        <div data-testid="input-disabled">{String(props.inputDisabled)}</div>
        <div data-testid="is-processing">{String(props.isProcessing)}</div>
        <div data-testid="title">{props.title ?? ''}</div>
        <div data-testid="message-ids">{props.messages.map((m) => m.id).join(',')}</div>
        <input
          data-testid="input"
          value={props.inputValue}
          onChange={(event) => {
            props.onInputChange(event.target.value);
          }}
        />
        <button
          data-testid="submit"
          onClick={() => {
            props.onSubmit('personal_balance');
          }}
        >
          Submit
        </button>
        {props.onSubmitUserOnly && (
          <button data-testid="submit-user-only" onClick={props.onSubmitUserOnly}>
            Submit User Only
          </button>
        )}
        {props.onForkRename && (
          <button
            data-testid="trigger-fork-rename"
            onClick={() => {
              props.onForkRename?.('fork-1', 'Fork 1');
            }}
          >
            Trigger Fork Rename
          </button>
        )}
        {props.onForkDelete && (
          <button
            data-testid="trigger-fork-delete"
            onClick={() => {
              props.onForkDelete?.('fork-1');
            }}
          >
            Trigger Fork Delete
          </button>
        )}
        {props.onFork && (
          <button
            data-testid="trigger-fork"
            onClick={() => {
              props.onFork?.('msg-1');
            }}
          >
            Trigger Fork
          </button>
        )}
      </div>
    );
  },
}));

interface ChatPageStateMock {
  inputValue: string;
  setInputValue: ReturnType<typeof vi.fn>;
  clearInput: ReturnType<typeof vi.fn>;
  streamingMessageIds: Set<string>;
  streamingMessageIdsRef: { current: Set<string> };
  startStreaming: ReturnType<typeof vi.fn>;
  stopStreaming: ReturnType<typeof vi.fn>;
  persistingMessageIds: Set<string>;
  persistingMessageIdsRef: { current: Set<string> };
  stopPersisting: ReturnType<typeof vi.fn>;
}

const mockStartStreaming = vi.fn();
const mockStopStreaming = vi.fn();
const mockStopPersisting = vi.fn();
const mockSetInputValue = vi.fn();
const mockClearInput = vi.fn();
const streamingMessageIdsRef = { current: new Set<string>() };
const persistingMessageIdsRef = { current: new Set<string>() };

const mockUseChatPageState = vi.fn<() => ChatPageStateMock>();
vi.mock('@/hooks/chat/use-chat-page', () => ({
  useChatPageState: (): ChatPageStateMock => mockUseChatPageState(),
}));

const mockUseIsMobile = vi.fn<() => boolean>();
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: (): boolean => mockUseIsMobile(),
  };
});

interface ChatStreamMock {
  isStreaming: boolean;
  startStream: ReturnType<typeof vi.fn>;
  startRegenerateStream: ReturnType<typeof vi.fn>;
  stopRun: ReturnType<typeof vi.fn>;
}

const mockStartStream = vi.fn();
const mockStartRegenerateStream = vi.fn();
const mockStopRun = vi.fn();
const mockUseChatStream = vi.fn<() => ChatStreamMock>();
vi.mock('@/hooks/chat/use-chat-stream', () => {
  class ChatRequestError extends Error {
    constructor(
      public readonly code: string,
      public readonly details?: Record<string, unknown>,
      public readonly status?: number
    ) {
      super(code);
      this.name = 'ChatRequestError';
    }
  }
  class ChatRunFailedError extends Error {
    constructor(
      public readonly code: string,
      public readonly notBilled = true
    ) {
      super(code);
      this.name = 'ChatRunFailedError';
    }
  }
  return {
    useChatStream: (): ChatStreamMock => mockUseChatStream(),
    ChatRequestError,
    ChatRunFailedError,
  };
});

const mockSetError = vi.fn();
const mockClearError = vi.fn();
const mockClearAll = vi.fn();
interface MockChatError {
  id: string;
  content: string;
  retryable: boolean;
  failedUserMessage: { id: string; content: string };
}
const mockChatErrorState: { errorsByFork: Record<string, MockChatError | null> } = {
  errorsByFork: {},
};
vi.mock('@/stores/chat-error', () => ({
  MAIN_FORK_KEY: 'main',
  useChatErrorStore: Object.assign(
    (selector?: (state: typeof mockChatErrorState) => unknown) =>
      selector ? selector(mockChatErrorState) : mockChatErrorState,
    {
      getState: () => ({
        ...mockChatErrorState,
        setError: mockSetError,
        clearError: mockClearError,
        clearAll: mockClearAll,
      }),
    }
  ),
  createChatError: vi.fn(
    (params: { content: string; retryable: boolean; failedContent: string }) => ({
      id: 'error-id',
      content: params.content,
      retryable: params.retryable,
      failedUserMessage: { id: 'failed-msg-id', content: params.failedContent },
    })
  ),
}));

interface CreateConversationMock {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

const mockCreateConversationMutateAsync = vi.fn();
const mockUseCreateConversation = vi.fn<() => CreateConversationMock>();

interface ConversationQueryMock {
  data: { id: string; title: string; titleEpochNumber?: number; currentEpoch?: number } | undefined;
  isLoading: boolean;
}

const mockUseConversation = vi.fn<(id: string) => ConversationQueryMock>();

interface MessagesQueryMock {
  data: Message[] | undefined;
  isLoading: boolean;
}

const mockUseMessages = vi.fn<(id: string) => MessagesQueryMock>();

vi.mock('@/hooks/chat/chat', () => ({
  useCreateConversation: (): CreateConversationMock => mockUseCreateConversation(),
  useConversation: (id: string): ConversationQueryMock => mockUseConversation(id),
  useMessages: (id: string): MessagesQueryMock => mockUseMessages(id),
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
  DECRYPTING_TITLE: 'Decrypting...',
}));

let mockForksData: {
  id: string;
  conversationId: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}[] = [];

const mockDeleteForkMutate = vi.fn();
const mockCreateForkMutate = vi.fn();

vi.mock('@/hooks/chat/forks', () => ({
  useForks: () => ({ data: mockForksData, isLoading: false }),
  useCreateFork: () => ({ mutate: mockCreateForkMutate }),
  useDeleteFork: () => ({ mutate: mockDeleteForkMutate }),
  useRenameFork: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/chat/use-fork-messages', () => ({
  useForkMessages: (messages: Message[]) => messages,
}));

const mockSetActiveFork = vi.fn();
let mockActiveForkId: string | null = null;

vi.mock('@/stores/fork', () => ({
  useForkStore: Object.assign(
    () => ({
      activeForkId: mockActiveForkId,
      setActiveFork: mockSetActiveFork,
    }),
    {
      getState: () => ({
        activeForkId: mockActiveForkId,
        setActiveFork: mockSetActiveFork,
      }),
    }
  ),
}));

vi.mock('@/components/sidebar/rename-conversation-dialog', () => ({
  RenameConversationDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    value: string;
    onValueChange: (v: string) => void;
    onConfirm: () => void;
  }) => {
    return props.open ? (
      <div data-testid="rename-fork-dialog" data-value={props.value}>
        <button data-testid="confirm-rename" onClick={props.onConfirm}>
          Save
        </button>
      </div>
    ) : null;
  },
}));

vi.mock('@/components/sidebar/delete-conversation-dialog', () => ({
  DeleteConversationDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    onConfirm: () => void;
  }) => {
    return props.open ? (
      <div data-testid="delete-fork-dialog" data-title={props.title}>
        <button data-testid="confirm-delete" onClick={props.onConfirm}>
          Delete
        </button>
      </div>
    ) : null;
  },
}));

vi.mock('@/hooks/billing/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

interface PendingChatStoreMock {
  pendingMessage: string | null;
  clearPendingMessage: ReturnType<typeof vi.fn>;
}

const mockClearPendingMessage = vi.fn();
let mockPendingMessage: string | null = null;

vi.mock('@/stores/pending-chat', () => ({
  usePendingChatStore: (selector: (state: PendingChatStoreMock) => unknown) => {
    const state: PendingChatStoreMock = {
      pendingMessage: mockPendingMessage,
      clearPendingMessage: mockClearPendingMessage,
    };
    return selector(state);
  },
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const { createModelStoreStub, selectorFromState } = await import('@/test-utils/model-store-mock');
  return { ...actual, useModelStore: selectorFromState(createModelStoreStub()) };
});

const mockScrollToBottom = vi.fn();
vi.mock('@/hooks/use-scroll-behavior', () => ({
  useScrollBehavior: () => ({
    handleScroll: vi.fn(),
    scrollToBottom: mockScrollToBottom,
    bottomPadding: 800,
    isAutoScrollEnabled: true,
  }),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    generateChatTitle: (content: string) => `Chat: ${content.slice(0, 10)}`,
    toBase64: (data: Uint8Array) => `base64-${String(data[0])}`,
    fromBase64: (string_: string) =>
      new Uint8Array(Array.from(string_, (c) => c.codePointAt(0) ?? 0)),
  };
});

const mockPrivateKey = new Uint8Array(32).fill(1);

vi.mock('@hushbox/crypto', () => ({
  createFirstEpoch: () => ({
    epochPublicKey: new Uint8Array(32).fill(10),
    epochPrivateKey: new Uint8Array(32).fill(11),
    confirmationHash: new Uint8Array(32).fill(12),
    memberWraps: [
      { memberPublicKey: new Uint8Array(32).fill(13), wrap: new Uint8Array(48).fill(14) },
    ],
  }),
  getPublicKeyFromPrivate: () => new Uint8Array(32).fill(13),
  encryptTextForEpoch: () => new Uint8Array(64).fill(20),
  decryptTextFromEpoch: (_key: Uint8Array, _blob: Uint8Array) => 'Decrypted Title',
}));

let mockAuthPrivateKey: Uint8Array | null = mockPrivateKey;

vi.mock('@/lib/auth', () => ({
  useAuthStore: (selector: (state: { privateKey: Uint8Array | null }) => unknown) =>
    selector({ privateKey: mockAuthPrivateKey }),
  useSession: () => ({
    data: { user: { id: 'user-1' }, session: { id: 'session-1' } },
    isPending: false,
  }),
}));

vi.mock('@/hooks/crypto/use-decrypted-messages', () => ({
  useDecryptedMessages: (_conversationId: string | null, msgs: Message[] | undefined) => msgs ?? [],
}));

const mockUseGroupChat = vi.fn();
vi.mock('@/hooks/realtime/use-group-chat', () => ({
  useGroupChat: (...args: unknown[]) => mockUseGroupChat(...args),
}));

vi.mock('@/lib/chat-regeneration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat-regeneration')>();
  return { ...actual };
});

const mockFetchJson = vi.fn();
vi.mock('@/lib/api-client', () => ({
  client: {
    chat: new Proxy(
      {},
      {
        get: () => ({
          message: {
            $post: vi.fn(() => Promise.resolve(new Response())),
          },
        }),
      }
    ),
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

interface StreamOptions {
  onStart?: (data: {
    userMessageId: string;
    models: { modelId: string; assistantMessageId: string }[];
  }) => void;
  onToken?: (token: string, modelId: string) => void;
  onAllModelsComplete?: () => void;
  onAllStreamsSettled?: () => void;
}

interface SetupMocksOptions {
  pendingMessage?: string | null;
  isStreaming?: boolean;
  isPending?: boolean;
  conversationData?:
    | { id: string; title: string; titleEpochNumber?: number; currentEpoch?: number }
    | undefined;
  messagesData?: Message[] | undefined;
  isConversationLoading?: boolean;
  isMessagesLoading?: boolean;
  isMobile?: boolean;
  inputValue?: string;
}

function setupMocks(overrides: SetupMocksOptions = {}): void {
  const {
    pendingMessage = null,
    isStreaming = false,
    isPending = false,
    conversationData,
    messagesData,
    isConversationLoading = false,
    isMessagesLoading = false,
    isMobile = false,
    inputValue = '',
  } = overrides;

  mockPendingMessage = pendingMessage;

  mockUseChatPageState.mockReturnValue({
    inputValue,
    setInputValue: mockSetInputValue,
    clearInput: mockClearInput,
    streamingMessageIds: new Set<string>(),
    streamingMessageIdsRef,
    startStreaming: mockStartStreaming,
    stopStreaming: mockStopStreaming,
    persistingMessageIds: new Set<string>(),
    persistingMessageIdsRef,
    stopPersisting: mockStopPersisting,
  });

  mockUseChatStream.mockReturnValue({
    isStreaming,
    startStream: mockStartStream,
    startRegenerateStream: mockStartRegenerateStream,
    stopRun: mockStopRun,
  });

  mockUseCreateConversation.mockReturnValue({
    mutateAsync: mockCreateConversationMutateAsync,
    isPending,
  });

  mockUseConversation.mockReturnValue({
    data: conversationData,
    isLoading: isConversationLoading,
  });

  mockUseMessages.mockReturnValue({
    data: messagesData,
    isLoading: isMessagesLoading,
  });

  mockUseIsMobile.mockReturnValue(isMobile);
}

function setupSuccessfulCreation(): void {
  mockCreateConversationMutateAsync.mockResolvedValue({
    conversation: { id: 'conv-123' },
    isNew: true,
  });
  mockStartStream.mockResolvedValue({
    userMessageId: 'user-1',
    models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1', cost: '0' }],
  });
}

describe('AuthenticatedChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
    mockPendingMessage = null;
    streamingMessageIdsRef.current = new Set<string>();
    mockChatErrorState.errorsByFork = {};
    mockActiveForkId = null;
    mockForksData = [];
    mockAuthPrivateKey = mockPrivateKey;
    mockUseGroupChat.mockImplementation((conversationId: string | null) => {
      if (!conversationId) return;
      return {
        conversationId,
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
      };
    });
    setupMocks();
  });

  describe('create mode (routeConversationId === "new")', () => {
    it('redirects to chat list when no pending message', () => {
      setupMocks({ pendingMessage: null });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('does NOT redirect when pending message exists', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockCreateConversationMutateAsync).toHaveBeenCalled();
      });

      expect(mockNavigate).not.toHaveBeenCalledWith({ to: '/chat' });
    });

    it('shows user message immediately when pending message exists', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(screen.getByTestId('message-count')).toHaveTextContent('1');
      });
    });

    it('creates conversation with generated UUID and epoch fields', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockCreateConversationMutateAsync).toHaveBeenCalledWith({
          id: expect.any(String),
          title: 'base64-20',
          epochPublicKey: 'base64-10',
          confirmationHash: 'base64-12',
          memberWrap: 'base64-14',
        });
      });
    });

    it('clears pending message after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockClearPendingMessage).toHaveBeenCalled();
      });
    });

    it('shows loading state while creating conversation', () => {
      setupMocks({ pendingMessage: 'Hello', isPending: true });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      // Loading state is indicated by having a user message visible (from pendingMessage)
      // and inputDisabled being true until real conversation ID is set
      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });

    it('sets title from message content', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(screen.getByTestId('title')).toHaveTextContent('Chat: Hello AI');
      });
    });

    it('calls startStream after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: 'conv-123',
            models: ['test-model'],
            userMessage: expect.objectContaining({
              id: expect.any(String),
              content: expect.any(String),
            }),
            messagesForInference: [{ role: 'user', content: 'Hello AI' }],
          }),
          expect.objectContaining({
            onStart: expect.any(Function) as unknown,
            onToken: expect.any(Function) as unknown,
          })
        );
      });
    });

    it('handles onStart callback from stream', async () => {
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        });
        return Promise.resolve({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1', cost: '0' }],
        });
      });
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStreaming).toHaveBeenCalledWith(['assistant-1']);
      });
    });

    it('handles onToken callback from stream', async () => {
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        });
        options?.onToken?.('Hello', 'test-model');
        return Promise.resolve({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1', cost: '0' }],
        });
      });
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });
    });

    it('stops streaming after completion', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });
    });

    it('navigates back to chat on creation error', async () => {
      mockCreateConversationMutateAsync.mockRejectedValue(new Error('Creation failed'));
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('shows generic error to user when first-message stream fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockRejectedValue(new Error('Stream failed'));

      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          'main',
          expect.objectContaining({
            retryable: false,
          })
        );
      });

      consoleErrorSpy.mockRestore();
    });

    it('shows processing state when streaming', () => {
      setupMocks({ pendingMessage: 'Hello', isStreaming: true });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(screen.getByTestId('is-processing')).toHaveTextContent('true');
    });

    it('navigates to /chat/:uuid after successful creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({
          to: '/chat/$id',
          params: { id: 'conv-123' },
          replace: true,
          // create→real hop carries the fromCreate marker so the chat route
          // keeps its key stable and does not remount (see resolveChatPageKey).
          state: { fromCreate: true },
        });
      });
    });

    it('does not create conversation when accountPrivateKey is null', () => {
      mockAuthPrivateKey = null;
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      expect(mockCreateConversationMutateAsync).not.toHaveBeenCalled();
    });

    it('navigates to the real conversation before the first stream resolves', async () => {
      // The URL must reflect the created conversation as soon as its row exists,
      // not after the stream settles — otherwise a slow stream parks the page at
      // /chat/new. creationStartedRef prevents a re-fire when isCreateMode flips.
      setupSuccessfulCreation();
      // Hold the stream open so it never resolves during the assertion.
      mockStartStream.mockImplementation(() => new Promise(() => {}));

      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({
          to: '/chat/$id',
          params: { id: 'conv-123' },
          replace: true,
          state: { fromCreate: true },
        });
      });
    });

    it('keeps the first stream alive through the create→real transition', async () => {
      // create→real keeps ONE component instance so the first stream survives
      // the resolved-id flip from null to the new id and navigation completes
      // once the run settles.
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });

      let resolveStream: (() => void) | undefined;
      mockStartStream.mockImplementation(() => {
        return new Promise((resolve) => {
          resolveStream = (): void => {
            resolve({
              userMessageId: 'user-1',
              models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
              outcome: 'succeeded',
            });
          };
        });
      });

      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });

      resolveStream?.();

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({
          to: '/chat/$id',
          params: { id: 'conv-123' },
          replace: true,
          state: { fromCreate: true },
        });
      });
    });
  });

  describe('existing chat mode (routeConversationId === UUID)', () => {
    it('fetches conversation and messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseConversation).toHaveBeenCalledWith('conv-456');
      expect(mockUseMessages).toHaveBeenCalledWith('conv-456');
    });

    it('renders ChatLayout with isDecrypting while fetching', () => {
      setupMocks({
        isConversationLoading: true,
        isMessagesLoading: true,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toBeInTheDocument();
      expect(layout).toHaveAttribute('data-decrypting', 'true');
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('displays messages from API', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
          {
            id: 'm2',
            conversationId: 'conv-456',
            role: 'assistant',
            content: 'Hello',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });

    it('displays decrypted conversation title when epoch key available', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Decrypted Title');
    });

    it('displays Decrypting... when epoch key not available', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Decrypting...');
    });

    it('redirects if conversation not found', () => {
      setupMocks({
        conversationData: undefined,
        isConversationLoading: false,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
    });

    it('fires the redirect only once across re-renders (stable element, no loop)', () => {
      setupMocks({
        conversationData: undefined,
        isConversationLoading: false,
      });

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      rerender(<AuthenticatedChatPage routeConversationId="conv-456" />);
      rerender(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // The hoisted REDIRECT_TO_CHAT element keeps a stable props identity, so the
      // real <Navigate> navigates exactly once instead of re-firing on every
      // commit — the "Maximum update depth exceeded" loop on a 404 conversation.
      // An inline <Navigate> hands fresh props each render and would fire 3x here.
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledWith('/chat');
    });

    it('submits new message with optimistic update', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        userMessageId: 'user-2',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2', cost: '0' }],
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });

      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-456',
          models: ['test-model'],
          userMessage: expect.objectContaining({
            id: expect.any(String),
            content: 'New message',
          }),
          messagesForInference: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'New message' }),
          ]),
        }),
        expect.any(Object)
      );
    });

    it('does not submit empty message', async () => {
      const user = userEvent.setup();
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: '   ',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('streams assistant response after message sent', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: 'conv-456',
            models: ['test-model'],
          }),
          expect.any(Object)
        );
      });
    });

    it('passes displayTitle to useGroupChat for epoch rotation', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith('conv-456', undefined, 'Decrypted Title');
    });

    it('passes conversationId via groupChat to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith('conv-456', undefined, expect.anything());
      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('passes conversationId directly to ChatLayout even when groupChat is undefined', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument
      mockUseGroupChat.mockReturnValue(undefined);
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('passes undefined to useGroupChat initially for new conversation', () => {
      setupMocks({ pendingMessage: null });

      render(<AuthenticatedChatPage routeConversationId="new" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith(null, undefined, undefined);
    });

    it('passes realConversationId to useGroupChat after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockUseGroupChat).toHaveBeenCalledWith('conv-123', undefined, expect.anything());
      });
    });

    it('passes groupChat members from useGroupChat hook', () => {
      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
      });
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('calculates history characters from messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hello',
            createdAt: '',
          },
          {
            id: 'm2',
            conversationId: 'conv-456',
            role: 'assistant',
            content: 'Hi there',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // "Hello" (5) + "Hi there" (8) = 13
      expect(screen.getByTestId('history-characters')).toHaveTextContent('13');
    });

    it('appends phantom messages from remoteStreamingMessages to messages array', () => {
      const phantomMap = new Map([
        [
          'phantom-user-1',
          { content: 'Hello from Bob', senderType: 'user' as const, senderId: 'u2' },
        ],
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // 1 real message + 2 phantom messages = 3
      expect(screen.getByTestId('message-count')).toHaveTextContent('3');
      expect(screen.getByTestId('message-ids')).toHaveTextContent('m1,phantom-user-1,phantom-ai-1');
    });

    it('sets streamingMessageIds to remote AI phantom when no local streaming', () => {
      const phantomMap = new Map([
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute(
        'data-streaming-ids',
        'phantom-ai-1'
      );
    });

    it('deduplicates phantom messages whose IDs already exist in API messages', () => {
      const phantomMap = new Map([
        ['m1', { content: 'Hello from Bob', senderType: 'user' as const, senderId: 'u2' }],
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // phantom 'm1' should be deduped (already in API messages), only phantom-ai-1 remains
      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
      expect(screen.getByTestId('message-ids')).toHaveTextContent('m1,phantom-ai-1');
    });

    it('does not append phantom messages when remoteStreamingMessages is empty', () => {
      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: new Map(),
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });
  });

  // The hook re-enables the input on the early model:done flip, so a user can
  // start a second turn while the first is still settling. That only stays
  // race-free if every stop call releases ONLY the ids its own turn owns —
  // these assert the hook threads the correct scoped ids (multi-model) into
  // stopStreaming/stopPersisting, never a blanket clear. Pairs with
  // use-chat-page.test.ts, which proves scoped removal leaves a concurrent
  // turn intact.
  describe('scoped streaming-state release', () => {
    it('releases only the sent turn tile ids on completion (multi-model)', async () => {
      const user = userEvent.setup();
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-2',
          models: [
            { modelId: 'model-a', assistantMessageId: 'assistant-1' },
            { modelId: 'model-b', assistantMessageId: 'assistant-2' },
          ],
        });
        options?.onAllModelsComplete?.();
        options?.onAllStreamsSettled?.();
        return Promise.resolve({
          userMessageId: 'user-2',
          models: [
            { modelId: 'model-a', assistantMessageId: 'assistant-1', cost: '0' },
            { modelId: 'model-b', assistantMessageId: 'assistant-2', cost: '0' },
          ],
        });
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
      });
      expect(mockStopPersisting).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    });

    it('releases only the first turn tile ids after conversation creation (multi-model)', async () => {
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-1',
          models: [
            { modelId: 'model-a', assistantMessageId: 'assistant-1' },
            { modelId: 'model-b', assistantMessageId: 'assistant-2' },
          ],
        });
        return Promise.resolve({
          userMessageId: 'user-1',
          models: [
            { modelId: 'model-a', assistantMessageId: 'assistant-1', cost: '0' },
            { modelId: 'model-b', assistantMessageId: 'assistant-2', cost: '0' },
          ],
        });
      });
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
      });
      expect(mockStopPersisting).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    });

    it('releases only the sent turn placeholder ids when the send errors', async () => {
      const user = userEvent.setup();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-2',
          models: [{ modelId: 'model-a', assistantMessageId: 'assistant-1' }],
        });
        return Promise.reject(new Error('Stream failed'));
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1']);
      });
      consoleErrorSpy.mockRestore();
    });
  });

  describe('state reset on navigation', () => {
    it('resets state when navigating between existing conversations', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setEpochKey('conv-789', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-1', titleEpochNumber: 1 },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      setupMocks({
        conversationData: { id: 'conv-789', title: 'encrypted-2', titleEpochNumber: 1 },
        messagesData: [
          {
            id: 'm2',
            conversationId: 'conv-789',
            role: 'user',
            content: 'Different',
            createdAt: '',
          },
        ],
      });

      rerender(<AuthenticatedChatPage routeConversationId="conv-789" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Decrypted Title');
    });
  });

  describe('input handling', () => {
    it('disables input in create mode', () => {
      setupMocks({ pendingMessage: 'Hello' });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('enables input in existing chat mode', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });
      render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('false');
    });

    it('clears input after submit on desktop', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        userMessageId: 'user-2',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2', cost: '0' }],
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
        isMobile: false,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });
  });

  describe('send message error handling', () => {
    it('shows generic error to user for unrecognized errors', async () => {
      const user = userEvent.setup();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockStartStream.mockRejectedValue(new Error('Stream failed'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({
          retryable: false,
          failedUserMessage: expect.objectContaining({
            content: 'Test message',
          }),
        })
      );
      consoleErrorSpy.mockRestore();
    });

    it('sets retryable chat error and invalidates billing on an admission refusal', async () => {
      const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(
        new ChatRequestError('INSUFFICIENT_ADMISSION', undefined, 402)
      );

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ['balance'],
        });
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({
          retryable: true,
          failedUserMessage: expect.objectContaining({
            content: 'Test message',
          }),
        })
      );
    });

    it('sets non-retryable chat error on a validation refusal', async () => {
      const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new ChatRequestError('VALIDATION', undefined, 400));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          'main',
          expect.objectContaining({
            retryable: false,
            failedUserMessage: expect.objectContaining({
              content: 'Test message',
            }),
          })
        );
      });
    });

    it('sets a retryable chat error on the concurrent-run hard block (409)', async () => {
      const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new ChatRequestError('CONCURRENT_RUN', undefined, 409));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          'main',
          expect.objectContaining({
            retryable: true,
            failedUserMessage: expect.objectContaining({
              content: 'Test message',
            }),
          })
        );
      });
    });

    it('removes orphan AI placeholders when stream throws after onStart', async () => {
      const user = userEvent.setup();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());

      // Real-world failure shape: SSE `start` arrives (placeholder gets added
      // to optimistic state), then the stream fails — transport drop, billing
      // error past start, context-length error, etc. Without cleanup the empty
      // placeholder renders as an invisible AI bubble whose action toolbar
      // floats above the synthetic "Something went wrong" tile.
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-pending',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-orphan' }],
        });
        return Promise.reject(new Error('Stream failed after start'));
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalled();
      });

      await waitFor(() => {
        expect(screen.getByTestId('message-ids').textContent).not.toContain('assistant-orphan');
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe('error message in messages list', () => {
    it('appends error message to messages when chat error exists', () => {
      mockChatErrorState.errorsByFork = {
        main: {
          id: 'error-id',
          content: 'Please wait for your current messages to finish.',
          retryable: true,
          failedUserMessage: { id: 'failed-msg-id', content: 'Hello' },
        },
      };

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // 1 real message + 1 error message = 2
      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });

    it('does not append error message when no error exists', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });
  });

  describe('error cleanup', () => {
    it('clears chat error when submitting a new message', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        userMessageId: 'user-2',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2', cost: '0' }],
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'Retry message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearError).toHaveBeenCalled();
      });
    });

    it('clears all fork errors when navigating between conversations', () => {
      // The route keys this page by conversation id, so a navigation between
      // conversations remounts the subtree. The unmount of the old conversation
      // fires clearAll — replacing the former in-place switch-reset effect.
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-1', titleEpochNumber: 1 },
        messagesData: [],
      });

      const { unmount } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      mockClearAll.mockClear();
      unmount();

      expect(mockClearAll).toHaveBeenCalled();
    });

    it('clears all fork errors on unmount', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      const { unmount } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      mockClearAll.mockClear();
      unmount();

      expect(mockClearAll).toHaveBeenCalled();
    });
  });

  describe('user-only messages (AI toggle off)', () => {
    it('passes onSubmitUserOnly to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('submit-user-only')).toBeInTheDocument();
    });

    it('sends user-only message via fetchJson without streaming', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockFetchJson).toHaveBeenCalled();
      });

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('clears input after sending user-only message', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });

    it('does not send user-only message when input is empty', async () => {
      const user = userEvent.setup();

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: '   ',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('invalidates messages query after successful user-only send', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ['conversation', 'conv-456'],
        });
      });
    });
  });

  describe('fork URL sync', () => {
    it('initializes fork store from initialForkId prop', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-abc" />);

      expect(mockSetActiveFork).toHaveBeenCalledWith('fork-abc');
    });

    it('does not initialize fork store when initialForkId is undefined', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockSetActiveFork).not.toHaveBeenCalled();
    });

    it('does not auto-select Main over an explicit initialForkId when forks are loaded', () => {
      mockForksData = [
        {
          id: 'main-fork',
          conversationId: 'conv-456',
          name: 'Main',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'fork-1',
          conversationId: 'conv-456',
          name: 'Fork 1',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ];
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-1" />);

      // The URL fork is the source of truth on load; the Main fallback must not
      // clobber it (the reload/URL-deep-link regression).
      expect(mockSetActiveFork).toHaveBeenCalledWith('fork-1');
      expect(mockSetActiveFork).not.toHaveBeenCalledWith('main-fork');
    });

    it('auto-selects the earliest-created (Main) fork when no initialForkId and multiple forks exist', () => {
      mockForksData = [
        {
          id: 'fork-1',
          conversationId: 'conv-456',
          name: 'Fork 1',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:05.000Z',
        },
        {
          id: 'main-fork',
          conversationId: 'conv-456',
          name: 'Main',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockSetActiveFork).toHaveBeenCalledWith('main-fork');
    });

    it('writes the active fork to the URL through the router when it is not yet in the URL', () => {
      mockActiveForkId = 'fork-2';
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-1" />);

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/chat/$id',
        params: { id: 'conv-456' },
        search: { fork: 'fork-2' },
        replace: true,
      });
    });

    it('does not clear the fork param through the router while the store is still null on load', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-1" />);

      expect(mockNavigate).not.toHaveBeenCalledWith(
        expect.objectContaining({ search: { fork: undefined } })
      );
    });

    it('clears the fork param when the last fork is deleted', () => {
      mockActiveForkId = 'fork-1';
      mockForksData = [
        {
          id: 'fork-1',
          conversationId: 'conv-456',
          name: 'Fork 1',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:05.000Z',
        },
        {
          id: 'main-fork',
          conversationId: 'conv-456',
          name: 'Main',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      const { rerender } = render(
        <AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-1" />
      );
      mockNavigate.mockClear();

      // Delete the last fork: the store empties and the conversation has no forks.
      mockActiveForkId = null;
      mockForksData = [];
      rerender(<AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-1" />);

      expect(mockNavigate).toHaveBeenCalledWith({
        to: '/chat/$id',
        params: { id: 'conv-456' },
        search: { fork: undefined },
        replace: true,
      });
    });
  });

  describe('fork active-state seeding (race regression)', () => {
    it('keeps the deep-link seed when forks finish loading on a later render', () => {
      // Tick 1: store still null, no forks yet — the seed fires setActiveFork(fork-1).
      // The mock setActiveFork does NOT update mockActiveForkId, so on the next
      // render the store still reads null. When the forks query then resolves to
      // >= 2 forks, the Main fallback must NOT run — the URL seed wins until the
      // store reflects it. The buggy code latches initializedRef on tick 1 and
      // falls through to setActiveFork('main-fork') on the rerender.
      mockActiveForkId = null;
      mockForksData = [];
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      const { rerender } = render(
        <AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-1" />
      );

      mockForksData = [
        {
          id: 'main-fork',
          conversationId: 'conv-456',
          name: 'Main',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'fork-1',
          conversationId: 'conv-456',
          name: 'Fork 1',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ];
      rerender(<AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-1" />);

      expect(mockSetActiveFork).toHaveBeenCalledWith('fork-1');
      expect(mockSetActiveFork).not.toHaveBeenCalledWith('main-fork');
    });

    it('selects the earliest-created fork on a plain load with no fork seed', () => {
      mockActiveForkId = null;
      mockForksData = [
        {
          id: 'main-fork',
          conversationId: 'conv-456',
          name: 'Main',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'fork-1',
          conversationId: 'conv-456',
          name: 'Fork 1',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ];
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockSetActiveFork).toHaveBeenCalledWith('main-fork');
    });

    it('claims the new fork active before the create mutation resolves', async () => {
      // In-session create: the new fork must be claimed synchronously, before the
      // mutation resolves, so the forks query refetching to >= 2 forks never finds
      // activeForkId still null (which the Main fallback would fill, clobbering the
      // new fork). The buggy code sets the active fork only in onSuccess, which the
      // captured vi.fn never invokes.
      mockActiveForkId = null;
      mockForksData = [];
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      const user = userEvent.setup();
      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('trigger-fork'));

      const mutateArgument = mockCreateForkMutate.mock.calls[0]?.[0] as { id: string };
      expect(mockCreateForkMutate).toHaveBeenCalled();
      expect(mockSetActiveFork).toHaveBeenCalledWith(mutateArgument.id);
    });
  });

  describe('fork rename modal', () => {
    it('opens rename dialog when onForkRename is called', async () => {
      const user = userEvent.setup();
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.queryByTestId('rename-fork-dialog')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('trigger-fork-rename'));

      expect(screen.getByTestId('rename-fork-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('rename-fork-dialog')).toHaveAttribute('data-value', 'Fork 1');
    });

    it('opens delete dialog when onForkDelete is called', async () => {
      const user = userEvent.setup();
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.queryByTestId('delete-fork-dialog')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('trigger-fork-delete'));

      expect(screen.getByTestId('delete-fork-dialog')).toBeInTheDocument();
    });

    it('clears the active fork when the deleted fork was active so Main is re-selected', async () => {
      const user = userEvent.setup();
      mockActiveForkId = 'fork-1';
      mockForksData = [
        {
          id: 'main-fork',
          conversationId: 'conv-456',
          name: 'Main',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'fork-1',
          conversationId: 'conv-456',
          name: 'Fork 1',
          tipMessageId: null,
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ];
      // Resolve the delete optimistically so onSuccess runs; the fallback effect
      // then re-selects Main from the refetched fork list.
      mockDeleteForkMutate.mockImplementation(
        (_variables: unknown, options?: { onSuccess?: () => void }) => options?.onSuccess?.()
      );
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      await user.click(screen.getByTestId('trigger-fork-delete'));
      await user.click(screen.getByTestId('confirm-delete'));

      expect(mockSetActiveFork).toHaveBeenCalledWith(null);
    });
  });

  describe('message action callbacks', () => {
    it('passes onRegenerate to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-has-on-regenerate', 'true');
    });

    it('does not dispatch a regenerate when the anchor content is unavailable', () => {
      // A user message whose decrypted content is momentarily empty (a realtime
      // refetch is re-decrypting). Regenerate must not fire: it would POST empty
      // userMessage.content and the server (min(1)) would reject it.
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [
          { id: 'u1', conversationId: 'conv-456', role: 'user', content: '', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      capturedChatLayoutProps?.onRegenerate?.('u1');

      expect(mockStartRegenerateStream).not.toHaveBeenCalled();
    });

    it('passes onEdit to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-has-on-edit', 'true');
    });

    it('passes onFork to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-has-on-fork', 'true');
    });
  });

  describe('link guest mode (privateKeyOverride)', () => {
    it('passes isAuthenticated=false and isLinkGuest=true when privateKeyOverride is set', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Shared' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(
        <AuthenticatedChatPage
          routeConversationId="conv-456"
          privateKeyOverride={new Uint8Array(32)}
        />
      );

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toHaveAttribute('data-is-authenticated', 'false');
      expect(layout).toHaveAttribute('data-is-link-guest', 'true');
    });

    it('defaults callerPrivilege to read during loading when link guest', () => {
      setupMocks({ isConversationLoading: true });

      render(
        <AuthenticatedChatPage
          routeConversationId="conv-456"
          privateKeyOverride={new Uint8Array(32)}
        />
      );

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toHaveAttribute('data-caller-privilege', 'read');
    });

    it('passes isAuthenticated=true when not a link guest', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Normal' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toHaveAttribute('data-is-authenticated', 'true');
      expect(layout).toHaveAttribute('data-is-link-guest', 'false');
    });
  });

  describe('run lifecycle across unmount (keystone)', () => {
    // A transport disconnect never cancels a run under the run protocol: the
    // server completes, persists, and bills it. Unmount therefore performs no
    // stream teardown — the only cancellation path is the explicit stop.
    it('does not stop the run when the page unmounts mid-stream', async () => {
      const user = userEvent.setup();
      mockStartStream.mockImplementation(() => new Promise(() => {}));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Hello',
      });

      const { unmount } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });

      unmount();

      expect(mockStopRun).not.toHaveBeenCalled();
    });

    it('passes the stop control to ChatLayout and stopping posts /chat/stop', async () => {
      mockStopRun.mockResolvedValue(true);
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: '',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      const onStop = (capturedChatLayoutProps as { onStop?: () => void } | undefined)?.onStop;
      expect(onStop).toBeInstanceOf(Function);
      onStop?.();
      await waitFor(() => {
        expect(mockStopRun).toHaveBeenCalledWith('conv-456');
      });
    });
  });

  describe('stable callback identities (memoized MessageList)', () => {
    // Mirror production useChatPageState: a brand-new object every render, but
    // with referentially-stable inner callbacks (each is a useCallback in the
    // real hook). The churn that would break naive wiring comes from
    // useAuthenticatedChat rebuilding handleSend / handleRegenerate (it runs for
    // real here, depending on the fresh `state` object) — not from these.
    const stableState = {
      setInputValue: vi.fn(),
      clearInput: vi.fn(),
      startStreaming: vi.fn(),
      stopStreaming: vi.fn(),
      stopPersisting: vi.fn(),
      streamingMessageIds: new Set<string>(),
      persistingMessageIds: new Set<string>(),
    };
    function freshChatPageState(inputValue: string): ChatPageStateMock {
      return {
        inputValue,
        ...stableState,
        streamingMessageIdsRef,
        persistingMessageIdsRef,
      };
    }

    it('keeps onRegenerate and onEdit identities stable across a re-render', () => {
      setupMocks({
        conversationData: { id: 'conv-stable', title: 'encrypted-1', titleEpochNumber: 1 },
        messagesData: [
          { id: 'm1', conversationId: 'conv-stable', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });
      mockUseChatPageState.mockImplementation(() => freshChatPageState(''));

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-stable" />);
      const firstOnRegenerate = capturedChatLayoutProps?.onRegenerate;
      const firstOnEdit = capturedChatLayoutProps?.onEdit;

      rerender(<AuthenticatedChatPage routeConversationId="conv-stable" />);

      expect(capturedChatLayoutProps?.onRegenerate).toBe(firstOnRegenerate);
      expect(capturedChatLayoutProps?.onEdit).toBe(firstOnEdit);
    });
  });
});
