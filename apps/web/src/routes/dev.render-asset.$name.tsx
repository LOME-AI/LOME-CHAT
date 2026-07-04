import * as React from 'react';
import { createFileRoute, redirect, useParams } from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import {
  AppIcon,
  IconBackground,
  IconForeground,
  SocialBannerDark,
  SocialBannerLight,
  SplashDark,
  SplashLight,
} from '@/components/native-assets';
import { env } from '@/lib/env';

export const Route = createFileRoute('/dev/render-asset/$name')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: RenderAssetPage,
});

// Asset names must match ASSET_DEFINITIONS in dev.assets.tsx
const ASSET_MAP: Record<string, React.ComponentType> = {
  'icon-only': AppIcon,
  'icon-background': IconBackground,
  'icon-foreground': IconForeground,
  'splash-dark': SplashDark,
  splash: SplashLight,
  'social-banner': SocialBannerLight,
  'social-banner-dark': SocialBannerDark,
};

function RenderAssetPage(): React.JSX.Element {
  const { name } = useParams({ from: '/dev/render-asset/$name' });
  const AssetComponent = ASSET_MAP[name];

  if (!AssetComponent) {
    return (
      <div className="flex h-full items-center justify-center">
        <p>Unknown asset: {name}</p>
      </div>
    );
  }

  return (
    <div data-testid={TEST_IDS.renderAssetWrapper} className="m-0 overflow-hidden p-0">
      <AssetComponent />
    </div>
  );
}
