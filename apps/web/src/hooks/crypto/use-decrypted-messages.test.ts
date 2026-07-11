import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, StrictMode, type ReactNode } from 'react';
import {
  useDecryptedMessages,
  clearDecryptedMessageCache,
} from '@/hooks/crypto/use-decrypted-messages';
import type { MessageResponse } from '@hushbox/shared';
import { clearEpochKeyCache, getCacheSize } from '@/lib/epoch-key-cache';
import { useDecryptionActivityStore } from '@/stores/decryption-activity';

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      [':conversationId']: {
        keychain: {
          $get: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';
import type React from 'react';

const mockFetchJson = vi.mocked(fetchJson);

const mockUnwrapEpochKey = vi.fn<(accountPrivateKey: Uint8Array, wrap: Uint8Array) => Uint8Array>();
const mockTraverseChainLink =
  vi.fn<(newerEpochPrivateKey: Uint8Array, chainLink: Uint8Array) => Uint8Array>();
const mockOpenMessageEnvelope =
  vi.fn<(epochPrivateKey: Uint8Array, wrappedContentKey: Uint8Array) => Uint8Array>();
const mockDecryptTextWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  unwrapEpochKey: (...args: [Uint8Array, Uint8Array]) => mockUnwrapEpochKey(...args),
  traverseChainLink: (...args: [Uint8Array, Uint8Array]) => mockTraverseChainLink(...args),
  openMessageEnvelope: (...args: [Uint8Array, Uint8Array]) => mockOpenMessageEnvelope(...args),
  decryptTextWithContentKey: (...args: [Uint8Array, Uint8Array]) =>
    mockDecryptTextWithContentKey(...args),
  verifyEpochKeyConfirmation: () => true,
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => mockFromBase64(b64),
  };
});

let mockPrivateKey: Uint8Array | null = new Uint8Array([99, 98, 97]);

vi.mock('@/lib/auth', () => {
  // Zustand hook: called as function returns state, also has getState/subscribe
  const store = Object.assign(
    (selector?: (s: { privateKey: Uint8Array | null }) => unknown) => {
      const state = { privateKey: mockPrivateKey };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({ privateKey: mockPrivateKey }),
      setState: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      destroy: vi.fn(),
    }
  );
  return { useAuthStore: store };
});

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

interface MessageResponseOverrides extends Partial<Omit<MessageResponse, 'contentItems'>> {
  /** Shortcut: base64 encrypted blob for the single default text content item. */
  encryptedBlob?: string;
  /** Shortcut: model_name on the default text content item (AI messages). */
  modelName?: string | null;
  /** Shortcut: cost on the default text content item. */
  cost?: string | null;
  contentItems?: MessageResponse['contentItems'];
}

function createMessageResponse(overrides: MessageResponseOverrides = {}): MessageResponse {
  const {
    encryptedBlob: encryptedBlobOverride,
    modelName: modelNameOverride,
    cost: costOverride,
    contentItems: contentItemsOverride,
    ...rest
  } = overrides;

  return {
    id: 'msg-1',
    conversationId: 'conv-1',
    wrappedContentKey: 'base64-wrapped',
    senderType: 'user',
    senderId: 'user-1',
    epochNumber: 1,
    sequenceNumber: 0,
    parentMessageId: null,
    batchId: 'batch-1',
    createdAt: '2026-01-01T00:00:00Z',
    contentItems: contentItemsOverride ?? [
      {
        id: `${rest.id ?? 'msg-1'}-ci`,
        contentType: 'text',
        position: 0,
        encryptedBlob: encryptedBlobOverride ?? 'base64-blob',
        storageKey: null,
        mimeType: null,
        sizeBytes: null,
        width: null,
        height: null,
        durationMs: null,
        modelName: modelNameOverride ?? null,
        cost: costOverride ?? null,
        isSmartModel: false,
      },
    ],
    ...rest,
  };
}

describe('useDecryptedMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
    clearDecryptedMessageCache();
    mockPrivateKey = new Uint8Array([99, 98, 97]);
    mockFromBase64.mockImplementation((b64: string) => new TextEncoder().encode(b64));
    mockOpenMessageEnvelope.mockImplementation(
      (epochPriv: Uint8Array, _wrapped: Uint8Array) => epochPriv
    );
    mockDecryptTextWithContentKey.mockImplementation(
      (_contentKey: Uint8Array, _ciphertext: Uint8Array) => ''
    );
  });

  it('returns empty array when conversationId is null', () => {
    const { result } = renderHook(() => useDecryptedMessages(null, []), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when messages is undefined', () => {
    mockFetchJson.mockResolvedValue({ wraps: [], chainLinks: [], currentEpoch: 1 });

    // eslint-disable-next-line unicorn/no-useless-undefined -- explicitly testing the undefined branch
    const { result } = renderHook(() => useDecryptedMessages('conv-1', undefined), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when messages is empty', () => {
    mockFetchJson.mockResolvedValue({ wraps: [], chainLinks: [], currentEpoch: 1 });

    const { result } = renderHook(() => useDecryptedMessages('conv-1', []), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('returns empty array when privateKey is null', () => {
    mockPrivateKey = null;

    const messages = [createMessageResponse()];
    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    expect(result.current).toEqual([]);
  });

  it('decrypts single-epoch messages correctly', async () => {
    const epochKey = new Uint8Array([10, 20, 30]);
    mockUnwrapEpochKey.mockReturnValue(epochKey);
    mockDecryptTextWithContentKey.mockImplementation(
      (_key: Uint8Array, _blob: Uint8Array) => 'Hello world'
    );

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'wrapped-key',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [
      createMessageResponse({
        id: 'msg-1',
        senderType: 'user',
        epochNumber: 1,
        encryptedBlob: 'blob-1',
      }),
      createMessageResponse({
        id: 'msg-2',
        senderType: 'ai',
        epochNumber: 1,
        encryptedBlob: 'blob-2',
      }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('Hello world');
    });

    const first = result.current[0];
    if (!first) throw new Error('Expected message at index 0');
    expect(first.role).toBe('user');
    expect(first.content).toBe('Hello world');
    expect(first.id).toBe('msg-1');
    expect(first.conversationId).toBe('conv-1');

    const second = result.current[1];
    if (!second) throw new Error('Expected message at index 1');
    expect(second.role).toBe('assistant');
    expect(second.content).toBe('Hello world');
    expect(second.id).toBe('msg-2');
  });

  it('maps senderType "user" to role "user"', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ senderType: 'user' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.role).toBe('user');
  });

  it('maps senderType "ai" to role "assistant"', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('ai content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ senderType: 'ai' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.role).toBe('assistant');
  });

  it('handles multi-epoch messages with chain link traversal', async () => {
    const epoch2Key = new Uint8Array([20]);
    const epoch1Key = new Uint8Array([10]);

    mockUnwrapEpochKey.mockReturnValue(epoch2Key);
    mockTraverseChainLink.mockReturnValue(epoch1Key);
    mockDecryptTextWithContentKey.mockImplementation((key: Uint8Array) =>
      key[0] === 20 ? 'epoch2-msg' : 'epoch1-msg'
    );

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 2,
          wrap: 'w2',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [{ epochNumber: 2, chainLink: 'cl-2to1', confirmationHash: 'h' }],
      currentEpoch: 2,
    });

    const messages = [
      createMessageResponse({ id: 'old', epochNumber: 1, encryptedBlob: 'b1' }),
      createMessageResponse({ id: 'new', epochNumber: 2, encryptedBlob: 'b2' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('epoch1-msg');
    });

    const oldMsg = result.current[0];
    if (!oldMsg) throw new Error('Expected old message');
    expect(oldMsg.content).toBe('epoch1-msg');

    const newMsg = result.current[1];
    if (!newMsg) throw new Error('Expected new message');
    expect(newMsg.content).toBe('epoch2-msg');

    expect(mockTraverseChainLink).toHaveBeenCalledTimes(1);
    const [calledWithKey] = mockTraverseChainLink.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(calledWithKey).toBe(epoch2Key);
  });

  it('caches epoch keys and does not re-unwrap on subsequent renders', async () => {
    const epochKey = new Uint8Array([50]);
    mockUnwrapEpochKey.mockReturnValue(epochKey);
    mockDecryptTextWithContentKey.mockReturnValue('cached');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ epochNumber: 1 })];

    const { result, rerender } = renderHook(
      ({ convId, msgs }: { convId: string; msgs: MessageResponse[] }) =>
        useDecryptedMessages(convId, msgs),
      {
        initialProps: { convId: 'conv-1', msgs: messages },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('cached');
    });

    expect(mockUnwrapEpochKey).toHaveBeenCalledTimes(1);

    rerender({ convId: 'conv-1', msgs: messages });

    // unwrapEpochKey should NOT be called again (cache hit)
    expect(mockUnwrapEpochKey).toHaveBeenCalledTimes(1);
    expect(getCacheSize()).toBe(1);
  });

  it('returns same reference for same input (memoized)', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('memoized');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse()];

    const { result, rerender } = renderHook(
      ({ convId, msgs }: { convId: string; msgs: MessageResponse[] }) =>
        useDecryptedMessages(convId, msgs),
      {
        initialProps: { convId: 'conv-1', msgs: messages },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const firstResult = result.current;

    rerender({ convId: 'conv-1', msgs: messages });

    expect(result.current).toBe(firstResult);
  });

  it('returns new reference for new message input', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages1 = [createMessageResponse({ id: 'msg-1' })];
    const messages2 = [createMessageResponse({ id: 'msg-2' })];

    const { result, rerender } = renderHook(
      ({ convId, msgs }: { convId: string; msgs: MessageResponse[] }) =>
        useDecryptedMessages(convId, msgs),
      {
        initialProps: { convId: 'conv-1', msgs: messages1 },
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const firstResult = result.current;

    rerender({ convId: 'conv-1', msgs: messages2 });

    await waitFor(() => {
      expect(result.current).not.toBe(firstResult);
    });
  });

  it('shows fallback when decryptTextFromEpoch throws', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockImplementation(() => {
      throw new Error('corrupted blob');
    });

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ id: 'bad-msg' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('[decryption failed]');
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.content).toBe('[decryption failed]');
    expect(msg.role).toBe('user');
  });

  it('shows fallback for missing epoch key', async () => {
    // Key chain has epoch 2 wrap but message references epoch 1 with no chain link
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([20]));
    mockDecryptTextWithContentKey.mockReturnValue('epoch2-content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 2,
          wrap: 'w2',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [], // no chain link to reach epoch 1
      currentEpoch: 2,
    });

    const messages = [
      createMessageResponse({ id: 'orphan', epochNumber: 1 }),
      createMessageResponse({ id: 'good', epochNumber: 2 }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[1]?.content).toBe('epoch2-content');
    });

    const orphan = result.current[0];
    if (!orphan) throw new Error('Expected orphan message');
    expect(orphan.content).toBe('[decryption failed: missing epoch key]');

    const good = result.current[1];
    if (!good) throw new Error('Expected good message');
    expect(good.content).toBe('epoch2-content');
  });

  it('handles corrupted wrap gracefully', async () => {
    mockUnwrapEpochKey.mockImplementation(() => {
      throw new Error('ECIES decryption failed');
    });

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'corrupted',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ epochNumber: 1 })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.content).toBe('[decryption failed: missing epoch key]');
  });

  it('passes through cost from message response', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [
      createMessageResponse({ id: 'user-msg', senderType: 'user', cost: null }),
      createMessageResponse({ id: 'ai-msg', senderType: 'ai', cost: '0.00136000' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(2);
    });

    const userMsg = result.current[0];
    if (!userMsg) throw new Error('Expected user message');
    expect(userMsg.cost).toBeUndefined();

    const aiMsg = result.current[1];
    if (!aiMsg) throw new Error('Expected AI message');
    expect(aiMsg.cost).toBe('0.00136000');
  });

  it('preserves senderId from the message response on successful decryption', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [
      createMessageResponse({ id: 'msg-with-sender', senderId: 'user-42', senderType: 'user' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBe('user-42');
  });

  it('omits senderId when null in the message response', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('ai content');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ id: 'ai-msg', senderId: null, senderType: 'ai' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBeUndefined();
  });

  it('preserves senderId on decryption failure fallback', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockImplementation(() => {
      throw new Error('corrupted');
    });

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [
      createMessageResponse({ id: 'bad', senderId: 'user-99', senderType: 'user' }),
    ];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current[0]?.content).toBe('[decryption failed]');
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBe('user-99');
    expect(msg.content).toBe('[decryption failed]');
  });

  it('preserves senderId on missing epoch key fallback', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([20]));

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 2,
          wrap: 'w2',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 2,
    });

    const messages = [createMessageResponse({ id: 'orphan', epochNumber: 1, senderId: 'user-77' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.senderId).toBe('user-77');
    expect(msg.content).toBe('[decryption failed: missing epoch key]');
  });

  describe('decryption activity tracking', () => {
    beforeEach(() => {
      useDecryptionActivityStore.setState({ pendingDecryptions: 0 });
    });

    it('marks pending when messages exist but decryption output is empty', async () => {
      // Key chain fetch will never resolve — decrypted output stays empty
      mockFetchJson.mockReturnValue(new Promise(() => {}));

      const messages = [createMessageResponse()];
      renderHook(() => useDecryptedMessages('conv-1', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);
      });
    });

    it('marks complete when decryption produces output', async () => {
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
      mockDecryptTextWithContentKey.mockReturnValue('decrypted');

      mockFetchJson.mockResolvedValue({
        wraps: [
          {
            epochNumber: 1,
            wrap: 'w',
            confirmationHash: 'h',
            privilege: 'owner',
            visibleFromEpoch: 1,
          },
        ],
        chainLinks: [],
        currentEpoch: 1,
      });

      const messages = [createMessageResponse()];
      const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current).toHaveLength(1);
      });

      expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
    });

    it('does not mark pending when there are no messages', () => {
      renderHook(() => useDecryptedMessages('conv-1', []), {
        wrapper: createWrapper(),
      });

      expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
    });

    it('does not mark pending when conversationId is null', () => {
      const messages = [createMessageResponse()];
      renderHook(() => useDecryptedMessages(null, messages), {
        wrapper: createWrapper(),
      });

      expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
    });

    it('cleans up on unmount', async () => {
      mockFetchJson.mockReturnValue(new Promise(() => {}));

      const messages = [createMessageResponse()];
      const { unmount } = renderHook(() => useDecryptedMessages('conv-1', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(1);
      });

      unmount();

      expect(useDecryptionActivityStore.getState().pendingDecryptions).toBe(0);
    });
  });

  it('preserves createdAt from the message response', async () => {
    mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
    mockDecryptTextWithContentKey.mockReturnValue('time check');

    mockFetchJson.mockResolvedValue({
      wraps: [
        {
          epochNumber: 1,
          wrap: 'w',
          confirmationHash: 'h',
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
      chainLinks: [],
      currentEpoch: 1,
    });

    const messages = [createMessageResponse({ createdAt: '2026-02-01T12:00:00Z' })];

    const { result } = renderHook(() => useDecryptedMessages('conv-1', messages), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current).toHaveLength(1);
    });

    const msg = result.current[0];
    if (!msg) throw new Error('Expected message');
    expect(msg.createdAt).toBe('2026-02-01T12:00:00Z');
  });

  describe('per-message decrypted-content cache', () => {
    it('decrypts only the new message when one is appended', async () => {
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
      mockDecryptTextWithContentKey.mockReturnValue('content');

      mockFetchJson.mockResolvedValue({
        wraps: [
          {
            epochNumber: 1,
            wrap: 'w',
            confirmationHash: 'h',
            privilege: 'owner',
            visibleFromEpoch: 1,
          },
        ],
        chainLinks: [],
        currentEpoch: 1,
      });

      const initial = [
        createMessageResponse({ id: 'm1', epochNumber: 1, encryptedBlob: 'b1' }),
        createMessageResponse({ id: 'm2', epochNumber: 1, encryptedBlob: 'b2' }),
      ];

      const { result, rerender } = renderHook(
        ({ msgs }: { msgs: MessageResponse[] }) => useDecryptedMessages('conv-cache', msgs),
        {
          initialProps: { msgs: initial },
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => {
        expect(result.current[1]?.content).toBe('content');
      });

      expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(2);
      mockDecryptTextWithContentKey.mockClear();

      // Realtime invalidation produces a NEW array reference with one new message.
      const withNew = [
        createMessageResponse({ id: 'm1', epochNumber: 1, encryptedBlob: 'b1' }),
        createMessageResponse({ id: 'm2', epochNumber: 1, encryptedBlob: 'b2' }),
        createMessageResponse({ id: 'm3', epochNumber: 1, encryptedBlob: 'b3' }),
      ];
      rerender({ msgs: withNew });

      await waitFor(() => {
        expect(result.current[2]?.content).toBe('content');
      });

      // Only the new message m3 is decrypted; m1/m2 reuse cached plaintext.
      expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(1);
    });

    it('re-decrypts a message when its epoch changes', async () => {
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
      mockDecryptTextWithContentKey.mockReturnValue('content');

      mockFetchJson.mockResolvedValue({
        wraps: [
          {
            epochNumber: 1,
            wrap: 'w1',
            confirmationHash: 'h',
            privilege: 'owner',
            visibleFromEpoch: 1,
          },
          {
            epochNumber: 2,
            wrap: 'w2',
            confirmationHash: 'h',
            privilege: 'owner',
            visibleFromEpoch: 1,
          },
        ],
        chainLinks: [],
        currentEpoch: 2,
      });

      const epoch1 = [createMessageResponse({ id: 'rot', epochNumber: 1, encryptedBlob: 'b' })];

      const { result, rerender } = renderHook(
        ({ msgs }: { msgs: MessageResponse[] }) => useDecryptedMessages('conv-rotate', msgs),
        {
          initialProps: { msgs: epoch1 },
          wrapper: createWrapper(),
        }
      );

      await waitFor(() => {
        expect(result.current[0]?.content).toBe('content');
      });

      expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(1);
      mockDecryptTextWithContentKey.mockClear();

      // Same message id, rotated to a new epoch — cache entry must invalidate.
      const epoch2 = [createMessageResponse({ id: 'rot', epochNumber: 2, encryptedBlob: 'b' })];
      rerender({ msgs: epoch2 });

      // The rotated message is a cache miss (epoch changed), so it re-decrypts.
      await waitFor(() => {
        expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(1);
      });
      expect(result.current[0]?.epochNumber).toBe(2);
    });

    it('does not double-decrypt under StrictMode', async () => {
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([1]));
      mockDecryptTextWithContentKey.mockReturnValue('content');

      mockFetchJson.mockResolvedValue({
        wraps: [
          {
            epochNumber: 1,
            wrap: 'w',
            confirmationHash: 'h',
            privilege: 'owner',
            visibleFromEpoch: 1,
          },
        ],
        chainLinks: [],
        currentEpoch: 1,
      });

      const messages = [createMessageResponse({ id: 'sm', epochNumber: 1, encryptedBlob: 'b' })];

      function StrictWrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
        const Base = createWrapper();
        return createElement(StrictMode, null, createElement(Base, null, children));
      }

      const { result } = renderHook(() => useDecryptedMessages('conv-strict', messages), {
        wrapper: StrictWrapper,
      });

      await waitFor(() => {
        expect(result.current[0]?.content).toBe('content');
      });

      const msg = result.current[0];
      if (!msg) throw new Error('Expected message');
      expect(msg.content).toBe('content');

      // StrictMode double-invokes render; the cache must collapse the side
      // effect so decryption runs once, not twice.
      expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('stale epoch key refetch', () => {
    beforeEach(() => {
      mockFetchJson.mockReset();
    });

    it('refetches keys when a message epoch exceeds the cached currentEpoch', async () => {
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([10]));
      mockDecryptTextWithContentKey.mockReturnValue('decrypted-content');

      mockFetchJson
        .mockResolvedValueOnce({
          wraps: [
            {
              epochNumber: 1,
              wrap: 'w1',
              confirmationHash: 'h',
              privilege: 'owner',
              visibleFromEpoch: 1,
            },
          ],
          chainLinks: [],
          currentEpoch: 1,
        })
        .mockResolvedValueOnce({
          wraps: [
            {
              epochNumber: 1,
              wrap: 'w1',
              confirmationHash: 'h',
              privilege: 'owner',
              visibleFromEpoch: 1,
            },
            {
              epochNumber: 2,
              wrap: 'w2',
              confirmationHash: 'h',
              privilege: 'owner',
              visibleFromEpoch: 1,
            },
          ],
          chainLinks: [{ epochNumber: 2, chainLink: 'cl', confirmationHash: 'h' }],
          currentEpoch: 2,
        });

      const messages = [
        createMessageResponse({ id: 'msg-1', conversationId: 'conv-refetch-1', epochNumber: 1 }),
        createMessageResponse({ id: 'msg-2', conversationId: 'conv-refetch-1', epochNumber: 2 }),
      ];

      const { result } = renderHook(() => useDecryptedMessages('conv-refetch-1', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        const msg2 = result.current.find((m) => m.id === 'msg-2');
        expect(msg2?.content).toBe('decrypted-content');
      });

      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    it('does not refetch when missing epoch keys are within currentEpoch', async () => {
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([20]));
      mockDecryptTextWithContentKey.mockReturnValue('epoch2-content');

      mockFetchJson.mockResolvedValue({
        wraps: [
          {
            epochNumber: 2,
            wrap: 'w2',
            confirmationHash: 'h',
            privilege: 'owner',
            visibleFromEpoch: 1,
          },
        ],
        chainLinks: [],
        currentEpoch: 2,
      });

      const messages = [
        createMessageResponse({ id: 'orphan', conversationId: 'conv-refetch-2', epochNumber: 1 }),
        createMessageResponse({ id: 'good', conversationId: 'conv-refetch-2', epochNumber: 2 }),
      ];

      const { result } = renderHook(() => useDecryptedMessages('conv-refetch-2', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current).toHaveLength(2);
      });

      const orphan = result.current[0];
      if (!orphan) throw new Error('Expected orphan message');
      expect(orphan.content).toBe('[decryption failed: missing epoch key]');

      // Only one fetch — no refetch triggered since epoch 1 <= currentEpoch 2
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });

    it('does not refetch more than once for the same stale currentEpoch', async () => {
      mockUnwrapEpochKey.mockReturnValue(new Uint8Array([10]));
      mockDecryptTextWithContentKey.mockReturnValue('content');

      // Server always returns currentEpoch: 1 (simulates delayed rotation)
      mockFetchJson.mockResolvedValue({
        wraps: [
          {
            epochNumber: 1,
            wrap: 'w1',
            confirmationHash: 'h',
            privilege: 'owner',
            visibleFromEpoch: 1,
          },
        ],
        chainLinks: [],
        currentEpoch: 1,
      });

      const messages = [
        createMessageResponse({ id: 'msg-1', conversationId: 'conv-refetch-3', epochNumber: 1 }),
        createMessageResponse({ id: 'msg-2', conversationId: 'conv-refetch-3', epochNumber: 3 }),
      ];

      const { result } = renderHook(() => useDecryptedMessages('conv-refetch-3', messages), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current).toHaveLength(2);
      });

      // Wait a tick to ensure no further refetches are triggered
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      // Initial fetch + exactly one refetch = 2 calls total, NOT more
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });
  });
});
