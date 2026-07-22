// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { SocialBanner } from './social-banner';

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: (props: Record<string, unknown>) => (
      <canvas data-testid={TEST_IDS.cipherWall} data-props={JSON.stringify(props)} />
    ),
  };
});

describe('SocialBanner', () => {
  it.each(['light', 'dark'] as const)('renders the container for the %s variant', (variant) => {
    render(<SocialBanner variant={variant} />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner(variant))).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('fills the viewport for the %s variant', (variant) => {
    render(<SocialBanner variant={variant} />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner(variant))).toHaveStyle({
      width: '100vw',
      height: '100vh',
    });
  });

  it('applies the dark token scope only for the dark variant', () => {
    const { rerender } = render(<SocialBanner variant="dark" />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('dark'))).toHaveClass('dark');
    rerender(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('light'))).not.toHaveClass('dark');
  });

  it('renders the wordmark with Hush in ink, Box in brand red, and the descriptor', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_IDS.socialBannerWordmark)).toHaveClass('font-serif');
    expect(screen.getByText('Hush')).toHaveClass('text-foreground');
    expect(screen.getByText('Box')).toHaveClass('text-brand-red');
    expect(screen.getByText(/An AI chat interface/)).toBeInTheDocument();
  });

  it('leads with the privacy headliner in the editorial serif', () => {
    render(<SocialBanner variant="light" />);
    const headline = screen.getByTestId(TEST_IDS.socialBannerHeadline);
    expect(headline).toHaveTextContent('Privacy is a human right.');
    expect(headline).toHaveClass('font-serif');
    expect(headline).toHaveClass('text-foreground');
  });

  it('carries the brand tagline in the subline', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_IDS.socialBannerSubline)).toHaveTextContent(
      'One interface. Every feature. Private.'
    );
  });

  it('shows the site url in the window chrome', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.getByTestId(TEST_IDS.socialBannerUrl)).toHaveTextContent('hushbox.ai');
  });

  it.each(['light', 'dark'] as const)(
    'embeds the frozen %s demo on the welcome conversation, scrolled to top',
    (variant) => {
      render(<SocialBanner variant={variant} />);
      const iframe = screen.getByTestId(TEST_IDS.socialBannerPreview).querySelector('iframe');
      const source = iframe?.getAttribute('src') ?? '';
      expect(source).toContain('/demo?');
      expect(source).toContain('frozen=1');
      expect(source).toContain('convo=demo-welcome');
      expect(source).toContain('scroll=top');
      expect(source).toContain(`theme=${variant}`);
    }
  );

  it('passes a faint, frozen CipherWall backdrop with banner messages', () => {
    render(<SocialBanner variant="dark" />);
    const props = JSON.parse(screen.getByTestId(TEST_IDS.cipherWall).dataset['props'] ?? '{}');
    expect(props.frozen).toBe(true);
    expect(props.cipherOpacity).toBeLessThanOrEqual(0.5);
    expect(Array.isArray(props.messages)).toBe(true);
    expect(props.messages.length).toBeGreaterThan(0);
  });

  it('marks itself ready only after the embedded demo signals it has painted', () => {
    render(<SocialBanner variant="light" />);
    expect(screen.queryByTestId(TEST_IDS.socialBannerReady)).toBeNull();

    act(() => {
      globalThis.dispatchEvent(new MessageEvent('message', { data: { type: 'hb-demo-ready' } }));
    });

    expect(screen.getByTestId(TEST_IDS.socialBannerReady)).toBeInTheDocument();
  });

  /**
   * CIPHER_THEME in social-banner.tsx hardcodes hex colors because CipherWall
   * paints a canvas and cannot read CSS variables. This guard reads the brand
   * tokens from packages/config/tailwind/index.css at test time and asserts
   * the themeOverride handed to CipherWall matches them, so silent drift
   * between the two files fails loudly here.
   */
  describe('cipher theme token mirror', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const TOKEN_CSS = path.resolve(HERE, '../../../../../packages/config/tailwind/index.css');

    function cssToken(cssRegion: string, token: string): string {
      const match = new RegExp(String.raw`^\s*--${token}:\s*(#[0-9a-fA-F]{6});`, 'm').exec(
        cssRegion
      );
      if (!match?.[1]) throw new Error(`token --${token} not found in CSS region`);
      return match[1];
    }

    const css = readFileSync(TOKEN_CSS, 'utf8');
    const darkStart = css.indexOf('.dark {');
    const tokenRegion: Record<'light' | 'dark', string> = {
      light: css.slice(0, darkStart),
      dark: css.slice(darkStart),
    };

    it.each(['light', 'dark'] as const)(
      'mirrors the %s brand tokens from tailwind index.css',
      (variant) => {
        render(<SocialBanner variant={variant} />);
        const props = JSON.parse(screen.getByTestId(TEST_IDS.cipherWall).dataset['props'] ?? '{}');
        expect(props.themeOverride).toEqual({
          background: cssToken(tokenRegion[variant], 'background'),
          foreground: cssToken(tokenRegion[variant], 'foreground'),
          foregroundMuted: cssToken(tokenRegion[variant], 'foreground-muted'),
          brandRed: cssToken(tokenRegion[variant], 'brand-red'),
        });
      }
    );
  });

  it('ignores window messages that are not the demo ready signal', () => {
    render(<SocialBanner variant="light" />);

    act(() => {
      globalThis.dispatchEvent(new MessageEvent('message', { data: null }));
      globalThis.dispatchEvent(new MessageEvent('message', { data: { type: 'something-else' } }));
    });

    expect(screen.queryByTestId(TEST_IDS.socialBannerReady)).toBeNull();
  });
});
