import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MediaModal } from '@/components/chat/media/media-modal';

describe('MediaModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    blobUrl: 'blob:mock-url',
    mimeType: 'image/png',
    alt: 'Test media',
  };

  it('renders img when mimeType starts with image/ and blobUrl is non-null', () => {
    render(<MediaModal {...defaultProps} mimeType="image/jpeg" />);

    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('blob:mock-url');
  });

  it('renders video when mimeType starts with video/', () => {
    render(<MediaModal {...defaultProps} mimeType="video/mp4" />);

    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.getAttribute('src')).toBe('blob:mock-url');
    expect(document.querySelector('img')).toBeNull();
  });

  it('sets playsInline on the modal <video> for iOS Safari inline playback', () => {
    render(<MediaModal {...defaultProps} mimeType="video/mp4" />);
    const video = document.querySelector('video');
    expect(video).not.toBeNull();
    expect(video!.playsInline).toBe(true);
  });

  it('renders audio when mimeType starts with audio/', () => {
    render(<MediaModal {...defaultProps} mimeType="audio/mpeg" />);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio?.getAttribute('src')).toBe('blob:mock-url');
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('returns empty (no img/video/audio) when blobUrl is null', () => {
    render(<MediaModal {...defaultProps} blobUrl={null} />);

    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('video')).toBeNull();
    expect(document.querySelector('audio')).toBeNull();
  });

  it('calls onOpenChange when closed via close button', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<MediaModal {...defaultProps} onOpenChange={onOpenChange} />);

    await user.click(screen.getByRole('button', { name: /close/i }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses provided alt text for the image', () => {
    render(<MediaModal {...defaultProps} mimeType="image/png" alt="My custom alt text" />);

    const img = document.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('My custom alt text');
  });

  it('falls back to default alt text when alt is not provided', () => {
    render(
      <MediaModal
        open={defaultProps.open}
        onOpenChange={defaultProps.onOpenChange}
        blobUrl={defaultProps.blobUrl}
        mimeType="image/png"
      />
    );

    const img = document.querySelector('img');
    expect(img?.getAttribute('alt')).toBe('Generated media');
  });

  it('does not render image element for audio/video mimeTypes', () => {
    const { rerender } = render(<MediaModal {...defaultProps} mimeType="video/mp4" />);
    expect(document.querySelector('img')).toBeNull();

    rerender(<MediaModal {...defaultProps} mimeType="audio/mpeg" />);
    expect(document.querySelector('img')).toBeNull();
  });

  it('falls back to a default aria-label for video when alt is not provided', () => {
    render(
      <MediaModal
        open={defaultProps.open}
        onOpenChange={defaultProps.onOpenChange}
        blobUrl={defaultProps.blobUrl}
        mimeType="video/mp4"
      />
    );

    expect(document.querySelector('video')?.getAttribute('aria-label')).toBe('Generated video');
  });

  it('falls back to a default aria-label for audio when alt is not provided', () => {
    render(
      <MediaModal
        open={defaultProps.open}
        onOpenChange={defaultProps.onOpenChange}
        blobUrl={defaultProps.blobUrl}
        mimeType="audio/mpeg"
      />
    );

    expect(document.querySelector('audio')?.getAttribute('aria-label')).toBe('Generated audio');
  });

  describe('download button', () => {
    it('renders an accessible download anchor for image media', () => {
      render(<MediaModal {...defaultProps} mimeType="image/png" />);
      const anchor = screen.getByRole('link', { name: /download media/i });
      expect(anchor).toBeInTheDocument();
      expect(anchor.getAttribute('href')).toBe('blob:mock-url');
      expect(anchor.getAttribute('download')).toMatch(/^hushbox-image-\d{8}-\d{6}\.png$/);
    });

    it('renders an accessible download anchor for video media', () => {
      render(<MediaModal {...defaultProps} mimeType="video/mp4" />);
      const anchor = screen.getByRole('link', { name: /download media/i });
      expect(anchor.getAttribute('href')).toBe('blob:mock-url');
      expect(anchor.getAttribute('download')).toMatch(/^hushbox-video-\d{8}-\d{6}\.mp4$/);
    });

    it('renders an accessible download anchor for audio media', () => {
      render(<MediaModal {...defaultProps} mimeType="audio/mpeg" />);
      const anchor = screen.getByRole('link', { name: /download media/i });
      expect(anchor.getAttribute('href')).toBe('blob:mock-url');
      expect(anchor.getAttribute('download')).toMatch(/^hushbox-audio-\d{8}-\d{6}\.mp3$/);
    });

    it('does not render the download anchor when blobUrl is null', () => {
      render(<MediaModal {...defaultProps} blobUrl={null} />);
      expect(screen.queryByRole('link', { name: /download media/i })).not.toBeInTheDocument();
    });
  });
});
