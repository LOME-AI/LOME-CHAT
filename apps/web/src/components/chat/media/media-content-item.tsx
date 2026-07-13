import * as React from 'react';
import { useDecryptedMedia, type MediaEnvelopeDecryptor } from '@/hooks/crypto/use-decrypted-media';
import { MediaItemShell } from '@/components/chat/media/media-item-shell';
import type { ContentKey, LegacyContentKey, WrappedSecret } from '@hushbox/crypto';
import type { MessageMediaItem } from '@/lib/api';

/**
 * Normalized media descriptor consumed by the shared media renderer. The
 * authenticated chat (`MessageMediaItem` carries `id`) and the public share
 * view (`SharedContentItem` carries `contentItemId`) each map their own media
 * shape onto this, so one `MediaContentItem` renders both.
 */
/**
 * Message-level envelope context for member/epoch media, resolved once per
 * message (`useMessageContentKey` unwrap) and threaded to each media item.
 * The per-item `contentItemId` comes from the `RenderableMedia`, and `position`
 * is stamped in by `messageMediaToRenderable` — together they complete the
 * `ContentLocation` AAD tuple `decryptContentEnvelope` binds.
 */
export interface MessageEnvelopeContext {
  contentKey: ContentKey;
  wrappedContentKey: WrappedSecret;
  conversationId: string;
  messageId: string;
  epochNumber: number;
  senderId: string;
}

/** Per-item envelope context: {@link MessageEnvelopeContext} plus this item's position. */
export interface MediaEnvelopeContext extends MessageEnvelopeContext {
  position: number;
}

/**
 * Assemble a {@link MessageEnvelopeContext} from a message's resolved fields,
 * or `undefined` when any is missing (the content key hasn't resolved, or the
 * message lacks the location fields) — in which case the media renders as
 * loading/undecryptable rather than decrypting under a partial AAD. `senderId`
 * mirrors the persisted value: a null/scrubbed sender canonicalizes to '', the
 * exact string the server bound into the AAD.
 */
export function buildMessageEnvelopeContext(input: {
  contentKey: ContentKey | null;
  wrappedContentKey: WrappedSecret | null;
  conversationId: string | null;
  messageId: string | null;
  epochNumber: number | null | undefined;
  senderId: string | null | undefined;
}): MessageEnvelopeContext | undefined {
  const { contentKey, wrappedContentKey, conversationId, messageId, epochNumber, senderId } = input;
  if (
    contentKey === null ||
    wrappedContentKey === null ||
    conversationId === null ||
    messageId === null ||
    epochNumber == null ||
    senderId == null
  ) {
    return undefined;
  }
  return { contentKey, wrappedContentKey, conversationId, messageId, epochNumber, senderId };
}

export interface RenderableMedia {
  /** Stable content-item id; doubles as the blob-cache key and decrypt id. */
  contentItemId: string;
  contentType: 'image' | 'audio' | 'video';
  mimeType: string;
  width: number | null | undefined;
  height: number | null | undefined;
  /**
   * Presigned GET URL when the caller already holds one (share response, or the
   * SSE `done` event). When omitted, the auth download-url query mints one.
   * Share/guest callers MUST pass this — they cannot reach the auth query.
   */
  downloadUrl?: string | undefined;
  /**
   * Member/epoch envelope context. Present for the authenticated chat and the
   * share-dialog preview (new location-bound envelope); absent for the public
   * share view, which decrypts with the legacy per-share content key instead.
   */
  envelope?: MediaEnvelopeContext | undefined;
}

/**
 * Map an authenticated chat media item (`MessageMediaItem`) onto the shared
 * `RenderableMedia` shape. Shared by the chat bubble and the share dialog
 * preview so both feed the unified `MediaContentItem` identically. When the
 * caller supplies the message-level `envelope` context, each item is stamped
 * with its own position so the per-item `ContentLocation` AAD is complete.
 */
export function messageMediaToRenderable(
  item: MessageMediaItem,
  envelope?: MessageEnvelopeContext
): RenderableMedia {
  return {
    contentItemId: item.id,
    contentType: item.contentType,
    mimeType: item.mimeType,
    width: item.width,
    height: item.height,
    ...(item.downloadUrl !== undefined && { downloadUrl: item.downloadUrl }),
    ...(envelope !== undefined && { envelope: { ...envelope, position: item.position } }),
  };
}

interface MediaContentItemProps {
  item: RenderableMedia;
  /**
   * Pre-unwrapped message content key — resolved once per message (Plan §15.5:
   * ONE ECIES unwrap, not N) from the epoch key (chat) or once from the
   * `shareSecret` (share). `null` while the caller is still resolving it.
   */
  contentKey: LegacyContentKey | null;
  /**
   * Error from resolving the message content key (missing/rotated epoch key,
   * failed ECIES open). When set, the item is undecryptable: show the error UI
   * instead of waiting forever on a `null` contentKey (H11). A null contentKey
   * alone is "still resolving"; a null key WITH this error is "can't decrypt".
   */
  contentKeyError?: Error | null;
  /**
   * Accessibility prefix forwarded to the preview — short noun like "Generated"
   * for member-side or "Shared" for the share-recipient side.
   */
  ariaPrefix: string;
  className?: string;
}

/**
 * Renders a single media content item (image/video/audio). Fetches + decrypts
 * bytes on mount, then delegates the loading/error/preview rendering to
 * `MediaItemShell`. Shared by the authenticated chat, the share dialog preview,
 * and the public share view — the only per-caller difference is where
 * `contentKey` and `downloadUrl` come from, both passed in.
 */
export function MediaContentItem({
  item,
  contentKey,
  contentKeyError,
  ariaPrefix,
  className,
}: Readonly<MediaContentItemProps>): React.JSX.Element {
  // Member/epoch media carries an `envelope`: complete this item's location
  // tuple (message-level fields + this item's id/position) so the AAD matches
  // what the server bound at persist. Public-share media has no envelope and
  // falls back to the legacy `contentKey` symmetric decrypt.
  const envelope: MediaEnvelopeDecryptor | undefined = item.envelope
    ? {
        contentKey: item.envelope.contentKey,
        wrappedContentKey: item.envelope.wrappedContentKey,
        location: {
          conversationId: item.envelope.conversationId,
          messageId: item.envelope.messageId,
          contentItemId: item.contentItemId,
          position: item.envelope.position,
          epochNumber: item.envelope.epochNumber,
          senderId: item.envelope.senderId,
        },
      }
    : undefined;

  const { blobUrl, isLoading, error } = useDecryptedMedia({
    contentItemId: item.contentItemId,
    contentKey,
    ...(envelope !== undefined && { envelope }),
    mimeType: item.mimeType,
    ...(item.downloadUrl !== undefined && { preFetchedUrl: item.downloadUrl }),
  });

  // A content-key failure makes every byte undecryptable, so it takes
  // precedence over the per-item fetch/decrypt error and the loading state.
  const effectiveError = contentKeyError ?? error;

  return (
    <MediaItemShell
      blobUrl={blobUrl}
      isLoading={isLoading}
      error={effectiveError}
      mimeType={item.mimeType}
      contentType={item.contentType}
      width={item.width}
      height={item.height}
      ariaPrefix={ariaPrefix}
      {...(className !== undefined && { className })}
    />
  );
}
