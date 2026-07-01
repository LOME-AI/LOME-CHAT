import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { renderRoute } from '@/test-utils/render';
import { Route } from './dev.render-asset.$name';

const { mockUseParams } = vi.hoisted(() => ({
  mockUseParams: vi.fn<() => { name: string }>(),
}));

// Keep the real router (createFileRoute must run for the route file); mock only useParams.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useParams: () => mockUseParams(),
  };
});

mockLogoImport();

// Keep the real @hushbox/ui (renderRoute needs its providers); CipherWall uses
// the Canvas API, unavailable in jsdom, so override only that export.
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    CipherWall: (props: Record<string, unknown>): React.JSX.Element => (
      <canvas data-testid={TEST_IDS.cipherWall} data-props={JSON.stringify(props)} />
    ),
  };
});

describe('RenderAssetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders app-icon component when name is "icon-only"', () => {
    mockUseParams.mockReturnValue({ name: 'icon-only' });
    renderRoute(Route);
    expect(screen.getByTestId(TEST_IDS.appIcon)).toBeInTheDocument();
  });

  it('renders icon-background component when name is "icon-background"', () => {
    mockUseParams.mockReturnValue({ name: 'icon-background' });
    renderRoute(Route);
    expect(screen.getByTestId(TEST_IDS.iconBackground)).toBeInTheDocument();
  });

  it('renders icon-foreground component when name is "icon-foreground"', () => {
    mockUseParams.mockReturnValue({ name: 'icon-foreground' });
    renderRoute(Route);
    expect(screen.getByTestId(TEST_IDS.iconForeground)).toBeInTheDocument();
  });

  it('renders splash-dark component when name is "splash-dark"', () => {
    mockUseParams.mockReturnValue({ name: 'splash-dark' });
    renderRoute(Route);
    expect(screen.getByTestId(TEST_ID_BUILDERS.splash('dark'))).toBeInTheDocument();
  });

  it('renders splash-light component when name is "splash"', () => {
    mockUseParams.mockReturnValue({ name: 'splash' });
    renderRoute(Route);
    expect(screen.getByTestId(TEST_ID_BUILDERS.splash('light'))).toBeInTheDocument();
  });

  it('renders social-banner-light component when name is "social-banner"', () => {
    mockUseParams.mockReturnValue({ name: 'social-banner' });
    renderRoute(Route);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('light'))).toBeInTheDocument();
  });

  it('renders social-banner-dark component when name is "social-banner-dark"', () => {
    mockUseParams.mockReturnValue({ name: 'social-banner-dark' });
    renderRoute(Route);
    expect(screen.getByTestId(TEST_ID_BUILDERS.socialBanner('dark'))).toBeInTheDocument();
  });

  it('renders error message for unknown asset name', () => {
    mockUseParams.mockReturnValue({ name: 'nonexistent' });
    renderRoute(Route);
    expect(screen.getByText(/unknown asset/i)).toBeInTheDocument();
  });

  it('renders with no margin or padding on the wrapper', () => {
    mockUseParams.mockReturnValue({ name: 'icon-only' });
    renderRoute(Route);
    const wrapper = screen.getByTestId(TEST_IDS.renderAssetWrapper);
    expect(wrapper).toHaveClass('m-0', 'p-0');
  });

  it('hides overflow on wrapper so Playwright captures exact dimensions', () => {
    mockUseParams.mockReturnValue({ name: 'splash-dark' });
    renderRoute(Route);
    const wrapper = screen.getByTestId(TEST_IDS.renderAssetWrapper);
    expect(wrapper).toHaveClass('overflow-hidden');
  });
});
