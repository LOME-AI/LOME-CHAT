import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      [':conversationId']: {
        shares: { $post: vi.fn(() => Promise.resolve(new Response())) },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { client, fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);
const mockPost = vi.mocked(client.conversations[':conversationId'].shares.$post);

const mockGetEpochKey = vi.fn<(conversationId: string, epochNumber: number) => Uint8Array | null>();

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: (conversationId: string, epochNumber: number) =>
    mockGetEpochKey(conversationId, epochNumber),
}));

const mockOpenMessageEnvelope =
  vi.fn<(epochPrivateKey: Uint8Array, wrappedContentKey: Uint8Array) => Uint8Array>();
const mockCreateShare =
  vi.fn<(contentKey: Uint8Array) => { shareSecret: Uint8Array; wrappedShareKey: Uint8Array }>();

vi.mock('@hushbox/crypto', () => ({
  openMessageEnvelope: (...args: [Uint8Array, Uint8Array]) => mockOpenMessageEnvelope(...args),
  createShare: (contentKey: Uint8Array) => mockCreateShare(contentKey),
}));

const mockToBase64 = vi.fn<(data: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: (data: Uint8Array) => mockToBase64(data),
    fromBase64: (b64: string) => mockFromBase64(b64),
  };
});

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('useMessageShare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unwraps the content key, re-wraps under a fresh share secret, POSTs the wrap with an Idempotency-Key, and returns the share URL', async () => {
    const epochKey = new Uint8Array([9, 9]);
    const wrappedContentBytes = new Uint8Array([1, 1]);
    const contentKey = new Uint8Array([2, 2]);
    const shareSecret = new Uint8Array([3, 3]);
    const wrappedShareKey = new Uint8Array([4, 4]);

    mockGetEpochKey.mockReturnValue(epochKey);
    mockFromBase64.mockImplementation((b64) =>
      b64 === 'wrapped-content-b64' ? wrappedContentBytes : new Uint8Array()
    );
    mockOpenMessageEnvelope.mockReturnValue(contentKey);
    mockCreateShare.mockReturnValue({ shareSecret, wrappedShareKey });
    mockToBase64.mockImplementation((data) => {
      if (data === wrappedShareKey) return 'wrapped-share-b64';
      if (data === shareSecret) return 'secret-b64';
      return 'other';
    });
    mockFetchJson.mockResolvedValue({ shareId: 'share-xyz' });

    const { useMessageShare } = await import('@/hooks/chat/use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    const output = await result.current.mutateAsync({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      epochNumber: 2,
      wrappedContentKey: 'wrapped-content-b64',
    });

    expect(mockGetEpochKey).toHaveBeenCalledWith('conv-1', 2);
    expect(mockOpenMessageEnvelope).toHaveBeenCalledTimes(1);
    const [openKey, openWrap] = mockOpenMessageEnvelope.mock.calls[0]!;
    expect(openKey).toBe(epochKey);
    expect(openWrap).toBe(wrappedContentBytes);
    expect(mockCreateShare).toHaveBeenCalledWith(contentKey);

    // Real typed POST to /conversations/:conversationId/shares with the aligned
    // `wrappedContentKey` field name, carrying an Idempotency-Key.
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [payload, headers] = mockPost.mock.calls[0]!;
    expect(payload).toEqual({
      param: { conversationId: 'conv-1' },
      json: { messageId: 'msg-1', wrappedContentKey: 'wrapped-share-b64' },
    });
    expect(headers).toEqual({ headers: { 'Idempotency-Key': expect.any(String) } });

    expect(output.shareId).toBe('share-xyz');
    expect(output.url).toBe(`${globalThis.location.origin}/share/m/share-xyz#secret-b64`);
  });

  it('throws when the epoch key is not available in the cache', async () => {
    mockGetEpochKey.mockReturnValue(null);

    const { useMessageShare } = await import('@/hooks/chat/use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    await expect(
      result.current.mutateAsync({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        epochNumber: 1,
        wrappedContentKey: 'k',
      })
    ).rejects.toThrow('Epoch key not available');

    expect(mockCreateShare).not.toHaveBeenCalled();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});
