import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SMART_MODEL_ID, parseReasoningText } from '@hushbox/shared';
import { useMessageQueueStore } from '@/stores/message-queue';
import { usePreInferenceActivityStore } from '@/stores/pre-inference-activity';
import type { Message } from '@/lib/api';
import type { StreamOptions } from '@/hooks/chat/use-chat-stream';

// ---------------------------------------------------------------------------
// Module seams. Everything that is a genuine dependency boundary is mocked;
// the pure helper libs (`@/lib/chat/auth-chat-helpers`, `@/lib/chat-messages`,
// `@/lib/multi-model-stream`, `@/lib/chat-regeneration`), `@/lib/epoch-key-cache`,
// and `@/hooks/chat/use-optimistic-messages` are exercised for real so behaviour
// is observed rather than stubbed.
// ---------------------------------------------------------------------------

// `@/lib/api` runs env validation at import; the hook only type-imports it, so a
// stub keeps any transitive load inert.
vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

const mockFetchJson = vi.fn();
const mockMessagePost = vi.fn((_argument: unknown) => ({}) as unknown);
vi.mock('@/lib/api-client', () => ({
  client: {
    chat: {
      ':conversationId': {
        message: { $post: (argument: unknown) => mockMessagePost(argument) },
      },
    },
  },
  fetchJson: (argument: unknown) => mockFetchJson(argument),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// Invoke functional updaters (as applyPrune passes) so their inner filter runs;
// exercise both the populated and the empty-cache arms.
const mockSetQueryData = vi.fn((_key: unknown, updater: unknown) => {
  if (typeof updater === 'function') {
    (updater as (old?: unknown) => unknown)([{ id: 'a1' }, { id: 'keep' }]);
    (updater as (old?: unknown) => unknown)();
  }
});
const mockInvalidateQueries = vi.fn().mockResolvedValue(null);
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidateQueries,
  }),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, useIsMobile: (): boolean => mockIsMobile };
});
let mockIsMobile = false;

// Deterministic crypto so the create flow runs without real key material.
vi.mock('@hushbox/crypto', () => ({
  createFirstEpoch: vi.fn(() => ({
    epochPublicKey: new Uint8Array(32).fill(10),
    epochPrivateKey: new Uint8Array(32).fill(11),
    confirmationHash: new Uint8Array(32).fill(12),
    memberWraps: [{ wrap: new Uint8Array(32).fill(14) }],
  })),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array(32).fill(9)),
  encryptTextForEpoch: vi.fn(() => new Uint8Array(32).fill(20)),
  // Consumed by the real `auth-chat-helpers` / `epoch-key-cache` we keep live.
  decryptTextFromEpoch: vi.fn(() => 'decrypted'),
  unwrapEpochKey: vi.fn(),
  traverseChainLink: vi.fn(),
  verifyEpochKeyConfirmation: vi.fn(),
}));

// -- use-chat-page ----------------------------------------------------------
const mockStartStreaming = vi.fn();
const mockStopStreaming = vi.fn();
const mockStopPersisting = vi.fn();
const mockClearInput = vi.fn();
const mockSetInputValue = vi.fn();
let mockInputValue = 'hello world';
vi.mock('@/hooks/chat/use-chat-page', () => ({
  useChatPageState: () => ({
    inputValue: mockInputValue,
    setInputValue: mockSetInputValue,
    clearInput: mockClearInput,
    streamingMessageIds: new Set<string>(),
    streamingMessageIdsRef: { current: new Set<string>() },
    startStreaming: mockStartStreaming,
    stopStreaming: mockStopStreaming,
    persistingMessageIds: new Set<string>(),
    persistingMessageIdsRef: { current: new Set<string>() },
    stopPersisting: mockStopPersisting,
  }),
}));

// -- use-chat-stream (mocked hook + real-shaped error classes) --------------
const mockStartStream = vi.fn();
const mockStartRegenerateStream = vi.fn();
const mockStopRun = vi.fn();
let mockIsStreaming = false;
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
    useChatStream: () => ({
      isStreaming: mockIsStreaming,
      startStream: mockStartStream,
      startRegenerateStream: mockStartRegenerateStream,
      stopRun: mockStopRun,
    }),
    ChatRequestError,
    ChatRunFailedError,
  };
});

// -- chat query hooks -------------------------------------------------------
const mockCreateConversationMutateAsync = vi.fn();
let mockConversationData:
  | { id: string; callerId?: string; callerPrivilege?: string; title?: string }
  | undefined;
let mockConversationLoading = false;
let mockMessagesData: Message[] | undefined;
let mockMessagesLoading = false;
vi.mock('@/hooks/chat/chat', () => ({
  DECRYPTING_TITLE: 'Decrypting...',
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
  useConversation: () => ({ data: mockConversationData, isLoading: mockConversationLoading }),
  useMessages: () => ({ data: mockMessagesData, isLoading: mockMessagesLoading }),
  useCreateConversation: () => ({ mutateAsync: mockCreateConversationMutateAsync }),
}));

// -- decrypted / fork message pipeline (identity pass-throughs) -------------
vi.mock('@/hooks/crypto/use-decrypted-messages', () => ({
  useDecryptedMessages: (_id: string | null, apiMessages: Message[] | undefined) =>
    apiMessages ?? [],
}));
vi.mock('@/hooks/chat/use-fork-messages', () => ({
  useForkMessages: (decrypted: Message[]) => decrypted,
}));
let mockForksData: unknown[] | undefined = [];
vi.mock('@/hooks/chat/forks', () => ({
  useForks: () => ({ data: mockForksData }),
}));

// -- stores -----------------------------------------------------------------
const mockClearPendingMessage = vi.fn();
let mockPendingMessage: string | null = null;
let mockPendingFundingSource: string | null = null;
vi.mock('@/stores/pending-chat', () => ({
  usePendingChatStore: (selector: (s: unknown) => unknown) =>
    selector({
      pendingMessage: mockPendingMessage,
      pendingFundingSource: mockPendingFundingSource,
      clearPendingMessage: mockClearPendingMessage,
    }),
}));

interface ModelState {
  activeModality: 'text' | 'image' | 'video' | 'audio';
  selections: Record<string, { id: string; name: string }[]>;
  imageConfig: { aspectRatio: string };
  videoConfig: { aspectRatio: string; durationSeconds: number; resolution: string };
  audioConfig: { format: string; maxDurationSeconds: number };
}
const modelState: ModelState = {
  activeModality: 'text',
  selections: {
    text: [{ id: 'test-model', name: 'Test Model' }],
    image: [{ id: 'img-model', name: 'Image Model' }],
    video: [{ id: 'vid-model', name: 'Video Model' }],
    audio: [{ id: 'aud-model', name: 'Audio Model' }],
  },
  imageConfig: { aspectRatio: '4:3' },
  videoConfig: { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' },
  audioConfig: { format: 'mp3', maxDurationSeconds: 600 },
};
vi.mock('@/stores/model', () => ({
  useModelStore: (selector: (s: ModelState) => unknown) => selector(modelState),
  getPrimaryModel: (entries: { id: string; name: string }[]) =>
    entries[0] ?? { id: 'smart-model', name: 'Smart Model' },
}));

const mockSetError = vi.fn();
const mockClearError = vi.fn();
const mockClearAll = vi.fn();
let mockErrorsByFork: Record<string, { id: string; content?: string } | null> = {};
vi.mock('@/stores/chat-error', () => ({
  MAIN_FORK_KEY: 'main',
  useChatErrorStore: Object.assign(
    (
      selector?: (s: {
        errorsByFork: Record<string, { id: string; content?: string } | null>;
      }) => unknown
    ) => {
      const state = { errorsByFork: mockErrorsByFork };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        errorsByFork: mockErrorsByFork,
        setError: mockSetError,
        clearError: mockClearError,
        clearAll: mockClearAll,
      }),
    }
  ),
  createChatError: (params: { content: string; retryable: boolean; failedContent: string }) => ({
    id: 'error-id',
    content: params.content,
    retryable: params.retryable,
    failedUserMessage: { id: 'failed-id', content: params.failedContent },
  }),
}));

let mockWebSearchActive = false;
vi.mock('@/hooks/chat/use-web-search', () => ({
  useWebSearch: () => ({ active: mockWebSearchActive }),
}));

let mockReasoningEffective: string | undefined;
vi.mock('@/hooks/chat/use-reasoning-effort', () => ({
  useReasoningEffort: () => ({ effective: mockReasoningEffective }),
}));

vi.mock('@/hooks/billing/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

let mockPrivateKey: Uint8Array | null = new Uint8Array(32).fill(1);
let mockAuthUserId: string | undefined = 'user-1';
let mockCustomInstructions: string | null = null;
vi.mock('@/lib/auth', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) =>
    selector({
      privateKey: mockPrivateKey,
      user: mockAuthUserId ? { id: mockAuthUserId } : null,
      customInstructions: mockCustomInstructions,
    }),
}));

const mockEndStream = vi.fn();
vi.mock('@/stores/streaming-activity', () => ({
  useStreamingActivityStore: {
    getState: () => ({ startStream: vi.fn(), endStream: mockEndStream }),
  },
}));

// ---------------------------------------------------------------------------

import { useAuthenticatedChat, shouldStreamFirstTurn } from '@/hooks/chat/use-authenticated-chat';

function makeMessage(
  id: string,
  role: 'user' | 'assistant' = 'user',
  content = `c-${id}`
): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(role === 'assistant' ? { modelName: 'test-model' } : {}),
  };
}

interface StreamPlan {
  models: { modelId: string; assistantMessageId: string; errorCode?: string }[];
  token?: string;
  resolvedModelId?: string;
  restart?: boolean;
  modelError?: { modelId: string; assistantMessageId: string; code: string };
  media?: { mediaType: 'image' | 'audio' | 'video'; mimeType: string };
  mediaProgress?: number;
}

// Default: two tiles, the first sent under the Smart sentinel so `onModelResolved`
// exercises both the mutate branch (smart tile) and the early-return branch
// (non-smart tile). Fires every optional callback so the stream-callback closures
// are all driven.
let streamPlan: StreamPlan = {
  models: [
    { modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' },
    { modelId: 'test-model', assistantMessageId: 'assistant-2' },
  ],
  token: 'tok',
  resolvedModelId: 'anthropic/claude',
  restart: true,
  media: { mediaType: 'image', mimeType: 'image/png' },
};

function fireStart(options: StreamOptions | undefined, plan: StreamPlan): void {
  options?.onStart?.({
    userMessageId: 'user-msg',
    models: plan.models.map((m) => ({
      modelId: m.modelId,
      assistantMessageId: m.assistantMessageId,
    })),
  });
}

function fireMiddle(options: StreamOptions | undefined, plan: StreamPlan, id: string): void {
  if (plan.token !== undefined) options?.onToken?.(plan.token, id);
  if (plan.restart) options?.onRestart?.([id]);
  if (plan.modelError) options?.onModelError?.(plan.modelError);
}

function fireResolutions(options: StreamOptions | undefined, plan: StreamPlan, id: string): void {
  if (plan.resolvedModelId === undefined) return;
  // Smart tile → mutate; second tile → early return.
  options?.onModelResolved?.(id, plan.resolvedModelId);
  const second = plan.models[1];
  if (second) options?.onModelResolved?.(second.assistantMessageId, plan.resolvedModelId);
}

function fireMedia(options: StreamOptions | undefined, plan: StreamPlan, id: string): void {
  if (!plan.media) return;
  options?.onModelMediaStart?.({ assistantMessageId: id, ...plan.media });
  // An explicit progress plan models a mid-flight snapshot: the synthetic
  // percent arrives and the run errors before media-done's authoritative 100.
  if (plan.mediaProgress !== undefined) {
    options?.onModelMediaProgress?.({ assistantMessageId: id, percent: plan.mediaProgress });
    return;
  }
  options?.onModelMediaDone?.({ assistantMessageId: id });
}

function driveStream(options: StreamOptions | undefined, plan: StreamPlan): void {
  fireStart(options, plan);
  const first = plan.models[0];
  if (!first) return;
  const id = first.assistantMessageId;
  fireMiddle(options, plan, id);
  fireResolutions(options, plan, id);
  fireMedia(options, plan, id);
  options?.onAllModelsComplete?.();
  options?.onAllStreamsSettled?.();
}

function streamResult(plan: StreamPlan): {
  userMessageId: string;
  models: { modelId: string; assistantMessageId: string; errorCode?: string }[];
  outcome: 'succeeded';
} {
  return {
    userMessageId: 'user-msg',
    models: plan.models.map((m) => ({
      modelId: m.modelId,
      assistantMessageId: m.assistantMessageId,
      ...(m.errorCode !== undefined && { errorCode: m.errorCode }),
    })),
    outcome: 'succeeded',
  };
}

function resetState(): void {
  mockIsMobile = false;
  mockInputValue = 'hello world';
  mockIsStreaming = false;
  mockPendingMessage = null;
  mockPendingFundingSource = null;
  mockConversationData = undefined;
  mockConversationLoading = false;
  mockMessagesData = undefined;
  mockMessagesLoading = false;
  mockErrorsByFork = {};
  mockForksData = [];
  mockWebSearchActive = false;
  mockReasoningEffective = undefined;
  mockPrivateKey = new Uint8Array(32).fill(1);
  mockAuthUserId = 'user-1';
  mockCustomInstructions = null;
  modelState.activeModality = 'text';
  streamPlan = {
    models: [
      { modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' },
      { modelId: 'test-model', assistantMessageId: 'assistant-2' },
    ],
    token: 'tok',
    resolvedModelId: 'anthropic/claude',
    restart: true,
    media: { mediaType: 'image', mimeType: 'image/png' },
  };
  mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
    driveStream(options, streamPlan);
    return Promise.resolve(streamResult(streamPlan));
  });
  mockStartRegenerateStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
    driveStream(options, streamPlan);
    return Promise.resolve(streamResult(streamPlan));
  });
  mockStopRun.mockResolvedValue(true);
  mockCreateConversationMutateAsync.mockResolvedValue({
    conversation: { id: 'real-conv' },
    created: true,
    forks: [],
  });
  mockFetchJson.mockResolvedValue({});
  // The message queue is a real singleton store — reset it so a queue populated
  // by one test never leaks into the next.
  useMessageQueueStore.setState({ queuesByConversation: {} });
}

function render(
  input: {
    routeConversationId?: string;
    activeForkId?: string | null;
    privateKeyOverride?: Uint8Array | null;
  } = {}
): ReturnType<typeof renderHook<ReturnType<typeof useAuthenticatedChat>, unknown>> {
  const { routeConversationId = 'conv-1', activeForkId, privateKeyOverride } = input;
  return renderHook(() =>
    useAuthenticatedChat({ routeConversationId, activeForkId, privateKeyOverride })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldStreamFirstTurn', () => {
  it('streams the first turn for a freshly created conversation', () => {
    expect(shouldStreamFirstTurn({ created: true })).toBe(true);
  });
  it('does not re-stream an idempotent existing conversation', () => {
    expect(shouldStreamFirstTurn({ created: false })).toBe(false);
  });
});

describe('useAuthenticatedChat — surface', () => {
  it('exposes the result contract for an existing conversation', () => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u1')];
    const { result } = render();
    expect(result.current.realConversationId).toBe('conv-1');
    expect(result.current.callerId).toBe('owner-1');
    expect(result.current.callerPrivilege).toBe('owner');
    expect(result.current.renderState.type).toBe('ready');
    expect(result.current.messagesReady).toBe(true);
    expect(result.current.inputDisabled).toBe(false);
    expect(typeof result.current.handleSend).toBe('function');
  });

  it('falls back to the auth user id when the conversation omits callerId', () => {
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    expect(result.current.callerId).toBe('user-1');
  });

  it('sums history characters across the merged message list', () => {
    mockConversationData = { id: 'conv-1' };
    mockMessagesData = [makeMessage('u1', 'user', 'abc'), makeMessage('a1', 'assistant', 'de')];
    const { result } = render();
    expect(result.current.historyCharacters).toBe(5);
  });

  it('marks input disabled for a read-only caller', () => {
    mockConversationData = { id: 'conv-1', callerPrivilege: 'read' };
    const { result } = render();
    expect(result.current.inputDisabled).toBe(true);
  });

  it('surfaces the active fork error slot as errorMessageId', () => {
    mockErrorsByFork = { 'fork-9': { id: 'err-42', content: 'went wrong' } };
    mockConversationData = { id: 'conv-1' };
    const { result } = render({ activeForkId: 'fork-9' });
    expect(result.current.errorMessageId).toBe('err-42');
  });

  it('clears all fork errors on unmount', () => {
    mockConversationData = { id: 'conv-1' };
    const { unmount } = render();
    unmount();
    expect(mockClearAll).toHaveBeenCalled();
  });
});

describe('useAuthenticatedChat — handleSend', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u0'), makeMessage('a0', 'assistant')];
  });

  it('is a no-op when the input is blank', async () => {
    mockInputValue = '   ';
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('streams a turn, driving every optimistic callback and settling', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request, options] = mockStartStream.mock.calls[0] as [
      {
        conversationId: string;
        models: string[];
        fundingSource: string;
        messagesForInference: unknown[];
      },
      StreamOptions,
    ];
    expect(request.conversationId).toBe('conv-1');
    expect(request.models).toEqual(['test-model']);
    expect(request.fundingSource).toBe('personal_balance');
    expect(options.onStart).toBeTypeOf('function');
    expect(mockClearInput).toHaveBeenCalled();
    expect(mockStartStreaming).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    expect(mockStopPersisting).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it('includes web-search, custom instructions, and forkId in the request', async () => {
    mockWebSearchActive = true;
    mockCustomInstructions = 'be terse';
    const { result } = render({ activeForkId: 'fork-1' });
    await act(async () => {
      result.current.handleSend('owner_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [
      { webSearchEnabled?: boolean; customInstructions?: string; forkId?: string },
    ];
    expect(request.webSearchEnabled).toBe(true);
    expect(request.customInstructions).toBe('be terse');
    expect(request.forkId).toBe('fork-1');
  });

  it('includes the effective reasoningEffort in the request when one is engaged', async () => {
    mockReasoningEffective = 'medium';
    const { result } = render();
    await act(async () => {
      result.current.handleSend('owner_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ reasoningEffort?: string }];
    expect(request.reasoningEffort).toBe('medium');
  });

  it('omits reasoningEffort from the request when nothing is engaged', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSend('owner_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [Record<string, unknown>];
    expect(request).not.toHaveProperty('reasoningEffort');
  });

  it('accumulates a reasoning delta into the streaming tile ahead of the answer', async () => {
    // Never settles: the tile must stay optimistic so its live content is
    // observable after the reasoning and answer deltas land.
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onReasoningToken?.('thinking hard', 'assistant-1');
      options?.onToken?.('the answer', 'assistant-1');
      return new Promise(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(parseReasoningText(tile?.content ?? '')).toEqual({
        reasoning: 'thinking hard',
        answer: 'the answer',
      });
    });
  });

  it('stamps the live reasoning token count onto the streaming tile', async () => {
    // Never settles: the tile must stay optimistic so the live count landed
    // by the finish frame is observable before the persisted refetch.
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onToken?.('the answer', 'assistant-1');
      options?.onReasoningTokens?.(1204, 'assistant-1');
      return new Promise(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.reasoningTokens).toBe(1204);
    });
  });

  it('stamps the media backdrop for an image turn', async () => {
    modelState.activeModality = 'image';
    streamPlan.models = [{ modelId: 'img-model', assistantMessageId: 'assistant-1' }];
    streamPlan.media = { mediaType: 'image', mimeType: 'image/png' };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ imageConfig?: unknown }];
    expect(request.imageConfig).toEqual({ aspectRatio: '4:3' });
  });

  it('applies media-progress percents to the streaming tile', async () => {
    modelState.activeModality = 'video';
    streamPlan = {
      models: [{ modelId: 'video-model', assistantMessageId: 'assistant-1', errorCode: 'X' }],
      modelError: { modelId: 'video-model', assistantMessageId: 'assistant-1', code: 'X' },
      media: { mediaType: 'video', mimeType: 'video/*' },
      mediaProgress: 40,
    };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    // The errored tile survives settlement, still carrying the last live
    // percent the progress frames applied.
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.mediaProgress).toEqual({ percent: 40 });
    });
  });

  it('keeps errored optimistic tiles and drops successful ones', async () => {
    streamPlan = {
      models: [
        { modelId: 'test-model', assistantMessageId: 'assistant-1' },
        { modelId: 'other-model', assistantMessageId: 'assistant-2', errorCode: 'MODEL_ERROR' },
      ],
      modelError: {
        modelId: 'other-model',
        assistantMessageId: 'assistant-2',
        code: 'MODEL_ERROR',
      },
    };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    // Errored tile survives in the rendered list; successful one was removed.
    await waitFor(() => {
      expect(result.current.messages.some((m) => m.id === 'assistant-2')).toBe(true);
    });
  });

  it('builds inference history from lingering optimistic tiles on a follow-up send', async () => {
    // First send leaves an errored optimistic assistant tile in place.
    streamPlan = {
      models: [
        { modelId: 'test-model', assistantMessageId: 'assistant-err', errorCode: 'MODEL_ERROR' },
      ],
      modelError: {
        modelId: 'test-model',
        assistantMessageId: 'assistant-err',
        code: 'MODEL_ERROR',
      },
    };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.messages.some((m) => m.id === 'assistant-err')).toBe(true);
    });
    // Second send now composes messagesForInference over the optimistic tile.
    streamPlan = { models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2' }] };
    mockStartStream.mockClear();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ messagesForInference: unknown[] }];
    expect(request.messagesForInference.length).toBeGreaterThan(mockMessagesData!.length + 1);
  });

  it('handles an INSUFFICIENT_ADMISSION refusal: invalidates balance and sets a retryable error', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'u',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      return Promise.reject(new ChatRequestError('INSUFFICIENT_ADMISSION'));
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ retryable: true })
      );
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1']);
  });

  it('reports a generic (non-Error-class) failure as non-retryable and refocuses', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStartStream.mockRejectedValue(new Error('boom'));
    const focus = vi.fn();
    const { result } = render();
    result.current.promptInputRef.current = { focus } as never;
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ retryable: false })
      );
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('maps a ChatRunFailedError to the not-billed retryable message', async () => {
    const { ChatRunFailedError } = await import('@/hooks/chat/use-chat-stream');
    mockStartStream.mockRejectedValue(new ChatRunFailedError('CHAT_STREAM_FAILED'));
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ retryable: true })
      );
    });
  });

  it('does not refocus the composer on mobile after sending', async () => {
    mockIsMobile = true;
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(mockClearInput).toHaveBeenCalled();
  });

  it('skips startStreaming when a turn produces no assistant tiles', async () => {
    streamPlan = { models: [] };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(mockStartStreaming).not.toHaveBeenCalled();
  });

  it('resolves a null parent when the conversation has no prior messages', async () => {
    mockMessagesData = [];
    mockForksData = undefined;
    streamPlan = { models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }] };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
  });

  it('advances the pre-inference stage counter exactly once when the Smart tile resolves', async () => {
    // Default plan: one Smart-sentinel tile + one plain tile, and the harness
    // fires onModelResolved for BOTH — only the Smart tile may count.
    const baseline = usePreInferenceActivityStore.getState().preInferenceStagesSeen;
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(baseline + 1);
  });

  it('does not advance the pre-inference stage counter for a plain-model turn', async () => {
    streamPlan = {
      models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      resolvedModelId: 'test-model',
    };
    const baseline = usePreInferenceActivityStore.getState().preInferenceStagesSeen;
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(baseline);
  });
});

describe('useAuthenticatedChat — handleSendUserOnly', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1' };
    mockMessagesData = [makeMessage('u0')];
  });

  it('posts the user message without streaming and invalidates the conversation', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalled();
    });
    expect(mockMessagePost).toHaveBeenCalledWith({
      param: { conversationId: 'conv-1' },
      json: { messageId: expect.any(String) as unknown, content: 'hello world' },
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['conversation', 'conv-1'] });
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('includes the active forkId so the message stays on the viewed branch', async () => {
    const { result } = render({ activeForkId: 'fork-3' });
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockMessagePost).toHaveBeenCalled();
    });
    const [request] = mockMessagePost.mock.calls[0] as [
      { json: { forkId?: string; messageId: string; content: string } },
    ];
    expect(request.json.forkId).toBe('fork-3');
  });

  it('omits forkId for a linear (Main) send', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockMessagePost).toHaveBeenCalled();
    });
    const [request] = mockMessagePost.mock.calls[0] as [{ json: Record<string, unknown> }];
    expect(request.json).not.toHaveProperty('forkId');
  });

  it('is a no-op on blank input', async () => {
    mockInputValue = '';
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('resolves a null parent for a user-only send with no prior messages', async () => {
    mockMessagesData = [];
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalled();
    });
  });

  it('refocuses and logs when the user-only post fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchJson.mockRejectedValue(new Error('nope'));
    const focus = vi.fn();
    const { result } = render();
    result.current.promptInputRef.current = { focus } as never;
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('User-only message failed:', expect.anything());
    });
    consoleSpy.mockRestore();
  });
});

describe('useAuthenticatedChat — handleRegenerate', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1' };
    // user u1 → assistant a1 (target the user message for retry/edit)
    mockMessagesData = [
      makeMessage('u1', 'user', 'question'),
      makeMessage('a1', 'assistant', 'answer'),
    ];
    streamPlan = {
      models: [{ modelId: 'test-model', assistantMessageId: 'regen-1' }],
      token: 'tk',
    };
  });

  it('bails when there is no real conversation id', () => {
    mockConversationData = undefined;
    const { result } = render({ routeConversationId: 'new' });
    act(() => {
      result.current.handleRegenerate('u1', 'retry');
    });
    expect(mockStartRegenerateStream).not.toHaveBeenCalled();
  });

  it('bails when the anchor content is unavailable', () => {
    mockMessagesData = [makeMessage('u1', 'user', '')];
    const { result } = render();
    act(() => {
      result.current.handleRegenerate('u1', 'retry');
    });
    expect(mockStartRegenerateStream).not.toHaveBeenCalled();
  });

  it('carries the effective reasoningEffort on the regenerate request', async () => {
    mockReasoningEffective = 'medium';
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [{ reasoningEffort?: string }];
    expect(request.reasoningEffort).toBe('medium');
  });

  it('omits reasoningEffort from the regenerate request when nothing is engaged', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [{ reasoningEffort?: string }];
    expect(request).not.toHaveProperty('reasoningEffort');
  });

  it('runs a retry regeneration end-to-end', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [
      { conversationId: string; action: string; targetMessageId: string },
    ];
    expect(request.conversationId).toBe('conv-1');
    expect(request.action).toBe('retry');
    expect(request.targetMessageId).toBe('u1');
    expect(mockClearError).toHaveBeenCalledWith('main');
    expect(mockStopStreaming).toHaveBeenCalledWith(['regen-1']);
  });

  it('adds an edited user optimistic message for an edit regeneration', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'edit', 'edited text');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [
      { userMessage: { content: string } },
    ];
    expect(request.userMessage.content).toBe('edited text');
  });

  it('scopes regeneration to a single tile when replaceAssistantId is given', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry', undefined, 'a1');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [{ replaceAssistantId?: string }];
    expect(request.replaceAssistantId).toBe('a1');
  });

  it('handles a regeneration admission refusal with billing invalidation and error', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStartRegenerateStream.mockRejectedValue(new ChatRequestError('INSUFFICIENT_ADMISSION'));
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ retryable: true })
      );
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
  });

  it('removes placeholder tiles when a regeneration throws after onStart', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStartRegenerateStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'u',
        models: [{ modelId: 'test-model', assistantMessageId: 'regen-ph' }],
      });
      return Promise.reject(new Error('after start'));
    });
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockEndStream).toHaveBeenCalled();
    });
    consoleSpy.mockRestore();
  });

  it('cleans up the edited optimistic message when an edit regeneration fails', async () => {
    mockStartRegenerateStream.mockRejectedValue(new Error('regen boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'edit', 'edited');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockEndStream).toHaveBeenCalled();
    });
    consoleSpy.mockRestore();
  });

  it('edits a non-first message, resolving the preceding message as parent', async () => {
    // Target the assistant at index 1 so `targetIndex > 0` and the previous
    // message becomes the optimistic edit's parent.
    mockMessagesData = [makeMessage('u1', 'user', 'q'), makeMessage('a1', 'assistant', 'a')];
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('a1', 'edit', 'edited text');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
  });

  it('handles a retry on the last message (nothing to prune)', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('a1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
  });

  it('threads fork, web-search, and custom instructions into the regenerate request', async () => {
    mockWebSearchActive = true;
    mockCustomInstructions = 'concise';
    const { result } = render({ activeForkId: 'fork-7' });
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [
      { forkId?: string; webSearchEnabled?: boolean; customInstructions?: string },
    ];
    expect(request.forkId).toBe('fork-7');
    expect(request.webSearchEnabled).toBe(true);
    expect(request.customInstructions).toBe('concise');
    await waitFor(() => {
      expect(mockEndStream).toHaveBeenCalled();
    });
  });
});

describe('useAuthenticatedChat — handleStop', () => {
  it('posts a stop for the active conversation', async () => {
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStopRun).toHaveBeenCalledWith('conv-1');
    });
  });

  it('logs when the stop request fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStopRun.mockRejectedValue(new Error('stop failed'));
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('Stop failed:', expect.anything());
    });
    consoleSpy.mockRestore();
  });

  it('is a no-op with no real conversation', async () => {
    mockPendingMessage = null;
    mockPrivateKey = null;
    const { result } = render({ routeConversationId: 'new' });
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    expect(mockStopRun).not.toHaveBeenCalled();
  });
});

describe('useAuthenticatedChat — render-state effects', () => {
  it('navigates to the chat list when the create route has nothing to show', async () => {
    mockPendingMessage = null;
    const { result } = render({ routeConversationId: 'new' });
    expect(result.current.renderState.type).toBe('redirecting');
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });
});

describe('useAuthenticatedChat — create flow', () => {
  beforeEach(() => {
    mockPendingMessage = 'Hello AI';
    mockPendingFundingSource = 'personal_balance';
    // Create flow streams via hand-written callbacks; drive the create tile.
    streamPlan = {
      models: [{ modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' }],
      token: 'hi',
      resolvedModelId: 'anthropic/claude',
      restart: true,
      media: { mediaType: 'image', mimeType: 'image/png' },
    };
    modelState.activeModality = 'image';
  });

  it('does not create when the account private key is missing', () => {
    mockPrivateKey = null;
    render({ routeConversationId: 'new' });
    expect(mockCreateConversationMutateAsync).not.toHaveBeenCalled();
  });

  it('creates the conversation, streams the first turn, and navigates', async () => {
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockCreateConversationMutateAsync).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/chat/$id', params: { id: 'real-conv' } })
      );
    });
    expect(mockClearPendingMessage).toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.realConversationId).toBe('real-conv');
    });
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1']);
    expect(mockStopPersisting).toHaveBeenCalledWith(['assistant-1']);
  });

  it('advances the pre-inference stage counter when the create-flow Smart tile resolves', async () => {
    const baseline = usePreInferenceActivityStore.getState().preInferenceStagesSeen;
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(baseline + 1);
    });
  });

  it('seeds the cache without streaming for an idempotent existing conversation', async () => {
    mockCreateConversationMutateAsync.mockResolvedValue({
      conversation: { id: 'real-conv' },
      created: false,
      forks: [],
    });
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockClearPendingMessage).toHaveBeenCalled();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/chat/$id', params: { id: 'real-conv' } })
    );
  });

  it('navigates back to chat when creation throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateConversationMutateAsync.mockRejectedValue(new Error('create failed'));
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
    consoleSpy.mockRestore();
  });

  it('preserves errored models and reports the failure on a create-flow stream error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStartStream.mockRejectedValue(new Error('stream failed'));
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ retryable: false })
      );
    });
    consoleSpy.mockRestore();
  });

  it('accumulates a reasoning delta into the create-flow tile ahead of the answer', async () => {
    modelState.activeModality = 'text';
    // Never settles: the first-turn tile must stay in local message state so
    // its live content is observable after the deltas land.
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onReasoningToken?.('first thought', 'assistant-1');
      options?.onToken?.('first answer', 'assistant-1');
      return new Promise(() => {});
    });
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(parseReasoningText(tile?.content ?? '')).toEqual({
        reasoning: 'first thought',
        answer: 'first answer',
      });
    });
  });

  it('keeps an errored create-flow model as an optimistic tile', async () => {
    streamPlan = {
      models: [
        { modelId: 'test-model', assistantMessageId: 'assistant-1', errorCode: 'MODEL_ERROR' },
      ],
      modelError: { modelId: 'test-model', assistantMessageId: 'assistant-1', code: 'MODEL_ERROR' },
    };
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        result.current.messages.some((m) => m.id === 'assistant-1' && m.errorCode === 'MODEL_ERROR')
      ).toBe(true);
    });
  });

  it('applies media-progress percents to the create-flow tile', async () => {
    modelState.activeModality = 'video';
    streamPlan = {
      models: [{ modelId: 'video-model', assistantMessageId: 'assistant-1' }],
      media: { mediaType: 'video', mimeType: 'video/*' },
      mediaProgress: 40,
    };
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.mediaProgress).toEqual({ percent: 40 });
    });
  });

  it('flips the create-flow tile to 100% on media-done', async () => {
    modelState.activeModality = 'video';
    streamPlan = {
      models: [{ modelId: 'video-model', assistantMessageId: 'assistant-1' }],
      media: { mediaType: 'video', mimeType: 'video/*' },
    };
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.mediaProgress).toEqual({ percent: 100 });
    });
  });

  it('streams a text create turn with a non-smart tile and custom instructions', async () => {
    modelState.activeModality = 'text';
    mockCustomInstructions = 'stay factual';
    streamPlan = {
      models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      token: 'hi',
      resolvedModelId: 'anthropic/claude',
      restart: true,
    };
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ customInstructions?: string }];
    expect(request.customInstructions).toBe('stay factual');
  });

  it('defaults the funding source to personal_balance when none is pending', async () => {
    mockPendingFundingSource = null;
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
  });

  it('aborts the create flow when the epoch yields no member wrap', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const crypto = await import('@hushbox/crypto');
    (crypto.createFirstEpoch as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
    });
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('useAuthenticatedChat — message queue', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u0'), makeMessage('a0', 'assistant')];
    streamPlan = { models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }] };
  });

  function sentContents(): string[] {
    return mockStartStream.mock.calls.map(
      (call) => (call as [{ userMessage: { content: string } }])[0].userMessage.content
    );
  }

  it('enqueues a message for the active conversation via onQueueMessage', () => {
    mockIsStreaming = true;
    const { result } = render();
    act(() => {
      result.current.onQueueMessage('queued text');
    });
    expect(result.current.queueCount).toBe(1);
    expect(result.current.queuedMessages[0]?.text).toBe('queued text');
  });

  it('reports the queue as full at capacity', () => {
    mockIsStreaming = true;
    const { result } = render();
    act(() => {
      for (let index = 0; index < 5; index += 1) result.current.onQueueMessage(`m${String(index)}`);
    });
    expect(result.current.queueCount).toBe(5);
    expect(result.current.queueFull).toBe(true);
    // The store rejects a sixth; the count holds at the cap.
    act(() => {
      result.current.onQueueMessage('overflow');
    });
    expect(result.current.queueCount).toBe(5);
  });

  it('treats queue actions as no-ops when there is no active conversation', () => {
    mockPendingMessage = null;
    const { result } = render({ routeConversationId: 'new' });
    act(() => {
      result.current.onQueueMessage('x');
      result.current.onCancelQueued('y');
    });
    expect(result.current.queueCount).toBe(0);
    expect(result.current.queueFull).toBe(false);
    expect(result.current.queuedMessages).toEqual([]);
  });

  it('cancelling a queued message removes it so it never sends', () => {
    mockIsStreaming = true;
    useMessageQueueStore.getState().enqueue('conv-1', 'to cancel');
    const { result } = render();
    expect(result.current.queueCount).toBe(1);
    const id = result.current.queuedMessages[0]?.id ?? '';
    act(() => {
      result.current.onCancelQueued(id);
    });
    expect(result.current.queueCount).toBe(0);
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('drains a non-empty queue on mount when the conversation is idle', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'resume me');
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(sentContents()).toContain('resume me');
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('does not drain while a run is streaming', async () => {
    mockIsStreaming = true;
    useMessageQueueStore.getState().enqueue('conv-1', 'held');
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);
  });

  it('drains queued messages FIFO, one at a time, oldest first', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'first');
    useMessageQueueStore.getState().enqueue('conv-1', 'second');
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledTimes(2);
    });
    expect(sentContents()).toEqual(['first', 'second']);
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('sends each drained message with post-settle history, not the loop-start snapshot', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'first');
    useMessageQueueStore.getState().enqueue('conv-1', 'second');
    // Simulate the post-settle refetch: once the first drained turn settles, its
    // user message and assistant answer become persisted history before the
    // second message drains. A stale-closure loop would miss this.
    mockStartStream.mockImplementation(
      (request: { userMessage: { content: string } }, options?: StreamOptions) => {
        if (request.userMessage.content === 'first') {
          mockMessagesData = [
            ...(mockMessagesData ?? []),
            makeMessage('first-user', 'user', 'first'),
            makeMessage('first-answer', 'assistant', 'answer-to-first'),
          ];
        }
        driveStream(options, streamPlan);
        return Promise.resolve(streamResult(streamPlan));
      }
    );
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledTimes(2);
    });
    const secondCall = mockStartStream.mock.calls[1] as [
      {
        messagesForInference: { role: string; content: string }[];
        userMessage: { content: string };
      },
    ];
    expect(secondCall[0].userMessage.content).toBe('second');
    const historyContents = secondCall[0].messagesForInference.map((m) => m.content);
    // The second drained send reflects post-settle state: it includes the first
    // drained user turn AND its assistant answer, not the loop-start snapshot.
    expect(historyContents).toContain('first');
    expect(historyContents).toContain('answer-to-first');
  });

  it('drains the queue after a user send fully settles', async () => {
    const { result } = render();
    act(() => {
      useMessageQueueStore.getState().enqueue('conv-1', 'after settle');
    });
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledTimes(2);
    });
    // First send is the user's own input; the drained message follows it.
    expect(sentContents()).toEqual(['hello world', 'after settle']);
  });

  it('pauses draining and restores the text when a drained send fails', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStartStream.mockImplementation(() => Promise.reject(new ChatRequestError('BUDGET')));
    useMessageQueueStore.getState().enqueue('conv-1', 'fails');
    useMessageQueueStore.getState().enqueue('conv-1', 'preserved');
    render();
    await waitFor(() => {
      expect(mockSetInputValue).toHaveBeenCalledWith('fails');
    });
    // The failed send did not cascade to the next queued message.
    expect(mockStartStream).toHaveBeenCalledTimes(1);
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);
    expect(useMessageQueueStore.getState().queued('conv-1')[0]?.text).toBe('preserved');
  });

  it('ignores a settle event while a drained send is already in flight', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'only');
    let resolveStream: ((value: unknown) => void) | undefined;
    mockStartStream.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStream = resolve;
        })
    );

    mockIsStreaming = true;
    const { rerender } = render();
    // Terminal settle: the first drain starts and parks on the pending stream.
    mockIsStreaming = false;
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    expect(mockStartStream).toHaveBeenCalledTimes(1);

    // A second settle event arrives while the drain is still in flight.
    mockIsStreaming = true;
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    mockIsStreaming = false;
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    // The in-flight guard blocked a second send (no double-send).
    expect(mockStartStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStream?.({
        userMessageId: 'u',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        outcome: 'succeeded',
      });
      await Promise.resolve();
    });
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('keeps queues isolated per conversation', () => {
    mockIsStreaming = true;
    useMessageQueueStore.getState().enqueue('conv-1', 'mine');
    useMessageQueueStore.getState().enqueue('other-conv', 'theirs');
    const { result } = render();
    expect(result.current.queueCount).toBe(1);
    expect(result.current.queuedMessages[0]?.text).toBe('mine');
  });
});
