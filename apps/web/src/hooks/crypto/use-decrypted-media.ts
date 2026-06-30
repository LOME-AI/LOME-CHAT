import { useMemo } from 'react';
import {
  openMessageEnvelope,
  type LegacyContentKey,
  type WrappedContentKey,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { getEpochKey } from '@/lib/epoch-key-cache';
import { useMediaDownloadUrl } from '@/hooks/crypto/use-media-url';
import { useDecryptBlob } from '@/hooks/crypto/use-decrypt-blob';

interface MessageContentKeyResult {
  contentKey: LegacyContentKey | null;
  error: Error | null;
}

/**
 * Resolve a message's content key ONCE per message: look up the epoch key from
 * the cache and ECIES-open the wrapped content key. Hoisted out of
 * `useDecryptedMedia` so an N-media message performs one unwrap, not N.
 * The message renderer (`MessageItem`) calls this and passes the
 * resulting `contentKey` down to each media item via the shared media list.
 */
export function useMessageContentKey(
  conversationId: string,
  epochNumber: number,
  wrappedContentKey: string
): MessageContentKeyResult {
  return useMemo(() => {
    try {
      const epochKey = getEpochKey(conversationId, epochNumber);
      if (!epochKey) {
        return { contentKey: null, error: new Error('Epoch key not available') };
      }
      const contentKey = openMessageEnvelope(
        epochKey,
        fromBase64(wrappedContentKey) as WrappedContentKey
      );
      return { contentKey, error: null };
    } catch (error) {
      return {
        contentKey: null,
        error: error instanceof Error ? error : new Error('Decryption failed'),
      };
    }
  }, [conversationId, epochNumber, wrappedContentKey]);
}

interface UseDecryptedMediaParams {
  contentItemId: string;
  /**
   * Pre-unwrapped message content key — resolved once at the message level
   * by the parent (`useMessageContentKey`) so an N-media message performs
   * one ECIES unwrap, not N. Pass `null` while the parent is
   * still resolving (fail-fast: a non-null key means the parent succeeded).
   */
  contentKey: LegacyContentKey | null;
  mimeType: string;
  /**
   * Pre-fetched presigned GET URL forwarded by the SSE `done` event. When
   * present, we skip the `/api/media/:id/download-url` round-trip — the URL
   * is already on the wire and valid for `MEDIA_DOWNLOAD_URL_TTL_SECONDS`.
   * Falls back to the query when the URL is absent (re-fetched messages) or
   * the in-flight URL has expired.
   */
  preFetchedUrl?: string | undefined;
}

interface DecryptedMediaResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Fetches a single media content item's encrypted bytes and decrypts them
 * using a pre-unwrapped message-level content key, producing a blob URL.
 *
 * The content key MUST be resolved once at the message level (see
 * `useMessageContentKey`) — an N-media message performs exactly one ECIES
 * unwrap, not N.
 *
 * Composes two pieces:
 *   useMediaDownloadUrl  — fetches the presigned R2 URL
 *   useDecryptBlob       — fetches ciphertext + symmetric decrypt + blob URL
 */
export function useDecryptedMedia(params: UseDecryptedMediaParams): DecryptedMediaResult {
  const { contentItemId, contentKey, mimeType, preFetchedUrl } = params;
  // Skip the network round-trip when the SSE done event already gave us a URL.
  // `useMediaDownloadUrl` keys its query on the contentItemId, so passing
  // `null` disables it for the lifetime of this consumer.
  const queryEnabled = preFetchedUrl === undefined;
  const {
    downloadUrl: queriedUrl,
    error: urlError,
    isLoading: urlLoading,
  } = useMediaDownloadUrl(queryEnabled ? contentItemId : null);

  const effectiveUrl = preFetchedUrl ?? queriedUrl;

  const {
    blobUrl,
    isLoading: decryptLoading,
    error: decryptError,
  } = useDecryptBlob({
    contentItemId,
    downloadUrl: effectiveUrl ?? null,
    contentKey,
    mimeType,
  });

  return {
    blobUrl,
    // Hide "awaiting inputs" loading once the URL has resolved and the
    // contentKey is missing — the parent's error path should surface
    // immediately, not sit behind a spinner.
    isLoading: (queryEnabled && urlLoading) || (contentKey !== null && decryptLoading),
    error: urlError ?? decryptError,
  };
}
