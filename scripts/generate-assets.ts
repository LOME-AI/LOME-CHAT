import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { TEST_IDS } from '@hushbox/shared';
import { isMainModule } from './lib/is-main.js';

interface AssetConfig {
  name: string;
  filename: string;
  renderUrl: string;
  outputWidth: number;
  outputHeight: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
  /** Repo-relative directory segments the PNG is written to (committed to git). */
  outputDir: readonly string[];
  /**
   * When set, the capture waits for this selector before screenshotting. The
   * social banner embeds the live demo in an iframe and only renders this marker
   * once the demo posts `hb-demo-ready`, so the shot is never half-painted.
   */
  readySelector?: string;
}

/** Native mobile assets (app icons, splash screens). */
const NATIVE_ASSET_DIR = ['apps', 'web', 'resources', 'assets'] as const;
/** Brand/social assets, alongside the marketing OG image. */
const SOCIAL_BANNER_DIR = ['apps', 'marketing', 'public', 'social'] as const;
const SOCIAL_BANNER_READY = `[data-testid="${TEST_IDS.socialBannerReady}"]`;

/** Asset definitions matching the React components in native-assets/. */
export function getAssetConfigs(): AssetConfig[] {
  return [
    {
      name: 'icon-only',
      filename: 'icon-only.png',
      renderUrl: '/dev/render-asset/icon-only',
      outputWidth: 1024,
      outputHeight: 1024,
      cssWidth: 512,
      cssHeight: 512,
      dpr: 2,
      outputDir: NATIVE_ASSET_DIR,
    },
    {
      name: 'icon-background',
      filename: 'icon-background.png',
      renderUrl: '/dev/render-asset/icon-background',
      outputWidth: 1024,
      outputHeight: 1024,
      cssWidth: 512,
      cssHeight: 512,
      dpr: 2,
      outputDir: NATIVE_ASSET_DIR,
    },
    {
      name: 'icon-foreground',
      filename: 'icon-foreground.png',
      renderUrl: '/dev/render-asset/icon-foreground',
      outputWidth: 1024,
      outputHeight: 1024,
      cssWidth: 512,
      cssHeight: 512,
      dpr: 2,
      outputDir: NATIVE_ASSET_DIR,
    },
    {
      name: 'splash-dark',
      filename: 'splash-dark.png',
      renderUrl: '/dev/render-asset/splash-dark',
      outputWidth: 2732,
      outputHeight: 2732,
      cssWidth: 1366,
      cssHeight: 1366,
      dpr: 2,
      outputDir: NATIVE_ASSET_DIR,
    },
    {
      name: 'splash',
      filename: 'splash.png',
      renderUrl: '/dev/render-asset/splash',
      outputWidth: 2732,
      outputHeight: 2732,
      cssWidth: 1366,
      cssHeight: 1366,
      dpr: 2,
      outputDir: NATIVE_ASSET_DIR,
    },
    {
      // Social profile banner (X + Bluesky), 1500x500 (3:1). Rendered 1:1 (DPR 1)
      // so the design space is the final pixel space and the embedded demo iframe
      // reports its own mobile viewport.
      name: 'social-banner',
      filename: 'social-banner.png',
      renderUrl: '/dev/render-asset/social-banner',
      outputWidth: 1500,
      outputHeight: 500,
      cssWidth: 1500,
      cssHeight: 500,
      dpr: 1,
      outputDir: SOCIAL_BANNER_DIR,
      readySelector: SOCIAL_BANNER_READY,
    },
    {
      name: 'social-banner-dark',
      filename: 'social-banner-dark.png',
      renderUrl: '/dev/render-asset/social-banner-dark',
      outputWidth: 1500,
      outputHeight: 500,
      cssWidth: 1500,
      cssHeight: 500,
      dpr: 1,
      outputDir: SOCIAL_BANNER_DIR,
      readySelector: SOCIAL_BANNER_READY,
    },
  ];
}

/** Path where a generated PNG is saved (committed to git). */
export function getOutputPath(
  rootDir: string,
  config: Pick<AssetConfig, 'outputDir' | 'filename'>
): string {
  return path.join(rootDir, ...config.outputDir, config.filename);
}

const DEV_SERVER_URL = 'http://localhost:5173';

/** Ensure the output directory of each given asset exists. */
function ensureAssetDirectories(rootDir: string, configs: AssetConfig[]): void {
  const directories = new Set(configs.map((config) => path.join(rootDir, ...config.outputDir)));
  for (const directory of directories) {
    mkdirSync(directory, { recursive: true });
  }
}

/** Render a single asset: open page, wait for readiness, screenshot, close. */
async function captureAsset(
  browser: import('playwright').Browser,
  rootDir: string,
  config: AssetConfig
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: config.cssWidth, height: config.cssHeight },
    deviceScaleFactor: config.dpr,
  });
  const page = await context.newPage();

  await page.goto(`${DEV_SERVER_URL}${config.renderUrl}`, {
    waitUntil: 'networkidle',
  });

  if (config.readySelector !== undefined) {
    // The ready marker is an empty `hidden` element, so it never becomes
    // "visible"; wait for it to be attached to the DOM instead.
    await page.waitForSelector(config.readySelector, { state: 'attached' });
  }

  const outputPath = getOutputPath(rootDir, config);
  await page.screenshot({ path: outputPath, fullPage: false });

  await context.close();
}

/**
 * Generate all native asset PNGs using Playwright.
 * Requires the Vite dev server to be running on port 5173.
 */
export async function generateAssets(rootDir: string): Promise<void> {
  // Dynamic import to avoid pulling Playwright into the bundle for non-generation scripts
  const { chromium } = await import('playwright');

  const configs = getAssetConfigs();

  ensureAssetDirectories(rootDir, configs);

  const browser = await chromium.launch();

  try {
    for (const config of configs) {
      console.log(
        `Generating ${config.filename} (${String(config.outputWidth)}x${String(config.outputHeight)} @ ${String(config.dpr)}x)...`
      );

      await captureAsset(browser, rootDir, config);
      console.log(`  -> ${config.filename}`);
    }
  } finally {
    await browser.close();
  }

  console.log(`Generated ${String(configs.length)} assets`);
}

/**
 * Generate a single asset by name. Used for file-watcher incremental updates.
 */
export async function generateSingleAsset(rootDir: string, assetName: string): Promise<void> {
  const configs = getAssetConfigs();
  const config = configs.find((c) => c.name === assetName);
  if (!config) {
    throw new Error(`Unknown asset: ${assetName}`);
  }

  const { chromium } = await import('playwright');

  ensureAssetDirectories(rootDir, [config]);

  const browser = await chromium.launch();

  try {
    await captureAsset(browser, rootDir, config);
  } finally {
    await browser.close();
  }

  console.log(`Generated ${config.filename}`);
}

/* v8 ignore start -- CLI wiring; the flows are covered via unit tests with a mocked playwright */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  const assetName = process.argv[2];
  const rootDir = process.cwd();
  const action = assetName ? generateSingleAsset(rootDir, assetName) : generateAssets(rootDir);
  try {
    await action;
  } catch (error: unknown) {
    console.error('Asset generation failed:', error);
    process.exit(1);
  }
}
/* v8 ignore stop */
