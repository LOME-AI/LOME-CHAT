import { useQuery } from '@tanstack/react-query';
import {
  openShare,
  decryptTextWithContentKey,
  type LegacyContentKey,
  type WrappedContentKey,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';

export const sharedMessageKeys = {
  all: ['shared-message'] as const,
  detail: (shareId: string | null) => [...sharedMessageKeys.all, shareId] as const,
};

/**
 * One item of the standalone share-id read (`contentItemViewSchema` on the
 * conversations slice). Media items carry `encryptedBlob: null` and are fetched
 * by presigning `id` (the content-item id) against the share row — a separate
 * per-item mint on the media slice.
 */
interface SharedItemView {
  id: string;
  position: number;
  contentType: 'text' | 'image' | 'audio' | 'video';
  mimeType: string | null;
  byteLength: number | null;
  encryptedBlob: string | null;
}

/** `sharedMessageViewSchema` — the flat, single-message standalone share read. */
interface SharedMessageView {
  shareId: string;
  messageId: string;
  wrappedContentKey: string;
  createdAt: string;
  contentItems: SharedItemView[];
}

/** The `{ downloadUrl, expiresAt }` grant a media presign mint returns. */
interface DownloadUrlGrant {
  downloadUrl: string;
  expiresAt: string;
}

/**
 * One content item returned by `useSharedMessage`. Text items carry their
 * already-decrypted plaintext; media items carry a presigned GET URL plus
 * metadata. Consumers decrypt media bytes separately using the exposed
 * `contentKey` (which is the same across every item in the message).
 */
export type SharedContentItem =
  | {
      type: 'text';
      position: number;
      content: string;
    }
  | {
      type: 'media';
      position: number;
      contentItemId: string;
      contentType: 'image' | 'audio' | 'video';
      mimeType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      /** Short-lived presigned R2 GET URL. */
      downloadUrl: string;
      /** ISO-8601 expiry of `downloadUrl`. */
      expiresAt: string;
    };

export interface SharedMessageData {
  createdAt: string;
  /**
   * Unwrapped content key for the shared message. Reused across every content
   * item — text items are already decrypted; media consumers pass this key to
   * the media-decrypt hook after fetching the ciphertext from `downloadUrl`.
   * Held in React Query state for the page lifetime; view is read-only and
   * ephemeral, same risk profile as the epoch-key cache on the member side.
   */
  contentKey: LegacyContentKey;
  contentItems: SharedContentItem[];
}

async function buildSharedContentItem(
  item: SharedItemView,
  contentKey: LegacyContentKey,
  shareId: string
): Promise<SharedContentItem | null> {
  if (item.contentType === 'text') {
    if (item.encryptedBlob == null) return null;
    const content = decryptTextWithContentKey(contentKey, fromBase64(item.encryptedBlob));
    return { type: 'text', position: item.position, content };
  }
  // Media item — the standalone read carries no inline presigned URL, so mint
  // one per item against the share row: `GET /media/shared/:shareId/:contentItemId/download-url`
  // is unauthenticated by design (a valid shareId is the capability) and scoped
  // to exactly this share's content items server-side.
  const grant = await fetchJson<DownloadUrlGrant>(
    client.media.shared[':shareId'][':contentItemId']['download-url'].$get({
      param: { shareId, contentItemId: item.id },
    })
  );
  return {
    type: 'media',
    position: item.position,
    contentItemId: item.id,
    contentType: item.contentType,
    mimeType: item.mimeType ?? '',
    sizeBytes: item.byteLength ?? 0,
    width: null,
    height: null,
    durationMs: null,
    downloadUrl: grant.downloadUrl,
    expiresAt: grant.expiresAt,
  };
}

/**
 * Loads a public standalone shared message under the wrap-once envelope model.
 *
 * 1. GET /conversations/shared/message/:shareId → the flat single message
 *    { shareId, messageId, wrappedContentKey, contentItems, createdAt }.
 * 2. Extract shareSecret from the URL fragment (passed as `keyBase64`).
 * 3. openShare(shareSecret, wrappedContentKey) → contentKey (same key held by
 *    conversation members).
 * 4. Text items are decrypted inline; media items presign a per-item download
 *    URL against the share row, returned with metadata so the renderer can
 *    fetch + decrypt the ciphertext under the same contentKey.
 * 5. Items are returned sorted by `position`.
 *
 * Does NOT call `useTrackedDecryption`: the decrypt block runs inside the
 * `useQuery` queryFn so `isFetching` already gates the settled signal for
 * the entire fetch+decrypt window. Member-side `useDecryptedMessages`
 * decrypts inside `useMemo` (outside any query) and must track itself.
 */
export function useSharedMessage(
  shareId: string | null,
  keyBase64: string | null
): ReturnType<typeof useQuery<SharedMessageData>> {
  return useQuery({
    queryKey: sharedMessageKeys.detail(shareId),
    queryFn: async (): Promise<SharedMessageData> => {
      /* v8 ignore next 3 -- `enabled: !!shareId && !!keyBase64` gates the queryFn, so both are always present here; this throw only narrows the type and is unreachable */
      if (!shareId || !keyBase64) {
        throw new Error('Missing share ID or key');
      }

      const view = await fetchJson<SharedMessageView>(
        client.conversations.shared.message[':shareId'].$get({ param: { shareId } })
      );

      const shareSecret = fromBase64(keyBase64);
      const wrappedShareKey = fromBase64(view.wrappedContentKey) as WrappedContentKey;
      const contentKey = openShare(shareSecret, wrappedShareKey);

      const sorted = view.contentItems.toSorted((a, b) => a.position - b.position);
      const items: SharedContentItem[] = [];
      for (const item of sorted) {
        const built = await buildSharedContentItem(item, contentKey, shareId);
        if (built !== null) items.push(built);
      }

      return { createdAt: view.createdAt, contentKey, contentItems: items };
    },
    enabled: !!shareId && !!keyBase64,
  });
}
