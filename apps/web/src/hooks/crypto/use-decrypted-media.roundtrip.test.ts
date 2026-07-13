import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import {
  generateEpochKeyPair,
  generateContentKey,
  wrapContentKeyToEpoch,
  encryptContentEnvelope,
  type ContentKey,
  type ContentLocation,
  type WrappedSecret,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { useDecryptBlob } from '@/hooks/crypto/use-decrypt-blob';
import { useMessageContentKey } from '@/hooks/crypto/use-decrypted-media';
import { installBlobUrlCacheGc } from '@/lib/blob-url-cache-gc';
import { clearEpochKeyCache, setEpochKey } from '@/lib/epoch-key-cache';
import type React from 'react';

/**
 * End-to-end proof that MEDIA bytes written EXACTLY as the backend writes them
 * (fresh content key → `wrapContentKeyToEpoch` → `encryptContentEnvelope` over
 * the raw media bytes with the full location AAD — see `createDevMediaConversation`)
 * decrypt to the original bytes through the migrated media hooks. Uses real
 * `@hushbox/crypto` (only network + blob-URL globals are stubbed) so the
 * location-binding AAD is exercised for real, not against a mock.
 */

const CONVERSATION_ID = 'conv-media-rt';
const MESSAGE_ID = 'msg-media-rt';
const CONTENT_ITEM_ID = 'ci-media-rt';
const EPOCH_NUMBER = 1;
const SENDER_ID = 'sender-media-rt';

let capturedBlobs: Blob[] = [];
let detachGc: (() => void) | null = null;

function makeWrapper(): {
  wrapper: ({ children }: { children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  detachGc = installBlobUrlCacheGc(queryClient);
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'MediaRoundTripWrapper';
  return { wrapper: Wrapper };
}

interface SeededMedia {
  wrappedContentKeyB64: string;
  wrappedContentKey: WrappedSecret;
  contentKey: ContentKey;
  ciphertext: Uint8Array;
}

/**
 * Encode `bytes` as the backend media writer does and seed the epoch private
 * key into the cache. Returns the pieces the hooks consume so a caller can
 * decrypt under whichever location it chooses — a mismatch proves the AAD
 * location binding is enforced.
 */
function seedMediaEnvelope(bytes: Uint8Array): SeededMedia {
  const epoch = generateEpochKeyPair();
  const contentKey = generateContentKey();
  const wrapped = wrapContentKeyToEpoch(epoch.publicKey, contentKey);
  const ciphertext = encryptContentEnvelope(
    contentKey,
    wrapped,
    {
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      contentItemId: CONTENT_ITEM_ID,
      position: 0,
      epochNumber: EPOCH_NUMBER,
      senderId: SENDER_ID,
    },
    bytes
  );
  setEpochKey(CONVERSATION_ID, EPOCH_NUMBER, epoch.privateKey);
  return {
    wrappedContentKeyB64: toBase64(wrapped),
    wrappedContentKey: wrapped,
    contentKey,
    ciphertext,
  };
}

function createFetchResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  } as Response;
}

function stubFetch(bytes: Uint8Array): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(createFetchResponse(bytes)))
  );
}

const CORRECT_LOCATION: ContentLocation = {
  conversationId: CONVERSATION_ID,
  messageId: MESSAGE_ID,
  contentItemId: CONTENT_ITEM_ID,
  position: 0,
  epochNumber: EPOCH_NUMBER,
  senderId: SENDER_ID,
};

describe('media hooks — real content-envelope round-trip', () => {
  beforeEach(() => {
    clearEpochKeyCache();
    capturedBlobs = [];
    let counter = 0;
    vi.stubGlobal('URL', {
      ...globalThis.URL,
      createObjectURL: (blob: Blob): string => {
        capturedBlobs.push(blob);
        counter += 1;
        return `blob:media-rt-${String(counter)}`;
      },
      revokeObjectURL: (): void => {},
    });
  });

  afterEach(() => {
    detachGc?.();
    detachGc = null;
    vi.unstubAllGlobals();
  });

  it('unwraps the message content key from the epoch and decrypts backend media bytes', async () => {
    const plaintext = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const seeded = seedMediaEnvelope(plaintext);
    stubFetch(seeded.ciphertext);

    const { wrapper } = makeWrapper();

    // The message-level unwrap the migrated `useMessageContentKey` performs.
    const keyHook = renderHook(
      () => useMessageContentKey(CONVERSATION_ID, EPOCH_NUMBER, seeded.wrappedContentKeyB64),
      { wrapper }
    );
    expect(keyHook.result.current.error).toBeNull();
    const contentKey = keyHook.result.current.contentKey;
    const wrappedContentKey = keyHook.result.current.wrappedContentKey;
    expect(contentKey).not.toBeNull();
    expect(wrappedContentKey).not.toBeNull();

    const { result } = renderHook(
      () =>
        useDecryptBlob({
          contentItemId: CONTENT_ITEM_ID,
          downloadUrl: 'https://r2.example/media',
          contentKey: null,
          envelope: {
            contentKey: contentKey!,
            wrappedContentKey: wrappedContentKey!,
            location: CORRECT_LOCATION,
          },
          mimeType: 'image/png',
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.blobUrl).not.toBeNull();
    });
    expect(result.current.error).toBeNull();

    const decrypted = new Uint8Array(await capturedBlobs[0]!.arrayBuffer());
    expect(decrypted).toEqual(plaintext);
  });

  it('fails to decrypt when the ContentLocation contentItemId is wrong (location binding enforced)', async () => {
    const seeded = seedMediaEnvelope(new Uint8Array([9, 8, 7]));
    stubFetch(seeded.ciphertext);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob({
          contentItemId: 'ci-wrong',
          downloadUrl: 'https://r2.example/media',
          contentKey: null,
          envelope: {
            contentKey: seeded.contentKey,
            wrappedContentKey: seeded.wrappedContentKey,
            location: { ...CORRECT_LOCATION, contentItemId: 'ci-tampered' },
          },
          mimeType: 'image/png',
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.blobUrl).toBeNull();
    expect(capturedBlobs).toHaveLength(0);
  });

  it('fails to decrypt when the ContentLocation position is wrong (location binding enforced)', async () => {
    const seeded = seedMediaEnvelope(new Uint8Array([4, 4, 4]));
    stubFetch(seeded.ciphertext);

    const { wrapper } = makeWrapper();
    const { result } = renderHook(
      () =>
        useDecryptBlob({
          contentItemId: 'ci-wrong-pos',
          downloadUrl: 'https://r2.example/media',
          contentKey: null,
          envelope: {
            contentKey: seeded.contentKey,
            wrappedContentKey: seeded.wrappedContentKey,
            location: { ...CORRECT_LOCATION, position: 7 },
          },
          mimeType: 'image/png',
        }),
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.blobUrl).toBeNull();
    expect(capturedBlobs).toHaveLength(0);
  });
});
