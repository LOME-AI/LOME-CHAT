import { mkdirSync } from 'node:fs';
import path from 'node:path';
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
}

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
    },
  ];
}

/** Path where generated PNGs are saved (committed to git). */
export function getOutputPath(rootDir: string, filename: string): string {
  return path.join(rootDir, 'apps', 'web', 'resources', 'assets', filename);
}

const DEV_SERVER_URL = 'http://localhost:5173';

/** Ensure output directories exist. */
function ensureAssetDirectories(rootDir: string): void {
  mkdirSync(path.join(rootDir, 'apps', 'web', 'resources', 'assets'), { recursive: true });
}

/** Render a single asset: open page, screenshot, copy to dev-assets, close. */
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

  const outputPath = getOutputPath(rootDir, config.filename);
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

  ensureAssetDirectories(rootDir);

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

  ensureAssetDirectories(rootDir);

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
