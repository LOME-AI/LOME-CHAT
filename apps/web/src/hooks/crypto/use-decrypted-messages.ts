import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  unwrapContentKeyFromEpoch,
  decryptContentEnvelope,
  asEpochPrivateKey,
  type WrappedSecret,
} from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { useAuthStore } from '@/lib/auth';
import {
  getEpochKey,
  processKeyChain,
  subscribe as subscribeEpochCache,
  getSnapshot as getEpochCacheSnapshot,
} from '@/lib/epoch-key-cache';
import { useTrackedDecryption } from '@/hooks/crypto/use-tracked-decryption';
import { keyChainQueryOptions, keyKeys } from '@/hooks/crypto/keys';
import type { MessageResponse, ContentItemResponse } from '@hushbox/shared';
import type { Message, MessageMediaItem } from '@/lib/api';

/**
 * Per-message decrypted-content cache, keyed by `conversationId:messageId`.
 *
 * Realtime invalidation (use-realtime-sync) refetches the conversation on
 * every inbound event, producing a fresh `messages` array reference each
 * time. Without this cache the hook would re-decrypt the entire history
 * synchronously on the main thread per event. The cache lets unchanged
 * messages reuse their plaintext so only NEW or epoch-rotated messages
 * decrypt.
 *
 * `epochNumber` is stored alongside the plaintext: a message that rotates to
 * a new epoch must re-decrypt (its content key is now sealed under a
 * different epoch key), so a stale-epoch hit is treated as a miss.
 */
interface DecryptedEntry {
  epochNumber: number;
  content: string;
}

const decryptedCache = new Map<string, DecryptedEntry>();

const textDecoder = new TextDecoder();

function decryptedCacheKey(conversationId: string, messageId: string): string {
  return `${conversationId}:${messageId}`;
}

/** Clears the per-message decrypted-content cache. For test cleanup. */
export function clearDecryptedMessageCache(): void {
  decryptedCache.clear();
}

function mapSenderTypeToRole(senderType: 'user' | 'ai'): 'user' | 'assistant' {
  return senderType === 'ai' ? 'assistant' : 'user';
}

function sumCost(contentItems: ContentItemResponse[]): string | null {
  let total = 0;
  let seen = false;
  for (const item of contentItems) {
    if (item.cost != null) {
      total += Number.parseFloat(item.cost);
      seen = true;
    }
  }
  return seen ? total.toFixed(8) : null;
}

function pickModelName(contentItems: ContentItemResponse[]): string | null {
  for (const item of contentItems) {
    if (item.modelName != null) return item.modelName;
  }
  return null;
}

/**
 * True iff any content item on the message was produced via a routing stage
 * (Smart Model today). Drives the "Smart" chip on the assistant nametag.
 */
function pickIsSmartModel(contentItems: ContentItemResponse[]): boolean {
  return contentItems.some((item) => item.isSmartModel);
}

function extractMediaItems(contentItems: ContentItemResponse[]): MessageMediaItem[] {
  const media: MessageMediaItem[] = [];
  for (const item of contentItems) {
    if (item.contentType === 'text') continue;
    if (item.mimeType == null || item.sizeBytes == null) {
      // Server CHECK constraint should prevent this; log to catch regressions.
      console.warn(
        `Skipping malformed media content item ${item.id}: missing mimeType or sizeBytes`
      );
      continue;
    }
    media.push({
      id: item.id,
      contentType: item.contentType,
      position: item.position,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
    });
  }
  return media;
}

function buildDecryptedMessage(msg: MessageResponse, content: string): Message {
  const cost = sumCost(msg.contentItems);
  const modelName = pickModelName(msg.contentItems);
  const mediaItems = extractMediaItems(msg.contentItems);
  const isSmartModel = pickIsSmartModel(msg.contentItems);
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    role: mapSenderTypeToRole(msg.senderType),
    content,
    createdAt: msg.createdAt,
    ...(cost != null && { cost }),
    ...(msg.senderId != null && { senderId: msg.senderId }),
    modelName,
    parentMessageId: msg.parentMessageId,
    batchId: msg.batchId,
    wrappedContentKey: msg.wrappedContentKey,
    epochNumber: msg.epochNumber,
    ...(isSmartModel && { isSmartModel: true }),
    ...(mediaItems.length > 0 && { mediaItems }),
  };
}

/**
 * Decrypts MessageResponse[] into display Message[] under the wrap-once
 * envelope model.
 *
 * 1. Fetches key chain from /api/keys/:conversationId.
 * 2. Unwraps epoch keys using the account private key (cached via processKeyChain).
 * 3. Traverses chain links for older epochs.
 * 4. For each message, calls unwrapContentKeyFromEpoch once with the epoch
 *    private key to recover the message's content key.
 * 5. For each text content item on the message, calls decryptContentEnvelope
 *    with the same content key, the message's wrapped content key, and the
 *    item's full location tuple (which the server bound as AAD at persist).
 *    The UTF-8 plaintext bytes are decoded and joined into a single `content`
 *    string for the display Message shape.
 * 6. Maps senderType to role for display, sums per-item costs, and picks the
 *    first model name seen across content items.
 */
export function useDecryptedMessages(
  conversationId: string | null,
  messages: MessageResponse[] | undefined,
  privateKeyOverride?: Uint8Array | null
): Message[] {
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const effectivePrivateKey = privateKeyOverride ?? accountPrivateKey;
  const queryClient = useQueryClient();
  const refetchedForEpochRef = useRef(0);

  // Reset refetch guard when conversation changes.
  useEffect(() => {
    refetchedForEpochRef.current = 0;
  }, [conversationId]);

  const { data: keyChain } = useQuery({
    ...keyChainQueryOptions(conversationId ?? ''),
    enabled: !!conversationId && !!effectivePrivateKey,
  });

  // Populate the epoch key cache outside of render. processKeyChain mutates
  // module-level state and notifies subscribers, so running it during render
  // (in a useMemo) double-fires under StrictMode/concurrent and is impure.
  // The epoch-cache snapshot below recomputes `decrypted` once keys land.
  useEffect(() => {
    if (!conversationId || !keyChain || !effectivePrivateKey) return;
    processKeyChain(conversationId, keyChain, effectivePrivateKey);
  }, [conversationId, keyChain, effectivePrivateKey]);

  const epochCacheVersion = useSyncExternalStore(subscribeEpochCache, getEpochCacheSnapshot);

  const decrypted = useMemo(() => {
    if (
      !conversationId ||
      !messages ||
      messages.length === 0 ||
      !effectivePrivateKey ||
      !keyChain
    ) {
      return [];
    }

    return messages.map((msg): Message => {
      // Reuse cached plaintext for unchanged messages so realtime
      // invalidations don't re-decrypt the whole history. A message that
      // rotated to a new epoch is a cache miss (its content key is sealed
      // under a different epoch key now).
      const cacheKey = decryptedCacheKey(conversationId, msg.id);
      const cached = decryptedCache.get(cacheKey);
      if (cached?.epochNumber === msg.epochNumber) {
        return buildDecryptedMessage(msg, cached.content);
      }

      const epochKey = getEpochKey(conversationId, msg.epochNumber);
      if (!epochKey) {
        return buildDecryptedMessage(msg, '[decryption failed: missing epoch key]');
      }

      try {
        // The server binds each content item's full location tuple (and the
        // wrapped content key) as AAD, so the same wrap bytes reconstructed
        // here must feed both the unwrap and every envelope decrypt. A null
        // senderId (a scrubbed/deleted account) can never match the bound AAD,
        // so such a message intentionally falls through to `[decryption failed]`.
        const wrappedContentKey = fromBase64(msg.wrappedContentKey) as WrappedSecret;
        const contentKey = unwrapContentKeyFromEpoch(
          asEpochPrivateKey(epochKey),
          wrappedContentKey
        );
        const senderId = msg.senderId ?? '';
        const parts: string[] = [];
        for (const item of msg.contentItems) {
          if (item.contentType === 'text' && item.encryptedBlob != null) {
            const plaintextBytes = decryptContentEnvelope(
              contentKey,
              wrappedContentKey,
              {
                conversationId,
                messageId: msg.id,
                contentItemId: item.id,
                position: item.position,
                epochNumber: msg.epochNumber,
                senderId,
              },
              fromBase64(item.encryptedBlob)
            );
            parts.push(textDecoder.decode(plaintextBytes));
          }
        }
        const content = parts.join('');
        decryptedCache.set(cacheKey, { epochNumber: msg.epochNumber, content });
        return buildDecryptedMessage(msg, content);
      } catch {
        return buildDecryptedMessage(msg, '[decryption failed]');
      }
    });
    // epochCacheVersion forces recompute when processKeyChain populates keys
    // from the effect above (the memo otherwise has no dependency on it).
  }, [conversationId, messages, effectivePrivateKey, keyChain, epochCacheVersion]);

  // Refetch key chain when messages reference epochs beyond the cached currentEpoch.
  // This handles the race where WebSocket rotation:complete hasn't arrived yet.
  useEffect(() => {
    if (!conversationId || !keyChain || !messages || messages.length === 0) return;

    const hasNewerEpoch = messages.some((msg) => msg.epochNumber > keyChain.currentEpoch);
    if (!hasNewerEpoch) return;

    // Prevent infinite loop: only refetch once per stale currentEpoch value.
    if (refetchedForEpochRef.current === keyChain.currentEpoch) return;
    refetchedForEpochRef.current = keyChain.currentEpoch;

    void queryClient.invalidateQueries({ queryKey: keyKeys.chain(conversationId) });
  }, [conversationId, keyChain, messages, queryClient]);

  const isPending =
    !!conversationId &&
    !!effectivePrivateKey &&
    (messages?.length ?? 0) > 0 &&
    decrypted.length === 0;

  useTrackedDecryption(isPending);

  return decrypted;
}
