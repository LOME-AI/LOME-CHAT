import * as React from 'react';
import { useDecryptedMedia } from '@/hooks/crypto/use-decrypted-media';
import { MediaItemShell } from '@/components/chat/media/media-item-shell';
import type { LegacyContentKey } from '@hushbox/crypto';
import type { MessageMediaItem } from '@/lib/api';

/**
 * Normalized media descriptor consumed by the shared media renderer. The
 * authenticated chat (`MessageMediaItem` carries `id`) and the public share
 * view (`SharedContentItem` carries `contentItemId`) each map their own media
 * shape onto this, so one `MediaContentItem` renders both.
 */
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
}

/**
 * Map an authenticated chat media item (`MessageMediaItem`) onto the shared
 * `RenderableMedia` shape. Shared by the chat bubble and the share dialog
 * preview so both feed the unified `MediaContentItem` identically.
 */
export function messageMediaToRenderable(item: MessageMediaItem): RenderableMedia {
  return {
    contentItemId: item.id,
    contentType: item.contentType,
    mimeType: item.mimeType,
    width: item.width,
    height: item.height,
    ...(item.downloadUrl !== undefined && { downloadUrl: item.downloadUrl }),
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
  const { blobUrl, isLoading, error } = useDecryptedMedia({
    contentItemId: item.contentItemId,
    contentKey,
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
