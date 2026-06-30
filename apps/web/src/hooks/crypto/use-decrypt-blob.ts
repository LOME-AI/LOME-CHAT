import { useQuery } from '@tanstack/react-query';
import { decryptBinaryWithContentKey, type LegacyContentKey } from '@hushbox/crypto';
import { blobCacheKeys } from '@/lib/query-keys/blob-cache-keys';

export { blobCacheKeys } from '@/lib/query-keys/blob-cache-keys';

interface UseDecryptBlobParams {
  /** Stable cache key. Same id across mount/unmount/remount reuses the decrypted blob URL. */
  contentItemId: string;
  /** Presigned GET URL for the encrypted ciphertext. Null means "not ready yet". */
  downloadUrl: string | null;
  /** Already-unwrapped content key. Null means "not ready yet". */
  contentKey: LegacyContentKey | null;
  /** MIME type used to build the output Blob. */
  mimeType: string;
}

interface DecryptBlobResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
}

/** 30 minutes — bytes are immutable; the cache survives a long scroll-back. */
const BLOB_CACHE_GC_MS = 30 * 60 * 1000;

/**
 * Bounded retries for the ciphertext fetch. A presigned R2 URL can fail
 * transiently — a just-expired or clock-skewed URL returns 403, a flaky
 * network rejects outright. Without retry such a transient failure was cached
 * for the whole `BLOB_CACHE_GC_MS` window with no recovery (DF7). The decrypt
 * step is deterministic and stays non-retrying.
 */
const FETCH_RETRY_COUNT = 3;
const FETCH_RETRY_DELAY_MS = 300;

/**
 * Turns (downloadUrl + contentKey + mimeType) into a revocable blob URL,
 * cached in the React Query store keyed by `contentItemId`.
 *
 * Why React Query: blob URLs must survive Virtuoso virtualization. When an
 * off-screen MediaContentItem unmounts, its useState/useEffect-based
 * predecessor revoked the URL and the remount re-fetched from R2 + re-
 * decrypted, churning a fresh blob URL on every scroll cycle (visible as
 * repeated blob:... URLs in the iPhone-15 e2e failure logs). The query
 * cache decouples blob-URL lifetime from component lifetime: the URL is
 * created once, every remount reads the cached value, and revocation is
 * deferred to query GC.
 *
 * Revocation is handled in `installBlobUrlCacheGc` (mounted once at app
 * root). That subscriber listens for query-cache `removed` events on the
 * `['media', 'blob', …]` namespace and calls URL.revokeObjectURL with the
 * evicted value. Keeps revocation out of every consumer's effect cleanup
 * and avoids leaks when a contentItem is finally evicted.
 */
export function useDecryptBlob(params: UseDecryptBlobParams): DecryptBlobResult {
  const { contentItemId, downloadUrl, contentKey, mimeType } = params;

  // Network fetch — retryable. A transient 403 (expired/skewed presigned URL)
  // or network blip must not be cached as a permanent failure (DF7). Keyed by
  // (contentItemId, downloadUrl) so a re-signed URL starts a fresh fetch.
  // Gated on the content key too so no bytes are fetched until the message is
  // decryptable (preserves the "no network until inputs ready" contract).
  const fetchEnabled = downloadUrl !== null && contentKey !== null;
  const {
    data: ciphertext,
    isLoading: fetchLoading,
    error: fetchError,
  } = useQuery({
    queryKey:
      downloadUrl === null
        ? ['media', 'fetch', 'noop']
        : blobCacheKeys.fetch(contentItemId, downloadUrl),
    queryFn: async (): Promise<Uint8Array> => {
      if (downloadUrl === null) {
        // `enabled` guards against this — branch exists for type narrowing.
        throw new Error('downloadUrl required');
      }
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Media fetch failed: ${String(response.status)}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    enabled: fetchEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_CACHE_GC_MS,
    retry: FETCH_RETRY_COUNT,
    retryDelay: FETCH_RETRY_DELAY_MS,
  });

  // Deterministic decrypt — NOT retryable, and cached under the `blob` key so
  // the resulting URL survives Virtuoso unmount/remount and is revoked by the
  // cache GC (see `installBlobUrlCacheGc`, which keys on `['media','blob',…]`).
  const decryptEnabled = ciphertext !== undefined && contentKey !== null;
  const {
    data: blobUrl,
    isLoading: decryptLoading,
    error: decryptError,
  } = useQuery({
    queryKey: blobCacheKeys.blob(contentItemId),
    queryFn: (): string => {
      if (ciphertext === undefined || contentKey === null) {
        // `enabled` guards against this — branch exists for type narrowing.
        throw new Error('ciphertext and contentKey required');
      }
      const plaintext = decryptBinaryWithContentKey(contentKey, ciphertext);
      const blob = new Blob([plaintext.buffer as ArrayBuffer], { type: mimeType });
      return URL.createObjectURL(blob);
    },
    enabled: decryptEnabled,
    // The blob URL is content-equivalent forever (until the document unloads).
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_CACHE_GC_MS,
    // Decryption is deterministic; a failure won't succeed on retry.
    retry: false,
  });

  return {
    blobUrl: blobUrl ?? null,
    // `isLoading: true` while inputs are resolving or either query is in
    // flight — preserves the pre-React-Query contract so consumers can keep
    // showing a loading placeholder uninterrupted across the
    // awaiting-inputs → fetching → decrypting transitions.
    isLoading: !fetchEnabled || fetchLoading || (decryptEnabled && decryptLoading),
    error: fetchError ?? decryptError ?? null,
  };
}
