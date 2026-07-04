import * as React from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { ROUTES, TEST_ID_BUILDERS } from '@hushbox/shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@hushbox/ui';
import { env } from '@/lib/env';

export const Route = createFileRoute('/dev/assets')({
  beforeLoad: () => {
    if (!env.isDev) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: AssetsPage,
});

interface AssetDefinition {
  name: string;
  label: string;
  width: number;
  height: number;
}

// Asset names must match ASSET_MAP in dev.render-asset.$name.tsx
const ASSET_DEFINITIONS: readonly AssetDefinition[] = [
  { name: 'icon-only', label: 'App Icon', width: 1024, height: 1024 },
  { name: 'icon-background', label: 'Icon Background', width: 1024, height: 1024 },
  { name: 'icon-foreground', label: 'Icon Foreground', width: 1024, height: 1024 },
  { name: 'splash-dark', label: 'Splash (Dark)', width: 2732, height: 2732 },
  { name: 'splash', label: 'Splash (Light)', width: 2732, height: 2732 },
  { name: 'social-banner', label: 'Social Banner (Light)', width: 1500, height: 500 },
  { name: 'social-banner-dark', label: 'Social Banner (Dark)', width: 1500, height: 500 },
] as const;

interface ScreenshotDefinition {
  name: string;
  label: string;
}

interface ResolutionDefinition {
  name: string;
  label: string;
  width: number;
  height: number;
}

const SCREENSHOT_DEFINITIONS: readonly ScreenshotDefinition[] = [
  { name: 'chat', label: 'Chat' },
  { name: 'model-picker', label: 'Model Picker' },
  { name: 'group-chat', label: 'Group Chat' },
  { name: 'document-code', label: 'Document (Code)' },
  { name: 'document-mermaid', label: 'Document (Mermaid)' },
  { name: 'privacy', label: 'Privacy' },
] as const;

const RESOLUTION_DEFINITIONS: readonly ResolutionDefinition[] = [
  { name: 'apple-phone', label: 'Apple iPhone (6.9")', width: 1320, height: 2868 },
  { name: 'apple-tablet', label: 'Apple iPad (13")', width: 2064, height: 2752 },
  { name: 'google-phone', label: 'Google Phone', width: 1080, height: 1920 },
  { name: 'google-tablet', label: 'Google Tablet', width: 1200, height: 1920 },
] as const;

interface PreviewImage {
  src: string;
  label: string;
}

function AssetsPage(): React.JSX.Element {
  const [previewImage, setPreviewImage] = React.useState<PreviewImage | null>(null);

  return (
    <div className="bg-background min-h-full p-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-foreground mb-2 text-3xl font-bold">Native Assets</h1>
        <p className="text-muted-foreground mb-8 text-sm">{ASSET_DEFINITIONS.length} assets</p>

        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {ASSET_DEFINITIONS.map((asset) => (
            <div
              key={asset.name}
              data-testid={TEST_ID_BUILDERS.assetCard(asset.name)}
              className="border-border bg-card overflow-hidden rounded-lg border"
            >
              <div className="bg-muted flex aspect-square items-center justify-center">
                {/* eslint-disable-next-line no-restricted-syntax -- dev-only asset preview page; intentionally renders raw <img> to show source assets */}
                <img
                  data-testid={TEST_ID_BUILDERS.assetPreview(asset.name)}
                  src={`/dev-assets/${asset.name}.png`}
                  alt={asset.label}
                  className="h-full w-full object-contain"
                />
              </div>
              <div className="p-4">
                <h2 className="text-foreground text-sm font-semibold">{asset.label}</h2>
                <p className="text-muted-foreground text-xs">
                  {asset.width} × {asset.height}
                </p>
                <div className="mt-2 flex gap-3">
                  <a
                    href={`/dev/render-asset/${asset.name}`}
                    data-testid={TEST_ID_BUILDERS.assetLink(asset.name)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary text-xs hover:underline"
                  >
                    Open component
                  </a>
                  <button
                    type="button"
                    data-testid={TEST_ID_BUILDERS.assetOpenImage(asset.name)}
                    className="text-primary text-xs hover:underline"
                    onClick={() => {
                      setPreviewImage({
                        src: `/dev-assets/${asset.name}.png`,
                        label: asset.label,
                      });
                    }}
                  >
                    Open image
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="border-border mt-12 border-t pt-8">
          <h2 className="text-foreground mb-6 text-2xl font-bold">Store Screenshots</h2>

          {RESOLUTION_DEFINITIONS.map((resolution) => (
            <div
              key={resolution.name}
              data-testid={TEST_ID_BUILDERS.resolutionGroup(resolution.name)}
              className="mb-10"
            >
              <h3 className="text-foreground mb-1 text-lg font-semibold">{resolution.label}</h3>
              <p className="text-muted-foreground mb-4 text-xs">
                {resolution.width} × {resolution.height}
              </p>

              <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-6">
                {SCREENSHOT_DEFINITIONS.map((screenshot) => (
                  <div
                    key={screenshot.name}
                    data-testid={TEST_ID_BUILDERS.screenshotCard(resolution.name, screenshot.name)}
                    className="border-border bg-card overflow-hidden rounded-lg border"
                  >
                    <div className="bg-muted aspect-[9/16]">
                      {/* eslint-disable-next-line no-restricted-syntax -- dev-only asset preview page; intentionally renders raw <img> to show source assets */}
                      <img
                        src={`/dev-assets/screenshots/${resolution.name}/${screenshot.name}.png`}
                        alt={`${screenshot.label} — ${resolution.label}`}
                        className="h-full w-full object-contain"
                      />
                    </div>
                    <div className="p-2">
                      <p className="text-foreground text-xs font-medium">{screenshot.label}</p>
                      <button
                        type="button"
                        data-testid={TEST_ID_BUILDERS.screenshotOpenImage(
                          resolution.name,
                          screenshot.name
                        )}
                        className="text-primary mt-1 text-xs hover:underline"
                        onClick={() => {
                          setPreviewImage({
                            src: `/dev-assets/screenshots/${resolution.name}/${screenshot.name}.png`,
                            label: `${screenshot.label} — ${resolution.label}`,
                          });
                        }}
                      >
                        Open image
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <Dialog
        open={previewImage !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewImage(null);
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-[90vw] overflow-auto">
          <DialogHeader>
            <DialogTitle>{previewImage?.label}</DialogTitle>
            <DialogDescription>Generated asset preview</DialogDescription>
          </DialogHeader>
          {previewImage && (
            // eslint-disable-next-line no-restricted-syntax -- dev-only asset preview page; intentionally renders raw <img> to show source assets
            <img
              src={previewImage.src}
              alt={previewImage.label}
              className="h-auto w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
