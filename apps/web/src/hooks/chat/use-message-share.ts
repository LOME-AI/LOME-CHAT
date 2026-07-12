import { useMutation } from '@tanstack/react-query';
import { openMessageEnvelope, createShare, type WrappedContentKey } from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotentHeaders } from '@/lib/idempotent-mutation.js';
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
    mutationFn: async (input: ShareMessageInput): Promise<ShareMessageResult> => {
      const { messageId, conversationId, epochNumber, wrappedContentKey } = input;
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

      // The standalone share write stores the tiny wrap opaquely under
      // `wrappedContentKey` — the fresh-share-secret wrap, never the epoch wrap;
      // the server never sees the content key or the share secret. `input` is
      // the stable variables reference the WeakMap-backed idempotency key mints
      // once for, so a retry replays the same key.
      const result = await fetchJson<{ shareId: string }>(
        client.conversations[':conversationId'].shares.$post(
          {
            param: { conversationId },
            json: { messageId, wrappedContentKey: toBase64(wrappedShareKey) },
          },
          idempotentHeaders(input)
        )
      );

      const url = `${globalThis.location.origin}/share/m/${result.shareId}#${toBase64(shareSecret)}`;
      return { shareId: result.shareId, url };
    },
  });
}
