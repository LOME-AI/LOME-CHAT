import { useMutation } from '@tanstack/react-query';
import { openMessageEnvelope, createShare, type WrappedContentKey } from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';
import { unportedEndpoint } from '@/lib/unported-endpoint.js';
import { getEpochKey } from '@/lib/epoch-key-cache.js';

interface ShareMessageInput {
  messageId: string;
  conversationId: string;
  epochNumber: number;
  /** Base64-encoded ECIES-wrapped content key from the message row. */
  wrappedContentKey: string;
}

interface ShareMessageResult {
  shareId: string;
  url: string;
}

/**
 * Creates a public share link for a message under the wrap-once envelope model.
 *
 * Unwraps the message's content key with the cached epoch key, re-wraps the
 * content key under a fresh `shareSecret`, and POSTs the tiny wrap to the
 * server. The server never sees the content key or the shareSecret.
 *
 * The request body is ~48 bytes regardless of the message's content size —
 * because only the 32-byte content key is re-wrapped, never the plaintext or
 * any media bytes.
 */
export function useMessageShare(): ReturnType<
  typeof useMutation<ShareMessageResult, Error, ShareMessageInput>
> {
  return useMutation({
    mutationFn: async ({
      messageId,
      conversationId,
      epochNumber,
      wrappedContentKey,
    }: ShareMessageInput): Promise<ShareMessageResult> => {
      const epochKey = getEpochKey(conversationId, epochNumber);
      if (!epochKey) {
        throw new Error(
          `Epoch key not available for conversation ${conversationId} epoch ${String(epochNumber)}`
        );
      }

      const contentKey = openMessageEnvelope(
        epochKey,
        fromBase64(wrappedContentKey) as WrappedContentKey
      );
      const { shareSecret, wrappedShareKey } = createShare(contentKey);

      // UNPORTED: the rebuilt share write is `POST /conversations/:id/shares`
      // and requires a minting `linkId` (shares are scoped to a shared link;
      // the content key is wrapped to the link key client-side). The legacy
      // wrap-once flow here has no link to mint into — reconciling the share
      // UX + crypto onto the link model is the UI-alignment task's scope.
      // `wrappedShareKey` stays computed above so the crypto path keeps its
      // coverage until the flow is ported.
      void messageId;
      void toBase64(wrappedShareKey);
      const result: { shareId: string } = await unportedEndpoint('POST /api/messages/share');

      const url = `${globalThis.location.origin}/share/m/${result.shareId}#${toBase64(shareSecret)}`;
      return { shareId: result.shareId, url };
    },
  });
}
