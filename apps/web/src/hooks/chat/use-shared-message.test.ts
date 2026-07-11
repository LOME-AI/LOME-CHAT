import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      shared: {
        [':linkId']: {
          $get: vi.fn(() => Promise.resolve(new Response())),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';

const mockFetchJson = vi.mocked(fetchJson);

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
  wrappedContentKey?: string;
  contentItems?: ShareItem[];
  createdAt?: string;
  sharedMessages?: unknown[];
}

/** The rebuilt link-scoped public read (`publicShareViewSchema`). */
function sharePayload(overrides: SharePayloadOverrides = {}): Record<string, unknown> {
  return {
    displayName: null,
    sharedMessages: overrides.sharedMessages ?? [
      {
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

  it('calls fetchJson with the correct linkId param', async () => {
    mockFetchJson.mockResolvedValue(sharePayload());
    mockDecryptTextWithContentKey.mockReturnValue('hello');

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-abc', 'key-b64'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const { client } = await import('@/lib/api-client');
    expect(client.conversations.shared[':linkId'].$get).toHaveBeenCalledWith({
      param: { linkId: 'share-abc' },
    });
  });

  it('errors when the link has no shared messages', async () => {
    mockFetchJson.mockResolvedValue({ displayName: null, sharedMessages: [] });

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-empty', 'key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error!.message).toBe('Share link has no shared messages');
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

  // The rebuilt read carries no inline presigned URL; media items are skipped
  // until the UI-alignment task wires the per-item presign mint.
  it('skips media items and keeps text items', async () => {
    mockOpenShare.mockReturnValue(new Uint8Array([7]));
    mockDecryptTextWithContentKey.mockReturnValue('t');

    mockFetchJson.mockResolvedValue(
      sharePayload({
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
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { useSharedMessage } = await import('@/hooks/chat/use-shared-message.js');
    const { result } = renderHook(() => useSharedMessage('share-3', 'key'), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.contentItems).toHaveLength(1);
    expect(result.current.data?.contentItems[0]!.type).toBe('text');
    expect(warnSpy).toHaveBeenCalledWith(
      'Skipping shared media item (presign mint not wired)',
      expect.objectContaining({ id: 'ci-img' })
    );

    warnSpy.mockRestore();
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
