import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useDecryptedMedia, useMessageContentKey } from '@/hooks/crypto/use-decrypted-media';
import { blobCacheKeys } from '@/hooks/crypto/use-decrypt-blob';
import { installBlobUrlCacheGc } from '@/lib/blob-url-cache-gc';
import type { LegacyContentKey } from '@hushbox/crypto';

const mockUseMediaDownloadUrl = vi.fn<
  (contentItemId: string | null) => {
    downloadUrl: string | undefined;
    isLoading: boolean;
    error: Error | null;
  }
>();

vi.mock('@/hooks/crypto/use-media-url', () => ({
  useMediaDownloadUrl: (contentItemId: string | null) => mockUseMediaDownloadUrl(contentItemId),
}));

const mockGetEpochKey =
  vi.fn<(conversationId: string, epochNumber: number) => Uint8Array | undefined>();

vi.mock('@/lib/epoch-key-cache', () => ({
  getEpochKey: (conversationId: string, epochNumber: number) =>
    mockGetEpochKey(conversationId, epochNumber),
}));

const mockOpenMessageEnvelope =
  vi.fn<(epochPrivateKey: Uint8Array, wrappedContentKey: Uint8Array) => Uint8Array>();
const mockDecryptBinaryWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  openMessageEnvelope: (...args: [Uint8Array, Uint8Array]) => mockOpenMessageEnvelope(...args),
  decryptBinaryWithContentKey: (...args: [Uint8Array, Uint8Array]) =>
    mockDecryptBinaryWithContentKey(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => new TextEncoder().encode(b64),
  };
});

const mockCreateObjectURL = vi.fn<(blob: Blob) => string>();
const mockRevokeObjectURL = vi.fn<(url: string) => void>();

const mockFetch = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();

function defaultParams(
  overrides: Partial<Parameters<typeof useDecryptedMedia>[0]> = {}
): Parameters<typeof useDecryptedMedia>[0] {
  return {
    contentItemId: 'content-item-1',
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

describe('useDecryptedMedia', () => {
  let urlCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    urlCounter = 0;
    mockCreateObjectURL.mockImplementation(() => {
      urlCounter += 1;
      return `blob:mock-${String(urlCounter)}`;
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

  it('happy path: fetches, decrypts, and returns a blob URL', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptedMedia(defaultParams()), { wrapper });

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });

    expect(result.current.blobUrl).toBe('blob:mock-1');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('https://r2.example.com/encrypted-bytes');
    expect(mockOpenMessageEnvelope).not.toHaveBeenCalled();
    expect(mockDecryptBinaryWithContentKey).toHaveBeenCalledTimes(1);
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1);
  });

  it('forwards urlLoading as isLoading while the presigned URL is fetching', () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: undefined,
      isLoading: true,
      error: null,
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptedMedia(defaultParams()), { wrapper });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.blobUrl).toBeNull();
  });

  it('surfaces urlError from useMediaDownloadUrl', () => {
    const error = new Error('presigned url failed');
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: undefined,
      isLoading: false,
      error,
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptedMedia(defaultParams()), { wrapper });

    expect(result.current.error).toBe(error);
    expect(result.current.blobUrl).toBeNull();
  });

  it('a null contentKey alone is "still resolving": no error, no fetch, no perpetual spinner downstream (H11)', () => {
    // The hook cannot tell "parent still resolving the key" from "key
    // permanently unavailable" — both arrive as contentKey=null. So the hook
    // stays quiet (no error, no fetch) and does NOT itself fabricate a loading
    // state from a missing key. The undecryptable→error decision is made one
    // layer up in MediaContentItem via `contentKeyError`, which is where the
    // permanent-spinner bug (H11) is actually fixed.
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/x',
      isLoading: false,
      error: null,
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptedMedia(defaultParams({ contentKey: null })), {
      wrapper,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.blobUrl).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('error path: fetch returns non-ok status', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array(), false, 403));

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptedMedia(defaultParams()), { wrapper });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toContain('Media fetch failed');
    expect(result.current.error?.message).toContain('403');
    expect(mockDecryptBinaryWithContentKey).not.toHaveBeenCalled();
  });

  it('error path: decryption throws', async () => {
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));
    mockDecryptBinaryWithContentKey.mockImplementation(() => {
      throw new Error('AEAD tag mismatch');
    });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDecryptedMedia(defaultParams()), { wrapper });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error?.message).toBe('AEAD tag mismatch');
    expect(result.current.blobUrl).toBeNull();
  });

  it('revokes the blob URL when the query cache evicts the entry', async () => {
    // Updated from the old "revoke on unmount" contract: blob URLs now
    // outlive component unmount via the React Query cache (so a Virtuoso
    // remount can reuse them). Revocation is deferred to cache eviction.
    mockUseMediaDownloadUrl.mockReturnValue({
      downloadUrl: 'https://r2.example.com/encrypted-bytes',
      isLoading: false,
      error: null,
    });
    mockDecryptBinaryWithContentKey.mockReturnValue(new Uint8Array([9, 9, 9]));
    mockFetch.mockResolvedValue(createFetchResponse(new Uint8Array([7, 8])));

    const { wrapper, queryClient } = makeWrapper();
    const { result, unmount } = renderHook(() => useDecryptedMedia(defaultParams()), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.blobUrl).toBe('blob:mock-1');
    });

    unmount();
    expect(mockRevokeObjectURL).not.toHaveBeenCalled();

    queryClient
      .getQueryCache()
      .remove(
        queryClient.getQueryCache().find({ queryKey: blobCacheKeys.blob('content-item-1') })!
      );

    expect(mockRevokeObjectURL).toHaveBeenCalledWith('blob:mock-1');
  });
});

describe('useMessageContentKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('unwraps the content key once when epoch key is available', () => {
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([4, 5, 6]));

    const { result } = renderHook(() =>
      useMessageContentKey('conv-1', 1, 'wrapped-content-key-b64')
    );

    expect(result.current.contentKey).not.toBeNull();
    expect(result.current.error).toBeNull();
    expect(mockOpenMessageEnvelope).toHaveBeenCalledTimes(1);
  });

  it('returns an error when the epoch key is missing', () => {
    mockGetEpochKey.mockReset();

    const { result } = renderHook(() =>
      useMessageContentKey('conv-1', 1, 'wrapped-content-key-b64')
    );

    expect(result.current.contentKey).toBeNull();
    expect(result.current.error?.message).toContain('Epoch key not available');
  });

  it('returns an error when openMessageEnvelope throws', () => {
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockImplementation(() => {
      throw new Error('ECIES open failed');
    });

    const { result } = renderHook(() =>
      useMessageContentKey('conv-1', 1, 'wrapped-content-key-b64')
    );

    expect(result.current.contentKey).toBeNull();
    expect(result.current.error?.message).toBe('ECIES open failed');
  });

  it('memoizes by inputs — does not re-unwrap on rerender with same inputs', () => {
    mockGetEpochKey.mockReturnValue(new Uint8Array([1, 2, 3]));
    mockOpenMessageEnvelope.mockReturnValue(new Uint8Array([4, 5, 6]));

    const { rerender } = renderHook(
      (props: { conv: string; epoch: number; wrapped: string }) =>
        useMessageContentKey(props.conv, props.epoch, props.wrapped),
      { initialProps: { conv: 'conv-1', epoch: 1, wrapped: 'wrapped-b64' } }
    );

    rerender({ conv: 'conv-1', epoch: 1, wrapped: 'wrapped-b64' });
    rerender({ conv: 'conv-1', epoch: 1, wrapped: 'wrapped-b64' });

    expect(mockOpenMessageEnvelope).toHaveBeenCalledTimes(1);
  });
});
