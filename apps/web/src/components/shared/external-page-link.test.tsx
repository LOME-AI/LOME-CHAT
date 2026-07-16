import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockIsNative = vi.fn<() => boolean>(() => false);
vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => mockIsNative(),
}));

const mockOpenExternalPage = vi.fn<(path: string) => Promise<void>>();
vi.mock('@/capacitor/browser', () => ({
  openExternalPage: (path: string): Promise<void> => mockOpenExternalPage(path),
}));

describe('ExternalPageLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNative.mockReturnValue(false);
    mockOpenExternalPage.mockResolvedValue();
  });

  describe('on web', () => {
    it('renders an anchor with href', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      const link = screen.getByText('Privacy');
      expect(link.tagName).toBe('A');
      expect(link).toHaveAttribute('href', '/privacy');
    });

    it('sets target="_blank" and rel="noopener noreferrer"', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/terms">Terms</ExternalPageLink>);

      const link = screen.getByText('Terms');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('passes through className', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(
        <ExternalPageLink path="/privacy" className="text-primary">
          Privacy
        </ExternalPageLink>
      );

      expect(screen.getByText('Privacy')).toHaveClass('text-primary');
    });

    it('does not call openExternalPage on click', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      fireEvent.click(screen.getByText('Privacy'));
      expect(mockOpenExternalPage).not.toHaveBeenCalled();
    });
  });

  describe('on native', () => {
    beforeEach(() => {
      mockIsNative.mockReturnValue(true);
    });

    it('renders an anchor element', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      const link = screen.getByText('Privacy');
      expect(link.tagName).toBe('A');
    });

    it('does not set href or target', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      const link = screen.getByText('Privacy');
      expect(link).not.toHaveAttribute('href');
      expect(link).not.toHaveAttribute('target');
    });

    it('has role="link" for accessibility', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      expect(screen.getByText('Privacy')).toHaveAttribute('role', 'link');
    });

    it('calls openExternalPage on click', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      fireEvent.click(screen.getByText('Privacy'));
      expect(mockOpenExternalPage).toHaveBeenCalledWith('/privacy');
    });

    it('passes through className', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(
        <ExternalPageLink path="/terms" className="hover:underline">
          Terms
        </ExternalPageLink>
      );

      expect(screen.getByText('Terms')).toHaveClass('hover:underline');
    });

    it('invokes a supplied onClick before opening the external page', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      const onClick = vi.fn();
      render(
        <ExternalPageLink path="/privacy" onClick={onClick}>
          Privacy
        </ExternalPageLink>
      );

      fireEvent.click(screen.getByText('Privacy'));
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(mockOpenExternalPage).toHaveBeenCalledWith('/privacy');
    });

    it('opens the external page on Enter keydown', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      fireEvent.keyDown(screen.getByText('Privacy'), { key: 'Enter' });
      expect(mockOpenExternalPage).toHaveBeenCalledWith('/privacy');
    });

    it('opens the external page on Space keydown', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/terms">Terms</ExternalPageLink>);

      fireEvent.keyDown(screen.getByText('Terms'), { key: ' ' });
      expect(mockOpenExternalPage).toHaveBeenCalledWith('/terms');
    });

    it('ignores other keydown keys', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      render(<ExternalPageLink path="/privacy">Privacy</ExternalPageLink>);

      fireEvent.keyDown(screen.getByText('Privacy'), { key: 'a' });
      expect(mockOpenExternalPage).not.toHaveBeenCalled();
    });
  });

  describe('ref forwarding', () => {
    it('forwards ref to the anchor element', async () => {
      const { ExternalPageLink } = await import('./external-page-link');
      const ref = vi.fn<(node: HTMLAnchorElement | null) => void>();
      render(
        <ExternalPageLink ref={ref} path="/privacy">
          Privacy
        </ExternalPageLink>
      );

      expect(ref).toHaveBeenCalledWith(expect.any(HTMLAnchorElement));
    });
  });
});
