import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      shared: {
        message: {
          [':shareId']: {
            $get: vi.fn(() => Promise.resolve(new Response())),
          },
        },
      },
    },
    media: {
      shared: {
        [':shareId']: {
          [':contentItemId']: {
            'download-url': {
              $get: vi.fn(() => Promise.resolve(new Response())),
            },
          },
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { client, fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);
const mockPresignGet = vi.mocked(
  client.media.shared[':shareId'][':contentItemId']['download-url'].$get
);

const mockOpenShare = vi.fn<(secret: Uint8Array, wrapped: Uint8Array) => Uint8Array>();
const mockDecryptTextWithContentKey =
  vi.fn<(contentKey: Uint8Array, ciphertext: Uint8Array) => string>();
const mockFromBase64 = vi.fn<(b64: string) => Uint8Array>();

vi.mock('@hushbox/crypto', () => ({
  openShare: (secret: Uint8Array, wrapped: Uint8Array) => mockOpenShare(secret, wrapped),
  decryptTextWithContentKey: (contentKey: Uint8Array, ciphertext: Uint8Array) =>
    mockDecryptTextWithContentKey(contentKey, ciphertext),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: (b64: string) => mockFromBase64(b64),
  };
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

interface ShareItem {
  id: string;
  position: number;
  contentType: 'text' | 'image' | 'audio' | 'video';
  mimeType?: string | null;
  byteLength?: number | null;
  encryptedBlob?: string | null;
}

interface SharePayloadOverrides {
  shareId?: string;
  wrappedContentKey?: string;
  contentItems?: ShareItem[];
  createdAt?: string;
}

/** The standalone share-id public read (`sharedMessageViewSchema`) — a flat single message. */
function sharePayload(overrides: SharePayloadOverrides = {}): Record<string, unknown> {
  return {
    shareId: overrides.shareId ?? 'share-abc',
    messageId: 'msg-id',
    wrappedContentKey: overrides.wrappedContentKey ?? 'wrapped-content-key-b64',
    createdAt: overrides.createdAt ?? '2026-01-15T10:00:00Z',
    contentItems: overrides.contentItems ?? [
      {
        id: 'ci-1',
        position: 0,
        contentType: 'text',
        mimeType: null,
        byteLength: null,
        encryptedBlob: 'ciphertext-b64',
      },
    ],
  };
}

describe('useSharedMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFromBase64.mockImplementation((b64) => new TextEncoder().encode(b64));
    mockOpenShare.mockImplementation((_secret, wrapped) => wrapped);
    mockDecryptTextWithContentKey.mockReturnValue('');
  });

  it('is disabled when shareId is null', async () => {
    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    renderHook(() => useSharedMessage(null, 'some-key'), { wrapper: createWrapper() });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('is disabled when keyBase64 is null', async () => {
    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    renderHook(() => useSharedMessage('share-123', null), { wrapper: createWrapper() });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('reads the standalone share by share id', async () => {
    mockFetchJson.mockResolvedValue(sharePayload());
    mockDecryptTextWithContentKey.mockReturnValue('hello');

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-abc', 'key-b64'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockPresignGet).not.toHaveBeenCalled();
    expect(client.conversations.shared.message[':shareId'].$get).toHaveBeenCalledWith({
      param: { shareId: 'share-abc' },
    });
  });

  it('decrypts each text content item into a structured text entry in position order', async () => {
    const shareSecret = new Uint8Array([1, 1]);
    const contentKey = new Uint8Array([2, 2]);

    mockFromBase64.mockImplementation((b64) => {
      if (b64 === 'the-key') return shareSecret;
      return new TextEncoder().encode(b64);
    });
    mockOpenShare.mockReturnValue(contentKey);
    // Hook sorts by position BEFORE decrypting, so the mock is called in
    // position order (0, 1, 2) regardless of input order.
    mockDecryptTextWithContentKey
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('second')
      .mockReturnValueOnce('third');

    mockFetchJson.mockResolvedValue(
      sharePayload({
        wrappedContentKey: 'wrapped-b64',
        contentItems: [
          { id: 'ci-1', contentType: 'text', position: 0, encryptedBlob: 'blob-1' },
          { id: 'ci-3', contentType: 'text', position: 2, encryptedBlob: 'blob-3' },
          { id: 'ci-2', contentType: 'text', position: 1, encryptedBlob: 'blob-2' },
        ],
        createdAt: '2026-02-01T00:00:00Z',
      })
    );

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-1', 'the-key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockOpenShare).toHaveBeenCalledTimes(1);
    const [openSecret] = mockOpenShare.mock.calls[0] as [Uint8Array, Uint8Array];
    expect(openSecret).toBe(shareSecret);

    expect(mockDecryptTextWithContentKey).toHaveBeenCalledTimes(3);
    const firstCallKey = mockDecryptTextWithContentKey.mock.calls[0]![0];
    expect(firstCallKey).toBe(contentKey);

    expect(result.current.data?.createdAt).toBe('2026-02-01T00:00:00Z');
    expect(result.current.data?.contentItems).toEqual([
      { type: 'text', position: 0, content: 'first' },
      { type: 'text', position: 1, content: 'second' },
      { type: 'text', position: 2, content: 'third' },
    ]);
    expect(result.current.data?.contentKey).toBe(contentKey);
  });

  it('presigns each media content item into a media entry carrying a download URL', async () => {
    mockOpenShare.mockReturnValue(new Uint8Array([7]));
    mockDecryptTextWithContentKey.mockReturnValue('t');

    // First fetchJson resolves the share read; the second resolves the media
    // presign mint for the one media item.
    mockFetchJson
      .mockResolvedValueOnce(
        sharePayload({
          shareId: 'share-media',
          contentItems: [
            { id: 'ci-text', contentType: 'text', position: 0, encryptedBlob: 'blob' },
            {
              id: 'ci-img',
              contentType: 'image',
              position: 1,
              mimeType: 'image/png',
              byteLength: 2048,
              encryptedBlob: null,
            },
          ],
        })
      )
      .mockResolvedValueOnce({
        downloadUrl: 'https://r2.example/ci-img?sig=abc',
        expiresAt: '2026-02-01T01:00:00Z',
      });

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-media', 'key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockPresignGet).toHaveBeenCalledWith({
      param: { shareId: 'share-media', contentItemId: 'ci-img' },
    });

    expect(result.current.data?.contentItems).toHaveLength(2);
    const media = result.current.data?.contentItems.find((item) => item.type === 'media');
    expect(media).toMatchObject({
      type: 'media',
      position: 1,
      contentItemId: 'ci-img',
      contentType: 'image',
      mimeType: 'image/png',
      downloadUrl: 'https://r2.example/ci-img?sig=abc',
      expiresAt: '2026-02-01T01:00:00Z',
    });
  });

  it('skips a text content item whose encrypted blob is missing', async () => {
    mockOpenShare.mockReturnValue(new Uint8Array([7]));
    mockDecryptTextWithContentKey.mockReturnValue('kept');

    mockFetchJson.mockResolvedValue(
      sharePayload({
        contentItems: [
          { id: 'ci-good', contentType: 'text', position: 0, encryptedBlob: 'blob' },
          { id: 'ci-empty', contentType: 'text', position: 1, encryptedBlob: null },
        ],
      })
    );

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-x', 'key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // The blob-less text item builds to null and is filtered out.
    expect(result.current.data?.contentItems).toEqual([
      { type: 'text', position: 0, content: 'kept' },
    ]);
  });

  it('defaults missing media mimeType and byteLength to empty string and zero', async () => {
    mockOpenShare.mockReturnValue(new Uint8Array([7]));

    mockFetchJson
      .mockResolvedValueOnce(
        sharePayload({
          shareId: 'share-media2',
          contentItems: [
            {
              id: 'ci-img2',
              contentType: 'image',
              position: 0,
              mimeType: null,
              byteLength: null,
              encryptedBlob: null,
            },
          ],
        })
      )
      .mockResolvedValueOnce({
        downloadUrl: 'https://r2.example/ci-img2',
        expiresAt: '2026-02-01T01:00:00Z',
      });

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-media2', 'key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const media = result.current.data?.contentItems.find((item) => item.type === 'media');
    expect(media).toMatchObject({ type: 'media', mimeType: '', sizeBytes: 0 });
  });

  it('propagates errors from fetchJson', async () => {
    mockFetchJson.mockRejectedValue(new Error('Not found'));

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-bad', 'key-bad'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error!.message).toBe('Not found');
  });

  it('propagates errors from openShare when the share secret is wrong', async () => {
    mockFetchJson.mockResolvedValue(sharePayload());
    mockOpenShare.mockImplementation(() => {
      throw new Error('Decryption failed');
    });

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-corrupt', 'wrong-key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error!.message).toBe('Decryption failed');
  });
});
