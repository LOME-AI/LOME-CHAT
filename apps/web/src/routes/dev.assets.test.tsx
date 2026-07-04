import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { renderRoute } from '@/test-utils/render';
import { Route } from './dev.assets';

// Mirrors the route file's inlined definitions (the source of truth). Kept in
// the test so assertions on counts and dimensions survive without the route
// file exporting these values (code-splitting guardrail).
const ASSET_DEFINITIONS = [
  { name: 'icon-only', label: 'App Icon', width: 1024, height: 1024 },
  { name: 'icon-background', label: 'Icon Background', width: 1024, height: 1024 },
  { name: 'icon-foreground', label: 'Icon Foreground', width: 1024, height: 1024 },
  { name: 'splash-dark', label: 'Splash (Dark)', width: 2732, height: 2732 },
  { name: 'splash', label: 'Splash (Light)', width: 2732, height: 2732 },
  { name: 'social-banner', label: 'Social Banner (Light)', width: 1500, height: 500 },
  { name: 'social-banner-dark', label: 'Social Banner (Dark)', width: 1500, height: 500 },
] as const;

const SCREENSHOT_DEFINITIONS = [
  { name: 'chat', label: 'Chat' },
  { name: 'model-picker', label: 'Model Picker' },
  { name: 'group-chat', label: 'Group Chat' },
  { name: 'document-code', label: 'Document (Code)' },
  { name: 'document-mermaid', label: 'Document (Mermaid)' },
  { name: 'privacy', label: 'Privacy' },
] as const;

const RESOLUTION_DEFINITIONS = [
  { name: 'apple-phone', label: 'Apple iPhone (6.9")', width: 1320, height: 2868 },
  { name: 'apple-tablet', label: 'Apple iPad (13")', width: 2064, height: 2752 },
  { name: 'google-phone', label: 'Google Phone', width: 1080, height: 1920 },
  { name: 'google-tablet', label: 'Google Tablet', width: 1200, height: 1920 },
] as const;

describe('AssetsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the page title', () => {
    renderRoute(Route);
    expect(screen.getByText('Native Assets')).toBeInTheDocument();
  });

  it('sizes the page to its container, not the viewport', () => {
    renderRoute(Route);
    // min-h-full, not min-h-dvh: the root route's h-dvh banner-row layout owns
    // the viewport height; the page fills the flex-1 content region below the
    // app-wide banner.
    const page = screen.getByText('Native Assets').parentElement?.parentElement;
    expect(page).toHaveClass('min-h-full');
  });

  it('renders the asset count', () => {
    renderRoute(Route);
    expect(screen.getByText(`${String(ASSET_DEFINITIONS.length)} assets`)).toBeInTheDocument();
  });

  it('renders a card for each asset definition', () => {
    renderRoute(Route);
    for (const asset of ASSET_DEFINITIONS) {
      expect(screen.getByTestId(TEST_ID_BUILDERS.assetCard(asset.name))).toBeInTheDocument();
    }
  });

  it('shows asset labels', () => {
    renderRoute(Route);
    for (const asset of ASSET_DEFINITIONS) {
      expect(screen.getByText(asset.label)).toBeInTheDocument();
    }
  });

  it('shows asset dimensions inside each card', () => {
    renderRoute(Route);
    for (const asset of ASSET_DEFINITIONS) {
      const card = screen.getByTestId(TEST_ID_BUILDERS.assetCard(asset.name));
      expect(card).toHaveTextContent(`${String(asset.width)} × ${String(asset.height)}`);
    }
  });

  it('renders preview images from generated PNGs', () => {
    renderRoute(Route);
    for (const asset of ASSET_DEFINITIONS) {
      const img = screen.getByTestId(TEST_ID_BUILDERS.assetPreview(asset.name));
      expect(img.tagName).toBe('IMG');
      expect(img).toHaveAttribute('src', `/dev-assets/${asset.name}.png`);
    }
  });

  it('renders "Open component" links to render routes for each asset', () => {
    renderRoute(Route);
    for (const asset of ASSET_DEFINITIONS) {
      const link = screen.getByTestId(TEST_ID_BUILDERS.assetLink(asset.name));
      expect(link).toHaveAttribute('href', `/dev/render-asset/${asset.name}`);
      expect(link).toHaveTextContent('Open component');
    }
  });

  it('renders "Open image" buttons for each asset', () => {
    renderRoute(Route);
    for (const asset of ASSET_DEFINITIONS) {
      const card = screen.getByTestId(TEST_ID_BUILDERS.assetCard(asset.name));
      const button = card.querySelector(
        `[data-testid="${TEST_ID_BUILDERS.assetOpenImage(asset.name)}"]`
      );
      expect(button).not.toBeNull();
      expect(button).toHaveTextContent('Open image');
    }
  });

  it('defines exactly 7 assets', () => {
    expect(ASSET_DEFINITIONS).toHaveLength(7);
  });

  it('includes icon assets at 1024x1024', () => {
    const iconAssets = ASSET_DEFINITIONS.filter((a) => a.width === 1024);
    expect(iconAssets).toHaveLength(3);
    for (const asset of iconAssets) {
      expect(asset.height).toBe(1024);
    }
  });

  it('includes splash assets at 2732x2732', () => {
    const splashAssets = ASSET_DEFINITIONS.filter((a) => a.width === 2732);
    expect(splashAssets).toHaveLength(2);
    for (const asset of splashAssets) {
      expect(asset.height).toBe(2732);
    }
  });

  it('includes social banner assets at 1500x500', () => {
    const bannerAssets = ASSET_DEFINITIONS.filter((a) => a.width === 1500);
    expect(bannerAssets).toHaveLength(2);
    for (const asset of bannerAssets) {
      expect(asset.height).toBe(500);
    }
  });

  it('renders the Store Screenshots heading', () => {
    renderRoute(Route);
    expect(screen.getByText('Store Screenshots')).toBeInTheDocument();
  });

  it('defines exactly 6 screenshots', () => {
    expect(SCREENSHOT_DEFINITIONS).toHaveLength(6);
  });

  it('defines exactly 4 resolutions', () => {
    expect(RESOLUTION_DEFINITIONS).toHaveLength(4);
  });

  it('renders resolution group headings', () => {
    renderRoute(Route);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      expect(screen.getByText(resolution.label)).toBeInTheDocument();
    }
  });

  it('renders screenshot cards for each resolution and screenshot', () => {
    renderRoute(Route);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      for (const screenshot of SCREENSHOT_DEFINITIONS) {
        expect(
          screen.getByTestId(TEST_ID_BUILDERS.screenshotCard(resolution.name, screenshot.name))
        ).toBeInTheDocument();
      }
    }
  });

  it('renders screenshot images with correct src paths', () => {
    renderRoute(Route);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      for (const screenshot of SCREENSHOT_DEFINITIONS) {
        const card = screen.getByTestId(
          TEST_ID_BUILDERS.screenshotCard(resolution.name, screenshot.name)
        );
        const img = card.querySelector('img');
        expect(img).not.toBeNull();
        expect(img).toHaveAttribute(
          'src',
          `/dev-assets/screenshots/${resolution.name}/${screenshot.name}.png`
        );
      }
    }
  });

  it('shows resolution dimensions in each group', () => {
    renderRoute(Route);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      const group = screen.getByTestId(TEST_ID_BUILDERS.resolutionGroup(resolution.name));
      expect(group).toHaveTextContent(`${String(resolution.width)} × ${String(resolution.height)}`);
    }
  });

  it('renders "Open image" buttons for each screenshot card', () => {
    renderRoute(Route);
    for (const resolution of RESOLUTION_DEFINITIONS) {
      for (const screenshot of SCREENSHOT_DEFINITIONS) {
        const card = screen.getByTestId(
          TEST_ID_BUILDERS.screenshotCard(resolution.name, screenshot.name)
        );
        const button = card.querySelector(
          `[data-testid="${TEST_ID_BUILDERS.screenshotOpenImage(resolution.name, screenshot.name)}"]`
        );
        expect(button).not.toBeNull();
        expect(button).toHaveTextContent('Open image');
      }
    }
  });

  it('opens image preview dialog when asset "Open image" is clicked', async () => {
    const user = userEvent.setup();
    renderRoute(Route);
    const firstAsset = ASSET_DEFINITIONS[0];
    const button = screen.getByTestId(TEST_ID_BUILDERS.assetOpenImage(firstAsset.name));
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const img = dialog.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute('src', `/dev-assets/${firstAsset.name}.png`);
  });

  it('opens image preview dialog when screenshot "Open image" is clicked', async () => {
    const user = userEvent.setup();
    renderRoute(Route);
    const firstResolution = RESOLUTION_DEFINITIONS[0];
    const firstScreenshot = SCREENSHOT_DEFINITIONS[0];
    const button = screen.getByTestId(
      TEST_ID_BUILDERS.screenshotOpenImage(firstResolution.name, firstScreenshot.name)
    );
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    const img = dialog.querySelector('img');
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute(
      'src',
      `/dev-assets/screenshots/${firstResolution.name}/${firstScreenshot.name}.png`
    );
  });

  it('shows image label in the dialog title', async () => {
    const user = userEvent.setup();
    renderRoute(Route);
    const firstAsset = ASSET_DEFINITIONS[0];
    const button = screen.getByTestId(TEST_ID_BUILDERS.assetOpenImage(firstAsset.name));
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(firstAsset.label);
  });

  it('does not show image preview dialog initially', () => {
    renderRoute(Route);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
