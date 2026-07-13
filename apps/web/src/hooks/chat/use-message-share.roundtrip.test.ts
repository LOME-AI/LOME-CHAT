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
});
