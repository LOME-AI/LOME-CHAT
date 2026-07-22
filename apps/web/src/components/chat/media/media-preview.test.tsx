// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';

vi.mock('@/components/chat/media/media-modal', () => ({
  MediaModal: ({ open, alt }: { open: boolean; alt: string }) =>
    open ? <div data-testid="media-modal" data-alt={alt} /> : null,
}));

import {
  MediaPlaceholder,
  MediaPreview,
  mediaRatio,
  mediaBoxStyle,
} from '@/components/chat/media/media-preview';

function baseProps(
  overrides: Partial<Parameters<typeof MediaPreview>[0]> = {}
): Parameters<typeof MediaPreview>[0] {
  return {
    blobUrl: 'blob:preview-1',
    mimeType: 'image/png',
    contentType: 'image',
    ariaPrefix: 'Generated',
    ...overrides,
  };
}

describe('MediaPlaceholder', () => {
  it('renders the loading label when status is loading', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" />);
    expect(screen.getByRole('status', { name: /loading media/i })).toBeInTheDocument();
  });

  it('renders the friendly STORAGE_READ_FAILED error message when status is error', () => {
    render(<MediaPlaceholder width={null} height={null} status="error" />);
    // Friendly mapping for STORAGE_READ_FAILED: "We couldn't load this media. Please refresh the page."
    expect(
      screen.getByRole('status', { name: /couldn['’]t load this media.+refresh the page/i })
    ).toBeInTheDocument();
  });

  it('uses the given dimensions as the aspect ratio', () => {
    render(<MediaPlaceholder width={1024} height={512} status="loading" />);
    const placeholder = screen.getByRole('status');
    expect(placeholder.style.aspectRatio).toBe('1024 / 512');
  });

  it('falls back to 1 / 1 aspect ratio when dimensions are missing', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" />);
    const placeholder = screen.getByRole('status');
    expect(placeholder.style.aspectRatio).toBe('1 / 1');
  });

  it('derives the aspect ratio from a colon-form ratio string', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" aspectRatio="16:9" />);
    const placeholder = screen.getByRole('status');
    expect(placeholder.style.aspectRatio).toBe('16 / 9');
  });

  it('prefers the explicit ratio string over width/height', () => {
    render(<MediaPlaceholder width={100} height={100} status="loading" aspectRatio="9:16" />);
    const placeholder = screen.getByRole('status');
    expect(placeholder.style.aspectRatio).toBe('9 / 16');
  });

  it('uses the loadingLabel override when provided', () => {
    render(
      <MediaPlaceholder
        width={null}
        height={null}
        status="loading"
        loadingLabel="Generating image…"
      />
    );
    expect(screen.getByRole('status', { name: /generating image/i })).toBeInTheDocument();
  });

  it('renders the latent-develop backdrop while loading', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" />);
    expect(screen.getByTestId(TEST_IDS.latentDevelop)).toBeInTheDocument();
  });

  it('does not render the latent-develop backdrop in error state', () => {
    render(<MediaPlaceholder width={null} height={null} status="error" />);
    expect(screen.queryByTestId(TEST_IDS.latentDevelop)).not.toBeInTheDocument();
  });

  it('keeps the loading label visible above the backdrop', () => {
    render(
      <MediaPlaceholder
        width={null}
        height={null}
        status="loading"
        loadingLabel="Generating image…"
      />
    );
    expect(screen.getByText('Generating image…')).toBeInTheDocument();
  });

  it('renders a progress bar when progressPercent is provided in loading state', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" progressPercent={42} />);
    const bar = screen.getByTestId('media-progress-bar');
    expect(bar).toBeInTheDocument();
    const fill = bar.querySelector('div');
    expect(fill?.getAttribute('style')).toContain('42%');
  });

  it('exposes the progress bar as a progressbar with the current value', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" progressPercent={42} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
  });

  it('renders the "Almost there…" label once progressPercent >= 95', () => {
    render(<MediaPlaceholder width={null} height={null} status="loading" progressPercent={95} />);
    expect(screen.getByText(/almost there/i)).toBeInTheDocument();
  });

  it('hides the progress bar in error state', () => {
    render(<MediaPlaceholder width={null} height={null} status="error" progressPercent={50} />);
    expect(screen.queryByTestId('media-progress-bar')).not.toBeInTheDocument();
  });
});

describe('media box sizing (shared by placeholder + media)', () => {
  it('derives ratio value and css from a colon ratio', () => {
    expect(mediaRatio('16:9', null, null)).toEqual({ value: 16 / 9, css: '16 / 9' });
  });

  it('derives the ratio from pixel dimensions when no colon ratio is given', () => {
    expect(mediaRatio(undefined, 1920, 1080)).toEqual({ value: 1920 / 1080, css: '1920 / 1080' });
  });

  it('falls back to a square ratio when nothing is known', () => {
    expect(mediaRatio(undefined, null, null)).toEqual({ value: 1, css: '1 / 1' });
  });

  it('clamps the box width by max-w-md and max-h-96 × ratio', () => {
    const style = mediaBoxStyle({ value: 16 / 9, css: '16 / 9' });
    expect(style.aspectRatio).toBe('16 / 9');
    expect(style.width).toContain('100%');
    expect(style.width).toContain('28rem');
    expect(style.width).toContain(`calc(24rem * ${String(16 / 9)})`);
  });

  it('reserves the same box for a requested ratio and its matching resolved dimensions', () => {
    // Dedup guarantee: the loading placeholder (requested "16:9") and the
    // resolved media (1920×1080) size from the same functions, so the swap
    // never shifts layout.
    const requested = mediaBoxStyle(mediaRatio('16:9', null, null));
    const resolved = mediaBoxStyle(mediaRatio(undefined, 1920, 1080));
    expect(requested.width).toBe(resolved.width);
  });
});

describe('MediaPreview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders <img> for image content with the ariaPrefix in the alt text', () => {
    render(<MediaPreview {...baseProps({ contentType: 'image', ariaPrefix: 'Generated' })} />);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('Generated media');
    expect(img?.getAttribute('src')).toBe('blob:preview-1');
  });

  it('uses "Shared media" when ariaPrefix is "Shared"', () => {
    render(<MediaPreview {...baseProps({ ariaPrefix: 'Shared' })} />);
    expect(document.querySelector('img')?.getAttribute('alt')).toBe('Shared media');
  });

  it('renders <video> for video content with ariaPrefix in the aria-label', () => {
    render(
      <MediaPreview
        {...baseProps({
          contentType: 'video',
          mimeType: 'video/mp4',
          ariaPrefix: 'Shared',
        })}
      />
    );
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('aria-label')).toBe('Shared video');
    expect(document.querySelector('img')).toBeNull();
  });

  // Real iOS Safari launches the system fullscreen player when a <video>
  // without `playsinline` is played, which breaks inline chat playback.
  it('sets playsInline on the inline <video> so iOS Safari plays inline', () => {
    render(
      <MediaPreview
        {...baseProps({
          contentType: 'video',
          mimeType: 'video/mp4',
          ariaPrefix: 'Generated',
        })}
      />
    );
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.playsInline).toBe(true);
  });

  it('renders <audio> for audio content with ariaPrefix in the aria-label', () => {
    render(
      <MediaPreview
        {...baseProps({
          contentType: 'audio',
          mimeType: 'audio/mpeg',
          ariaPrefix: 'Generated',
        })}
      />
    );
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('aria-label')).toBe('Generated audio');
  });

  it('shows a download link with a filename derived from the mime type', () => {
    render(<MediaPreview {...baseProps({ contentType: 'video', mimeType: 'video/mp4' })} />);
    const link = screen.getByRole('link', { name: /download media/i });
    expect(link.getAttribute('download')).toMatch(/^hushbox-video-\d{8}-\d{6}\.mp4$/);
    expect(link).toHaveAttribute('href', 'blob:preview-1');
  });

  it('opens the lightbox modal when an image is clicked', async () => {
    const user = userEvent.setup();
    render(<MediaPreview {...baseProps({ ariaPrefix: 'Shared' })} />);

    expect(screen.queryByTestId('media-modal')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /open image in lightbox/i }));
    const modal = screen.getByTestId('media-modal');
    expect(modal).toBeInTheDocument();
    expect(modal.dataset['alt']).toBe('Shared media');
  });

  it('opens the fullscreen modal when the video expand control is clicked', async () => {
    const user = userEvent.setup();
    render(
      <MediaPreview
        {...baseProps({
          contentType: 'video',
          mimeType: 'video/mp4',
          ariaPrefix: 'Generated',
        })}
      />
    );

    expect(screen.queryByTestId('media-modal')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /expand video to fullscreen/i }));
    const modal = screen.getByTestId('media-modal');
    expect(modal).toBeInTheDocument();
    expect(modal.dataset['alt']).toBe('Generated video');
  });

  // The inline <video> must keep native controls so users can scrub without
  // entering the modal — fullscreen is a separate, explicit affordance.
  it('keeps native controls on the inline video element', () => {
    render(
      <MediaPreview
        {...baseProps({
          contentType: 'video',
          mimeType: 'video/mp4',
          ariaPrefix: 'Generated',
        })}
      />
    );
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.controls).toBe(true);
  });

  it('does not render the fullscreen trigger for audio content', () => {
    render(<MediaPreview {...baseProps({ contentType: 'audio', mimeType: 'audio/mpeg' })} />);
    expect(
      screen.queryByRole('button', { name: /open image in lightbox/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /expand video to fullscreen/i })
    ).not.toBeInTheDocument();
  });
});
