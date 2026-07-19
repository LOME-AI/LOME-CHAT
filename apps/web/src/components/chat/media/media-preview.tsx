import * as React from 'react';
import { Download, Maximize2 } from 'lucide-react';
import { Button, cn, Img } from '@hushbox/ui';
import {
  legacyFriendlyErrorMessage,
  ERROR_CODE_STORAGE_READ_FAILED,
  TEST_IDS,
} from '@hushbox/shared';
import { buildDownloadFilename } from '@/lib/media-filename';
import { MediaModal } from '@/components/chat/media/media-modal';
import { LatentDevelopBackdrop } from '@/components/chat/media/latent-develop-backdrop';

function MediaProgressBar({ percent }: Readonly<{ percent: number }>): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      data-testid={TEST_IDS.mediaProgressBar}
      role="progressbar"
      aria-label="Media generation progress"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      className="bg-background h-1.5 w-full max-w-xs overflow-hidden rounded-full"
    >
      <div
        className="bg-primary h-full transition-[width] duration-200 ease-out"
        style={{ width: `${String(clamped)}%` }}
        aria-hidden="true"
      />
    </div>
  );
}

function resolvePlaceholderLabel(
  status: 'loading' | 'error',
  loadingLabel: string | undefined
): string {
  if (status === 'loading') return loadingLabel ?? 'Loading media…';
  // Error path uses the friendly mapping (Lane 9 handoff): single source of
  // truth for user-facing error wording lives in `error-messages.ts`.
  return legacyFriendlyErrorMessage(ERROR_CODE_STORAGE_READ_FAILED);
}

const MEDIA_MAX_WIDTH_REM = 28; // Tailwind max-w-md
const MEDIA_MAX_HEIGHT_REM = 24; // Tailwind max-h-96

export interface MediaRatio {
  /** width ÷ height — used to clamp the box width so tall ratios still fit max-h-96. */
  value: number;
  /** CSS `aspect-ratio` token, e.g. "16 / 9". */
  css: string;
}

/**
 * Resolve a media item's aspect ratio. Precedence:
 *   1. An explicit requested ratio (`"16:9"`), known during generation before
 *      any pixel dimensions exist.
 *   2. Persisted pixel dimensions (decrypt-load path).
 *   3. Square fallback when nothing is known.
 */
export function mediaRatio(
  aspectRatio: string | undefined,
  width: number | null | undefined,
  height: number | null | undefined
): MediaRatio {
  if (aspectRatio) {
    const [rawW, rawH] = aspectRatio.split(':');
    const ratioW = Number(rawW);
    const ratioH = Number(rawH);
    if (ratioW > 0 && ratioH > 0) {
      return { value: ratioW / ratioH, css: `${String(ratioW)} / ${String(ratioH)}` };
    }
  }
  if (width && height) {
    return { value: width / height, css: `${String(width)} / ${String(height)}` };
  }
  return { value: 1, css: '1 / 1' };
}

/**
 * THE shared on-screen box for a media item. The loading placeholder and the
 * resolved `<img>`/`<video>` both size from this, so swapping one for the other
 * never shifts layout. The box keeps the ratio while fitting inside BOTH
 * max-w-md and max-h-96 at any orientation — landscape is width-bound,
 * square/portrait height-bound — via `width = min(100%, max-w, max-h × ratio)`,
 * staying responsive on narrow viewports.
 */
export function mediaBoxStyle(ratio: MediaRatio): React.CSSProperties {
  return {
    width: `min(100%, ${String(MEDIA_MAX_WIDTH_REM)}rem, calc(${String(MEDIA_MAX_HEIGHT_REM)}rem * ${String(ratio.value)}))`,
    aspectRatio: ratio.css,
  };
}

export function MediaPlaceholder({
  width,
  height,
  status,
  /**
   * 0-100 progress for in-flight long-running media generations (today: video).
   * When set, renders a progress bar and the percent. Hidden when omitted.
   */
  progressPercent,
  /**
   * Optional override label for the loading state — used when the parent
   * knows the media type via `model:media:start` (e.g. "Generating image…",
   * "Generating video…"). Falls back to the generic "Loading media…".
   */
  loadingLabel,
  /**
   * Requested aspect ratio in colon form (`"16:9"`). Set during generation,
   * where the target shape is known from the user's config before any pixel
   * dimensions exist. Takes precedence over `width`/`height`.
   */
  aspectRatio,
}: Readonly<{
  width: number | null | undefined;
  height: number | null | undefined;
  status: 'loading' | 'error';
  progressPercent?: number | undefined;
  loadingLabel?: string | undefined;
  aspectRatio?: string | undefined;
}>): React.JSX.Element {
  const ratio = mediaRatio(aspectRatio, width, height);
  const label = resolvePlaceholderLabel(status, loadingLabel);
  const showProgress = status === 'loading' && typeof progressPercent === 'number';
  // Once we hit 95% the server is still finalising — surface that so users
  // don't read "stuck at 95%" as a failure.
  const isAlmostThere = showProgress && progressPercent >= 95;
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        'bg-muted relative flex flex-col items-center justify-center gap-2 overflow-hidden rounded-md border p-4 text-sm',
        status === 'error' && 'text-destructive'
      )}
      style={mediaBoxStyle(ratio)}
    >
      {status === 'loading' && (
        <LatentDevelopBackdrop {...(progressPercent !== undefined && { progressPercent })} />
      )}
      <div className="relative z-10 flex flex-col items-center gap-2">
        <span>{isAlmostThere ? 'Almost there…' : label}</span>
        {showProgress && <MediaProgressBar percent={progressPercent} />}
      </div>
    </div>
  );
}

export interface MediaPreviewProps {
  blobUrl: string;
  mimeType: string;
  contentType: 'image' | 'audio' | 'video';
  /**
   * Accessibility prefix. Images get `"{ariaPrefix} media"`; video/audio get
   * `"{ariaPrefix} video"` / `"{ariaPrefix} audio"`. Keep short — e.g.,
   * `"Generated"` for member-side, `"Shared"` for share-recipient side.
   */
  ariaPrefix: string;
  /**
   * Forwarded as HTML `width`/`height` so the browser reserves aspect-ratio
   * layout space before bytes load. Without this an unloaded media element
   * has a 0×0 bounding box, which makes Virtuoso mis-measure the row height
   * and breaks `scrollIntoView` math inside the virtualized chat list.
   */
  width?: number | null | undefined;
  height?: number | null | undefined;
  className?: string;
}

/**
 * Shared renderer for a decrypted media blob. Wraps img/video/audio with a
 * download button and (for image/video) a fullscreen modal trigger. Callers
 * own the fetch+decrypt lifecycle and pass in a ready blob URL + metadata —
 * this component is purely presentational.
 */
export function MediaPreview({
  blobUrl,
  mimeType,
  contentType,
  ariaPrefix,
  width,
  height,
  className,
}: Readonly<MediaPreviewProps>): React.JSX.Element {
  const [modalOpen, setModalOpen] = React.useState(false);
  const isImage = contentType === 'image';
  const isVideo = contentType === 'video';
  const isAudio = contentType === 'audio';
  const mediaAlt = `${ariaPrefix} media`;
  // Modal alt is type-specific so screen-reader users learn whether they're
  // entering an image lightbox or a video player.
  const modalAlt = isVideo ? `${ariaPrefix} video` : mediaAlt;
  const downloadFilename = buildDownloadFilename(contentType, mimeType);
  const dimensionProps = {
    ...(width != null && { width }),
    ...(height != null && { height }),
  };
  // Image/video render in the SAME box `MediaPlaceholder` reserved (shared
  // `mediaBoxStyle`), so the loading→loaded swap never shifts layout. Audio is
  // a control bar with no 2D shape, so it keeps a plain full-width row.
  const frameProps = isAudio
    ? { className: cn('relative w-full max-w-md', className) }
    : {
        className: cn('relative', className),
        style: mediaBoxStyle(mediaRatio(undefined, width, height)),
      };

  return (
    <div {...frameProps}>
      {isImage && (
        <button
          type="button"
          onClick={() => {
            setModalOpen(true);
          }}
          className="block h-full w-full cursor-zoom-in rounded-md border"
          aria-label="Open image in lightbox"
        >
          <Img
            src={blobUrl}
            alt={mediaAlt}
            loading="eager"
            {...dimensionProps}
            className="h-full w-full rounded-md object-contain"
          />
        </button>
      )}
      {isVideo && (
        // Video keeps its native controls for inline scrubbing. Fullscreen is a
        // SEPARATE, explicit affordance (the Maximize button below) rather than
        // a click-through on the surface: the <video> fills the frame and
        // swallows pointer events to drive its own controls, so a wrapping
        // click-to-open button never receives clicks in real browsers.
        // AI-generated media has no caption source today; revisit when
        // transcription becomes available.
        <>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- AI-generated video: no caption track is available; aria-label provides accessible name */}
          <video
            src={blobUrl}
            controls
            preload="metadata"
            playsInline
            {...dimensionProps}
            className="h-full w-full rounded-md border object-contain"
            aria-label={`${ariaPrefix} video`}
          />
          <Button
            type="button"
            size="icon"
            variant="secondary"
            onClick={() => {
              setModalOpen(true);
            }}
            className="absolute top-2 left-2 h-7 w-7 opacity-80 hover:opacity-100"
            aria-label="Expand video to fullscreen"
          >
            <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </>
      )}
      {isAudio && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- AI-generated audio: no caption track is available; aria-label provides accessible name
        <audio
          src={blobUrl}
          controls
          preload="none"
          className="w-full"
          aria-label={`${ariaPrefix} audio`}
        />
      )}

      <a
        href={blobUrl}
        download={downloadFilename}
        className="absolute top-2 right-2 inline-flex"
        aria-label="Download media"
      >
        <Button
          type="button"
          size="icon"
          variant="secondary"
          className="h-7 w-7 opacity-80 hover:opacity-100"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </a>

      {(isImage || isVideo) && (
        <MediaModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          blobUrl={blobUrl}
          mimeType={mimeType}
          alt={modalAlt}
        />
      )}
    </div>
  );
}
