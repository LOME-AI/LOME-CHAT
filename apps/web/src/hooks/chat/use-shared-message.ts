import { useQuery } from '@tanstack/react-query';
import {
  openShare,
  decryptTextWithContentKey,
  type LegacyContentKey,
  type WrappedContentKey,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';

/**
 * One item of the rebuilt public-share read (`contentItemViewSchema` on the
 * conversations slice). Unlike the legacy share response there is no inline
 * `downloadUrl`/`expiresAt` — media presign is a separate per-item mint.
 */
interface PublicShareItemView {
  id: string;
  position: number;
  contentType: 'text' | 'image' | 'audio' | 'video';
  mimeType: string | null;
  byteLength: number | null;
  encryptedBlob: string | null;
}

/** `publicShareViewSchema` — the link-scoped public read. */
interface PublicShareView {
  displayName: string | null;
  sharedMessages: {
    messageId: string;
    wrappedContentKey: string;
    createdAt: string;
    contentItems: PublicShareItemView[];
  }[];
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

function buildSharedContentItem(
  item: PublicShareItemView,
  contentKey: LegacyContentKey
): SharedContentItem | null {
  if (item.contentType === 'text') {
    if (item.encryptedBlob == null) return null;
    const content = decryptTextWithContentKey(contentKey, fromBase64(item.encryptedBlob));
    return { type: 'text', position: item.position, content };
  }
  // Media item — the rebuilt read carries no inline presigned URL (presign is
  // `GET /media/shared/:shareId/:contentItemId/download-url`, a per-item mint
  // the share page does not perform yet), so media items are skipped until the
  // UI-alignment task wires that mint.
  console.warn('Skipping shared media item (presign mint not wired)', { id: item.id });
  return null;
}

/**
 * Loads a public shared message under the wrap-once envelope model.
 *
 * 1. GET /api/shares/:shareId → { wrappedShareKey, contentItems, createdAt }
 *    — media items carry a presigned GET URL minted server-side.
 * 2. Extract shareSecret from the URL fragment (passed as `keyBase64`).
 * 3. openShare(shareSecret, wrappedShareKey) → contentKey (same key held by
 *    conversation members).
 * 4. Text items are decrypted inline; media items are returned with their
 *    presigned URL plus metadata so the renderer can fetch + decrypt the
 *    ciphertext under the same contentKey.
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
    queryKey: ['shared-message', shareId],
    queryFn: async (): Promise<SharedMessageData> => {
      if (!shareId || !keyBase64) {
        throw new Error('Missing share ID or key');
      }

      // The rebuilt public read is link-scoped: `GET /conversations/shared/:linkId`
      // returns the minting link's shared-message set, each carrying its own
      // `wrappedContentKey` (wrapped under the link secret — the URL fragment).
      // Minimal projection until the share page is reworked for the link model
      // (UI-alignment task): render the first shared message. Media items are
      // skipped by `buildSharedContentItem` — the new read carries no inline
      // `downloadUrl` (presign is a separate per-item mint on the media slice).
      const response = await fetchJson<PublicShareView>(
        client.conversations.shared[':linkId'].$get({ param: { linkId: shareId } })
      );

      const shared = response.sharedMessages[0];
      if (!shared) {
        throw new Error('Share link has no shared messages');
      }

      const shareSecret = fromBase64(keyBase64);
      const wrappedShareKey = fromBase64(shared.wrappedContentKey) as WrappedContentKey;
      const contentKey = openShare(shareSecret, wrappedShareKey);

      const sorted = shared.contentItems.toSorted((a, b) => a.position - b.position);
      const items: SharedContentItem[] = [];
      for (const item of sorted) {
        const built = buildSharedContentItem(item, contentKey);
        if (built !== null) items.push(built);
      }

      return { createdAt: shared.createdAt, contentKey, contentItems: items };
    },
    enabled: !!shareId && !!keyBase64,
  });
}
