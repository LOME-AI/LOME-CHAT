import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  generateEpochKeyPair,
  generateContentKey,
  wrapContentKeyToEpoch,
  openShare,
  type WrappedContentKey,
} from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';

// Real crypto end-to-end: the share-create mutation must unwrap the message's
// content key with the LIVE labeled epoch scheme (`wrapContentKeyToEpoch`'s
// counterpart), re-wrap it under a fresh per-share secret, and produce a share
// whose URL secret + wire-wrapped key recover the ORIGINAL content key. Only
// the network POST and the epoch-key cache are mocked; the crypto is the
// contract under test. Against the old unlabeled envelope reader the unwrap's
// AEAD tag fails and the mutation throws before any recovery is possible.

const mockPost = vi.fn<(payload: unknown, headers?: unknown) => Response>();
const mockFetchJson = vi.fn<(input: unknown) => Promise<unknown>>();

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      [':conversationId']: {
        shares: { $post: (payload: unknown, headers?: unknown) => mockPost(payload, headers) },
      },
    },
  },
  fetchJson: (input: unknown) => mockFetchJson(input),
}));

const mockGetEpochKey =
  vi.fn<(conversationId: string, epochNumber: number) => Uint8Array | undefined>();

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: (conversationId: string, epochNumber: number) =>
    mockGetEpochKey(conversationId, epochNumber),
}));

interface SharePostPayload {
  json: { wrappedContentKey: string };
}

function createWrapper(
  options: { mutationRetry?: number } = {}
): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: options.mutationRetry ?? false, retryDelay: 0 },
    },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('useMessageShare round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces a share whose URL secret recovers the original epoch-wrapped content key', async () => {
    // The message's content key, wrapped to the epoch exactly as the backend
    // does (`wrapContentKeyToEpoch` = the labeled HKDF scheme).
    const epoch = generateEpochKeyPair();
    const contentKey = generateContentKey();
    const wrappedToEpoch = wrapContentKeyToEpoch(epoch.publicKey, contentKey);

    mockGetEpochKey.mockReturnValue(epoch.privateKey);
    mockFetchJson.mockResolvedValue({ shareId: 'share-1' });

    const { useMessageShare } = await import('@/hooks/chat/use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), { wrapper: createWrapper() });

    const output = await result.current.mutateAsync({
      messageId: 'm1',
      conversationId: 'c1',
      epochNumber: 3,
      wrappedContentKey: toBase64(wrappedToEpoch),
    });

    // Viewer side: the wire-wrapped key from the POST body and the secret from
    // the URL fragment must open exactly the content key the sharer held.
    const [payload] = mockPost.mock.calls[0]!;
    const wrappedShareKey = fromBase64(
      (payload as SharePostPayload).json.wrappedContentKey
    ) as WrappedContentKey;
    const shareSecret = fromBase64(new URL(output.url).hash.slice(1));
    const recovered = openShare(shareSecret, wrappedShareKey);

    expect(toBase64(recovered)).toBe(toBase64(contentKey));
    expect(output.shareId).toBe('share-1');
  });

  // Retry/replay contract: the server dedups a retried POST by its stable
  // Idempotency-Key and keeps the FIRST attempt's stored wrap. The URL secret
  // the client hands the user must therefore open that first wrap — the share
  // secret is minted once per logical mutation, not once per attempt.
  it('keeps the first attempt wrap openable by the returned URL secret when the POST is retried', async () => {
    const epoch = generateEpochKeyPair();
    const contentKey = generateContentKey();
    const wrappedToEpoch = wrapContentKeyToEpoch(epoch.publicKey, contentKey);

    mockGetEpochKey.mockReturnValue(epoch.privateKey);
    // Attempt 1: the server persists the posted wrap but the response is lost.
    // Attempt 2: idempotent replay of the stored share.
    mockFetchJson
      .mockRejectedValueOnce(new Error('network failure after server persisted'))
      .mockResolvedValueOnce({ shareId: 'share-1' });

    const { useMessageShare } = await import('@/hooks/chat/use-message-share.js');
    const { result } = renderHook(() => useMessageShare(), {
      wrapper: createWrapper({ mutationRetry: 1 }),
    });

    const output = await result.current.mutateAsync({
      messageId: 'm1',
      conversationId: 'c1',
      epochNumber: 3,
      wrappedContentKey: toBase64(wrappedToEpoch),
    });

    expect(mockPost).toHaveBeenCalledTimes(2);
    const firstWrapB64 = (mockPost.mock.calls[0]![0] as SharePostPayload).json.wrappedContentKey;
    const retryWrapB64 = (mockPost.mock.calls[1]![0] as SharePostPayload).json.wrappedContentKey;
    // Both attempts carry the same wrap — the secret was not re-minted.
    expect(retryWrapB64).toBe(firstWrapB64);

    // Guest side: the fragment secret must open the wrap the server stored on
    // attempt 1 and recover the original content key.
    const storedWrap = fromBase64(firstWrapB64) as WrappedContentKey;
    const shareSecret = fromBase64(new URL(output.url).hash.slice(1));
    const recovered = openShare(shareSecret, storedWrap);
    expect(toBase64(recovered)).toBe(toBase64(contentKey));
  });
});
