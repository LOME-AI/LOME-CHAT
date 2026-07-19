import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { MAX_MEDIA_OBJECT_BYTES } from '@hushbox/shared';
import type { ContentKey, ContentLocation, LegacyContentKey, WrappedSecret } from '@hushbox/crypto';

const mockDecryptBinaryWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => Uint8Array>();
const mockDecryptContentEnvelope =
  vi.fn<
    (
      contentKey: Uint8Array,
      wrappedContentKey: Uint8Array,
      location: ContentLocation,
      blob: Uint8Array
    ) => Uint8Array
  >();

vi.mock('@hushbox/crypto', () => ({
  decryptBinaryWithContentKey: (...args: [Uint8Array, Uint8Array]) =>
    mockDecryptBinaryWithContentKey(...args),
  decryptContentEnvelope: (...args: [Uint8Array, Uint8Array, ContentLocation, Uint8Array]) =>
    mockDecryptContentEnvelope(...args),
}));

const sampleLocation: ContentLocation = {
  conversationId: 'conv-1',
  messageId: 'msg-1',
  contentItemId: 'ci-1',
  position: 0,
  epochNumber: 1,
  senderId: 'sender-1',
};

const mockCreateObjectURL = vi.fn<(blob: Blob) => string>();
const mockRevokeObjectURL = vi.fn<(url: string) => void>();
const mockFetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();

import { useDecryptBlob, blobCacheKeys } from '@/hooks/crypto/use-decrypt-blob';
import { installBlobUrlCacheGc } from '@/lib/blob-url-cache-gc';

let activeQueryClient: QueryClient;
let detachGc: (() => void) | null = null;

function makeWrapper(): {
  wrapper: ({ children }: { children: ReactNode }) => ReactNode;
  queryClient: QueryClient;
} {
  activeQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  detachGc = installBlobUrlCacheGc(activeQueryClient);
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: activeQueryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return { wrapper: Wrapper, queryClient: activeQueryClient };
}

// Stable default id — each test creates its own QueryClient via `makeWrapper`,
// so there's no cross-test cache bleed. Tests that exercise multiple distinct
// items override this explicitly.
function defaultParams(
  overrides: Partial<Parameters<typeof useDecryptBlob>[0]> = {}
): Parameters<typeof useDecryptBlob>[0] {
  return {
    contentItemId: 'default-item',
    downloadUrl: 'https://signed.example/img?sig=a',
    contentKey: new Uint8Array([4, 5, 6]) as LegacyContentKey,
    mimeType: 'image/png',
    ...overrides,
  };
}

function createFetchResponse(bytes: Uint8Array, ok = true, status = 200): Response {
  return {
    ok,
    status,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as Response;
}

describe('useDecryptBlob', () => {
  let urlCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    urlCounter = 0;
    mockCreateObjectURL.mockImplementation(() => {
      urlCounter += 1;
      return `blob:decrypt-blob-mock-${String(urlCounter)}`;
    });
    vi.stubGlobal('URL', {
      ...globalThis.URL,
      createObjectURL: mockCreateObjectURL,
      revokeObjectURL: mockRevokeObjectURL,
    });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    detachGc?.();
    detachGc = null;
    vi.unstubAllGlobals();
  });

  it('fetches, decrypts with the provided contentKey, and returns a blob URL', async () => {
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([10, 11, 12]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));

    const contentKey = new Uint8Array([99, 99]) as LegacyContentKey;
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptBlob(defaultParams({ contentKey })), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    expect(result.current.blobUrl).toBe('blob:decrypt-blob-mock-1');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('https://signed.example/img?sig=a');
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);
    expect(mockDecryptBinaryWithContentKey.mock.calls[0]![0]).toBe(contentKey);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('returns loading state when downloadUrl is null', () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob({
          contentItemId: 'pending-url',
          downloadUrl: null,
          contentKey: new Uint8Array([1]) as LegacyContentKey,
          mimeType: 'image/png',
        }),
      { wrapper }
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.blobUrl).toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns loading state when contentKey is null', () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob({
          contentItemId: 'pending-key',
          downloadUrl: 'https://signed.example/x',
          contentKey: null,
          mimeType: 'image/png',
        }),
      { wrapper }
    );

    expect(result.current.isLoading).toBe(true);
    expect(result.current.blobUrl).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('exposes an error when fetch returns a non-ok status', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array(), false, 403));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptBlob(defaultParams()), { wrapper });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toContain('Media fetch failed');
    expect(result.current.error?.message).toContain('403');
    expect(mockDecryptBinaryWithContentKey).not.toHaveBeenCalled();
  });

  it('exposes an error when decryption throws', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1, 2])));
    mockDecryptBinaryWithContentKey.mockImplementation(() => {
      throw new Error('AEAD tag mismatch');
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptBlob(defaultParams()), { wrapper });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toBe('AEAD tag mismatch');
    expect(result.current.blobUrl).toBeNull();
  });

  it('revokes the blob URL when the query cache evicts the entry', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    const { wrapper, queryClient } = makeWrapper();
    const params = defaultParams({ contentItemId: 'evict-me' });
    const { result, unmount } = renderHook(() => useDecryptBlob(params), { wrapper });

    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:decrypt-blob-mock-1');
    });

    unmount();

    // Unmount alone must not revoke — the cache still holds the URL so a
    // future remount can reuse it. This is the contract that fixes the
    // Virtuoso scroll thrash.
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();

    // Cache eviction is what revokes. The GC subscriber installed in the
    // wrapper turns a `removed` event into `URL.revokeObjectURL`.
    queryClient
      .getQueryCache()
      .remove(queryClient.getQueryCache().find({ queryKey: blobCacheKeys.blob('evict-me') })!);

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:decrypt-blob-mock-1');
  });

  it('does not refetch when remounted with the same contentItemId (Virtuoso unmount/remount)', async () => {
    // Virtuoso virtualizes off-screen rows: unmount the MediaContentItem,
    // remount when it comes back into view. The cache must be keyed by
    // contentItemId and survive unmount — otherwise blob URLs churn on
    // every scroll cycle (see the iPhone-15 e2e logs where `bc6ab455`
    // cycled through 4 distinct blob URLs in one test run).
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    const { wrapper } = makeWrapper();
    const params = defaultParams({ contentItemId: 'shared-item' });
    const { result, unmount } = renderHook(() => useDecryptBlob(params), { wrapper });

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    unmount();

    const remount = renderHook(() => useDecryptBlob(params), { wrapper });

    // The blob URL must surface immediately from cache — no fresh fetch.
    expect(remount.result.current.blobUrl).toBe('blob:decrypt-blob-mock-1');
    expect(remount.result.current.isLoading).toBe(false);

    // Give the effect/microtask queue a chance to fire a stray fetch.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries a transient fetch HTTP error (403) and recovers without caching the failure', async () => {
    // A presigned R2 URL can 403 transiently (clock skew, just-expired URL).
    // The fetch must be retried — not cached as a permanent failure for the
    // whole gcTime window (DF7).
    mockFetch
      .mockResolvedValueOnce(createFetchResponse(new Uint8Array(), false, 403))
      .mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptBlob(defaultParams({ contentItemId: 'flaky' })), {
      wrapper,
    });

    await waitFor(
      () => {
        expect(result.current.blobUrl).not.toBeNull();
      },
      { timeout: 2000 }
    );

    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);
  });

  it('retries a transient network error (fetch rejects) and recovers', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(createFetchResponse(new Uint8Array([1, 2])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([3, 4]));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () => useDecryptBlob(defaultParams({ contentItemId: 'net-flaky' })),
      { wrapper }
    );

    await waitFor(
      () => {
        expect(result.current.blobUrl).not.toBeNull();
      },
      { timeout: 2000 }
    );

    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not re-decrypt once a successful decrypt is cached, even on remount', async () => {
    // The deterministic decrypt result must stay cached: fetch + decrypt run
    // exactly once across an unmount/remount cycle (DF7 — separating the
    // retryable fetch from the cached decrypt must not break the cache).
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    const { wrapper } = makeWrapper();
    const params = defaultParams({ contentItemId: 'cached-decrypt' });
    const { result, unmount } = renderHook(() => useDecryptBlob(params), { wrapper });

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);

    unmount();

    const remount = renderHook(() => useDecryptBlob(params), { wrapper });
    expect(remount.result.current.blobUrl).not.toBeNull();
    expect(remount.result.current.isLoading).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);
  });

  it('decrypts via the location-bound envelope when one is supplied, ignoring the legacy key', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1, 2, 3])));
    mockDecryptContentEnvelope.mockReturnValue(new Uint8Array([42]));

    const contentKey = new Uint8Array([7, 7, 7]) as ContentKey;
    const wrappedContentKey = new Uint8Array([8, 8, 8]) as WrappedSecret;
    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob(
          defaultParams({
            contentItemId: 'envelope-item',
            // A non-null legacy key that MUST be ignored in favor of the envelope.
            contentKey: new Uint8Array([9, 9, 9]) as LegacyContentKey,
            envelope: { contentKey, wrappedContentKey, location: sampleLocation },
          })
        ),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    expect(mockDecryptContentEnvelope).toHaveBeenCalledTimes(1);
    expect(mockDecryptContentEnvelope.mock.calls[0]![0]).toBe(contentKey);
    expect(mockDecryptContentEnvelope.mock.calls[0]![1]).toBe(wrappedContentKey);
    expect(mockDecryptContentEnvelope.mock.calls[0]![2]).toEqual(sampleLocation);
    expect(mockDecryptBinaryWithContentKey).not.toHaveBeenCalled();
  });

  it('fetches with the envelope decryptor even when the legacy contentKey is null', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1])));
    mockDecryptContentEnvelope.mockReturnValue(new Uint8Array([5]));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob({
          contentItemId: 'envelope-only',
          downloadUrl: 'https://signed.example/x',
          contentKey: null,
          envelope: {
            contentKey: new Uint8Array([1]) as ContentKey,
            wrappedContentKey: new Uint8Array([2]) as WrappedSecret,
            location: sampleLocation,
          },
          mimeType: 'image/png',
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('creates the Blob with the provided mimeType', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([1, 2, 3])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([4, 5, 6]));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptBlob(defaultParams({ mimeType: 'video/mp4' })), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    const blob = mockCreateObjectURL.mock.calls[0]![0];
    expect(blob.type).toBe('video/mp4');
  });

  it('rejects an over-ceiling item before fetch with a clear error', () => {
    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob(
          defaultParams({
            contentItemId: 'too-big',
            sizeBytes: MAX_MEDIA_OBJECT_BYTES + 1,
          })
        ),
      { wrapper }
    );

    expect(result.current.error).not.toBeNull();
    expect(result.current.error?.message).toContain(String(MAX_MEDIA_OBJECT_BYTES));
    expect(result.current.blobUrl).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockDecryptBinaryWithContentKey).not.toHaveBeenCalled();
  });

  it('decrypts normally when sizeBytes is exactly at the ceiling', async () => {
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9]));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob(
          defaultParams({
            contentItemId: 'within-cap',
            sizeBytes: MAX_MEDIA_OBJECT_BYTES,
          })
        ),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
