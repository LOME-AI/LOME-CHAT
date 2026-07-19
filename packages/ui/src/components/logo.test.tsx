import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { Logo, resolveImageSrc as resolveImageSource, LOGO_FALLBACK_SRC } from './logo';

describe('Logo', () => {
  it('renders the HushBox logo image', () => {
    render(<Logo />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src');
  });

  it('renders HushBox text with branded Box', () => {
    render(<Logo />);
    expect(screen.getByText(/Hush/)).toBeInTheDocument();
    expect(screen.getByText('Box')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<Logo className="custom-class" />);
    const container = screen.getByTestId(TEST_IDS.logo);
    expect(container).toHaveClass('custom-class');
  });

  it('preserves default flex layout classes', () => {
    render(<Logo />);
    const container = screen.getByTestId(TEST_IDS.logo);
    expect(container).toHaveClass('flex', 'items-center', 'gap-2');
  });

  it('has correct image dimensions', () => {
    render(<Logo />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toHaveClass('h-6', 'w-6');
  });

  it('has correct text styling', () => {
    render(<Logo />);
    const text = screen.getByText(/Hush/);
    expect(text).toHaveClass('text-lg', 'font-bold');
  });

  it('renders the wordmark in the serif brand font', () => {
    render(<Logo />);
    const text = screen.getByText(/Hush/);
    // The wordmark is editorial brand display, so it stays serif under the
    // sans-default cascade instead of inheriting the UI chrome font.
    expect(text).toHaveClass('font-serif');
  });

  it('has tight line-height on text for vertical alignment', () => {
    render(<Logo />);
    const text = screen.getByText(/Hush/);
    expect(text).toHaveClass('leading-none');
  });

  it('has branded red color on Box text', () => {
    render(<Logo />);
    const box = screen.getByText('Box');
    expect(box).toHaveClass('text-brand-red');
  });

  it('does not emit data-no-invert', () => {
    render(<Logo />);
    const container = screen.getByTestId(TEST_IDS.logo);
    expect(container).not.toHaveAttribute('data-no-invert');
  });

  it('never renders an empty src, even when the asset import is unresolvable', async () => {
    vi.resetModules();
    vi.doMock('../assets/HushBoxLogo.png', () => ({ default: undefined }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { Logo: FreshLogo } = await import('./logo');

    render(<FreshLogo />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img.getAttribute('src')).not.toBe('');
    expect(img).toHaveAttribute('src', LOGO_FALLBACK_SRC);

    warnSpy.mockRestore();
    vi.doUnmock('../assets/HushBoxLogo.png');
    vi.resetModules();
  });
});

describe('resolveImageSrc', () => {
  it('returns string imports directly (Vite)', () => {
    expect(resolveImageSource('/assets/logo.png')).toBe('/assets/logo.png');
  });

  it('extracts .src from object imports (Astro SSR)', () => {
    const astroImport = {
      src: '/_astro/HushBoxLogo.abc123.png',
      width: 64,
      height: 64,
      format: 'png',
    };
    expect(resolveImageSource(astroImport)).toBe('/_astro/HushBoxLogo.abc123.png');
  });

  it('returns empty string and warns for unexpected types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveImageSource(42)).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unexpected logo import type'));
    warnSpy.mockRestore();
  });

  it('returns empty string and warns for objects without src', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveImageSource({ width: 64 })).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unexpected logo import type'));
    warnSpy.mockRestore();
  });
});
