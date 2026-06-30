import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LegacyContentKey } from '@hushbox/crypto';
import type { RenderableMedia } from '@/components/chat/media/media-content-item';

const mockUseDecryptedMedia = vi.fn<
  (params: {
    contentItemId: string;
    contentKey: LegacyContentKey | null;
    mimeType: string;
    preFetchedUrl?: string;
  }) => {
    blobUrl: string | null;
    isLoading: boolean;
    error: Error | null;
  }
>();

vi.mock('@/hooks/crypto/use-decrypted-media', () => ({
  useDecryptedMedia: (params: Parameters<typeof mockUseDecryptedMedia>[0]) =>
    mockUseDecryptedMedia(params),
}));

import {
  MediaContentItem,
  messageMediaToRenderable,
} from '@/components/chat/media/media-content-item';

function defaultItem(overrides: Partial<RenderableMedia> = {}): RenderableMedia {
  return {
    contentItemId: 'media-1',
    contentType: 'image',
    mimeType: 'image/png',
    width: 512,
    height: 512,
    ...overrides,
  };
}

const baseContentKey = new Uint8Array([1, 2, 3]) as LegacyContentKey;
const baseProps = {
  contentKey: baseContentKey,
  ariaPrefix: 'Generated',
};

describe('MediaContentItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading placeholder when isLoading is true', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: true,
      error: null,
    });

    render(<MediaContentItem item={defaultItem()} {...baseProps} />);

    expect(screen.getByRole('status', { name: /loading media/i })).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows loading placeholder when blobUrl is null and not errored', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: false,
      error: null,
    });

    render(<MediaContentItem item={defaultItem()} {...baseProps} />);

    expect(screen.getByRole('status', { name: /loading media/i })).toBeInTheDocument();
  });

  it('shows error placeholder when useDecryptedMedia returns error', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: false,
      error: new Error('Decryption failed'),
    });

    render(<MediaContentItem item={defaultItem()} {...baseProps} />);

    expect(
      screen.getByRole('status', { name: /couldn['’]t load this media.+refresh the page/i })
    ).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });

  it('shows error placeholder when contentKeyError is set and key is null (undecryptable, H11)', () => {
    // A missing/rotated epoch key makes the message undecryptable: the parent
    // resolves contentKey=null with an error. The item must show the error UI,
    // not a perpetual spinner.
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: null,
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem()}
        contentKey={null}
        contentKeyError={new Error('Epoch key not available')}
        ariaPrefix="Generated"
      />
    );

    expect(
      screen.getByRole('status', { name: /couldn['’]t load this media.+refresh the page/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /loading media/i })).not.toBeInTheDocument();
  });

  it('renders <img> with the blob URL when contentType is image and success', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(<MediaContentItem item={defaultItem({ contentType: 'image' })} {...baseProps} />);

    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:mock-1');
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('renders <video> when contentType is video', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentType: 'video', mimeType: 'video/mp4' })}
        {...baseProps}
      />
    );

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:mock-1');
    expect(document.querySelector('img')).toBeNull();
  });

  it('renders <audio> when contentType is audio', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentType: 'audio', mimeType: 'audio/mpeg' })}
        {...baseProps}
      />
    );

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe('blob:mock-1');
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('video')).toBeNull();
  });

  it('shows download button with the correct filename for png', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentItemId: 'abc-123', mimeType: 'image/png' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-image-\d{8}-\d{6}\.png$/);
    expect(link).toHaveAttribute('href', 'blob:mock-1');
  });

  it('derives filename extension from mp4 mime type for videos', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentItemId: 'vid-9', contentType: 'video', mimeType: 'video/mp4' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-video-\d{8}-\d{6}\.mp4$/);
  });

  it('derives filename extension from audio mime type', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentItemId: 'aud-7', contentType: 'audio', mimeType: 'audio/mpeg' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-audio-\d{8}-\d{6}\.mp3$/);
  });

  it('falls back to bin extension for unknown mime types', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentItemId: 'weird-1', mimeType: 'application/octet-stream' })}
        {...baseProps}
      />
    );

    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-image-\d{8}-\d{6}\.bin$/);
  });

  it('clicking the image opens the MediaModal lightbox', async () => {
    const user = userEvent.setup();
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(<MediaContentItem item={defaultItem({ contentType: 'image' })} {...baseProps} />);

    // Before clicking, only the inline image should be present (no modal content).
    expect(document.querySelectorAll('img')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /open image in lightbox/i }));

    // The modal renders a second img with the blob URL at larger size.
    expect(document.querySelectorAll('img').length).toBeGreaterThanOrEqual(2);
  });

  it('does not render click-to-open button for non-image content', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    render(
      <MediaContentItem
        item={defaultItem({ contentType: 'video', mimeType: 'video/mp4' })}
        {...baseProps}
      />
    );

    expect(
      screen.queryByRole('button', { name: /open image in lightbox/i })
    ).not.toBeInTheDocument();
  });

  it('passes correct parameters to useDecryptedMedia', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    const ck = new Uint8Array([7, 7, 7]) as LegacyContentKey;
    render(
      <MediaContentItem
        item={defaultItem({ contentItemId: 'item-42', mimeType: 'image/webp' })}
        contentKey={ck}
        ariaPrefix="Generated"
      />
    );

    expect(mockUseDecryptedMedia).toHaveBeenCalledWith({
      contentItemId: 'item-42',
      contentKey: ck,
      mimeType: 'image/webp',
    });
  });

  it('forwards a pre-supplied downloadUrl as preFetchedUrl (share / SSE path)', () => {
    mockUseDecryptedMedia.mockReturnValue({
      blobUrl: 'blob:mock-1',
      isLoading: false,
      error: null,
    });

    const ck = new Uint8Array([5, 5, 5]) as LegacyContentKey;
    render(
      <MediaContentItem
        item={defaultItem({
          contentItemId: 'ci-7',
          mimeType: 'image/png',
          downloadUrl: 'https://signed.example/y?sig=z',
        })}
        contentKey={ck}
        ariaPrefix="Shared"
      />
    );

    expect(mockUseDecryptedMedia).toHaveBeenCalledWith({
      contentItemId: 'ci-7',
      contentKey: ck,
      mimeType: 'image/png',
      preFetchedUrl: 'https://signed.example/y?sig=z',
    });
  });
});

describe('messageMediaToRenderable', () => {
  it('maps a media item without a downloadUrl to the renderable shape', () => {
    const result = messageMediaToRenderable({
      id: 'm1',
      position: 0,
      contentType: 'image',
      mimeType: 'image/png',
      sizeBytes: 10,
      width: 4,
      height: 5,
    });

    expect(result).toEqual({
      contentItemId: 'm1',
      contentType: 'image',
      mimeType: 'image/png',
      width: 4,
      height: 5,
    });
    expect('downloadUrl' in result).toBe(false);
  });

  it('carries the downloadUrl through when the item has one', () => {
    const result = messageMediaToRenderable({
      id: 'm2',
      position: 1,
      contentType: 'video',
      mimeType: 'video/mp4',
      sizeBytes: 20,
      width: null,
      height: null,
      downloadUrl: 'https://signed.example/v',
    });

    expect(result.downloadUrl).toBe('https://signed.example/v');
  });
});
