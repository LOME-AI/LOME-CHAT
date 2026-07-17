import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { seedUUID } from './lib/seed-uuid.js';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export const SCREENSHOTS_SEED_NOT_DEFINED_MESSAGE =
  'generate-screenshots: store screenshots are captured from conversations created by db:seed, ' +
  'and seed data for the redesigned schema is not yet defined. Define seed data that creates ' +
  'the screenshot conversations, then update this assertion.';

/**
 * Screenshot capture needs a running dev stack whose database contains the
 * seeded screenshot conversations. db:seed cannot produce them yet (see
 * scripts/seed.ts), so the CLI refuses up front instead of half-running
 * against an unseeded stack and dying mid-capture with a Playwright timeout.
 */
export function assertScreenshotSeedDefined(): void {
  throw new Error(SCREENSHOTS_SEED_NOT_DEFINED_MESSAGE);
}

interface ScreenshotConfig {
  name: string;
  conversationSeedKey: string;
  filename: string;
}

interface ResolutionConfig {
  name: string;
  outputWidth: number;
  outputHeight: number;
  cssWidth: number;
  cssHeight: number;
  dpr: number;
}

/** Screenshot definitions for store listings. */
export function getScreenshotConfigs(): ScreenshotConfig[] {
  return [
    { name: 'chat', conversationSeedKey: 'screenshot-conv-chat', filename: 'chat.png' },
    {
      name: 'model-picker',
      conversationSeedKey: 'screenshot-conv-chat',
      filename: 'model-picker.png',
    },
    {
      name: 'group-chat',
      conversationSeedKey: 'screenshot-conv-group-chat',
      filename: 'group-chat.png',
    },
    {
      name: 'document-code',
      conversationSeedKey: 'screenshot-conv-code',
      filename: 'document-code.png',
    },
    {
      name: 'document-mermaid',
      conversationSeedKey: 'screenshot-conv-mermaid',
      filename: 'document-mermaid.png',
    },
    { name: 'privacy', conversationSeedKey: 'screenshot-conv-privacy', filename: 'privacy.png' },
  ];
}

/** Target resolutions for Apple App Store and Google Play Store. */
export function getResolutionConfigs(): ResolutionConfig[] {
  return [
    {
      name: 'apple-phone',
      outputWidth: 1320,
      outputHeight: 2868,
      cssWidth: 440,
      cssHeight: 956,
      dpr: 3,
    },
    {
      name: 'apple-tablet',
      outputWidth: 2064,
      outputHeight: 2752,
      cssWidth: 1032,
      cssHeight: 1376,
      dpr: 2,
    },
    {
      name: 'google-phone',
      outputWidth: 1080,
      outputHeight: 1920,
      cssWidth: 360,
      cssHeight: 640,
      dpr: 3,
    },
    {
      name: 'google-tablet',
      outputWidth: 1200,
      outputHeight: 1920,
      cssWidth: 600,
      cssHeight: 960,
      dpr: 2,
    },
  ];
}

/** Path where generated screenshot PNGs are saved (committed to git). */
export function getScreenshotOutputPath(
  rootDir: string,
  resolution: string,
  filename: string
): string {
  return path.join(
    rootDir,
    'apps',
    'web',
    'resources',
    'assets',
    'screenshots',
    resolution,
    filename
  );
}

const DEV_SERVER_URL = 'http://localhost:5173';
const MESSAGE_LIST_TIMEOUT = 15_000;

/** Ensure output directories exist for all resolutions. */
function ensureScreenshotDirectories(rootDir: string, resolutionConfigs: ResolutionConfig[]): void {
  for (const resolution of resolutionConfigs) {
    mkdirSync(
      path.join(rootDir, 'apps', 'web', 'resources', 'assets', 'screenshots', resolution.name),
      { recursive: true }
    );
  }
}

/** Capture a single screenshot at one resolution: open page, setup, screenshot, copy, close. */
async function captureScreenshot(
  browser: import('playwright').Browser,
  options: {
    rootDir: string;
    storageStatePath: string;
    resolution: ResolutionConfig;
    conversationId: string;
    screenshot: ScreenshotConfig;
  }
): Promise<void> {
  const { rootDir, storageStatePath, resolution, conversationId, screenshot } = options;

  const context = await browser.newContext({
    storageState: storageStatePath,
    viewport: { width: resolution.cssWidth, height: resolution.cssHeight },
    deviceScaleFactor: resolution.dpr,
    // Make `(pointer: coarse)` match so useIsTouchDevice() returns true and
    // overlays render as bottom sheets instead of desktop dialogs.
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();

  await page.goto(`${DEV_SERVER_URL}/chat/${conversationId}`, {
    waitUntil: 'networkidle',
  });

  await waitForChatMessages(page);
  await runScreenshotSetup(page, screenshot.name);

  const outputPath = getScreenshotOutputPath(rootDir, resolution.name, screenshot.filename);
  await page.screenshot({ path: outputPath, fullPage: false });

  await context.close();
  console.log(`  -> ${resolution.name}/${screenshot.filename}`);
}

/**
 * Wait for the chat message list to be visible, with diagnostic output on failure.
 * Logs the page URL and visible data-testid attributes to identify the failure mode.
 */
async function waitForChatMessages(page: import('playwright').Page): Promise<void> {
  try {
    await page.getByRole('log', { name: 'Chat messages' }).waitFor({
      state: 'visible',
      timeout: MESSAGE_LIST_TIMEOUT,
    });
  } catch (error: unknown) {
    const url = page.url();
    const testIds = await page
      .locator('[data-testid]')
      // eslint-disable-next-line unicorn/prefer-dom-node-dataset -- browser context inside evaluateAll; no DOM types in scripts tsconfig
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    console.error(`  Page URL: ${url}`);
    console.error(`  Visible testids: ${testIds.join(', ')}`);
    throw error;
  }
}

/**
 * Authenticate as alice via persona card and save storage state.
 * Returns the path to the saved storage state file.
 */
async function authenticateAsAlice(
  browser: import('playwright').Browser,
  temporaryDir: string
): Promise<string> {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${DEV_SERVER_URL}/dev/personas`);
  await page.locator('[data-testid="persona-card-alice"]').click();
  await page.waitForURL(/\/chat/, { timeout: 30_000 });

  // Wait for app stability
  await page.locator('[data-app-stable="true"]').waitFor({ state: 'visible', timeout: 15_000 });

  const storageStatePath = path.join(temporaryDir, 'alice-storage-state.json');
  await context.storageState({ path: storageStatePath });
  await context.close();

  return storageStatePath;
}

/**
 * Setup actions for each screenshot type.
 * These run after navigating to the conversation URL.
 */
async function scrollChatToTop(page: import('playwright').Page): Promise<void> {
  // The role=log wrapper is not the scroller — Virtuoso's viewport is the
  // inner [data-slot="scroll-area-viewport"] div (see message-list.tsx Scroller).
  const viewport = page
    .getByRole('log', { name: 'Chat messages' })
    .locator('[data-slot="scroll-area-viewport"]');
  await viewport.evaluate((el: { scrollTop: number }) => {
    el.scrollTop = 0;
  });
  // Let Virtuoso settle after the scroll before the screenshot is taken.
  await page.waitForTimeout(100);
}

async function runScreenshotSetup(
  page: import('playwright').Page,
  screenshotName: string
): Promise<void> {
  /* v8 ignore next -- the default is unreachable: every screenshot config name maps to a case above */
  switch (screenshotName) {
    case 'chat':
    case 'privacy': {
      await page
        .locator('[data-role="assistant"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await scrollChatToTop(page);
      break;
    }
    case 'model-picker': {
      await page
        .locator('[data-role="assistant"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await scrollChatToTop(page);
      await page.locator('[data-testid="model-selector-button"]').click();
      await page
        .locator('[data-testid="model-selector-modal"]')
        .waitFor({ state: 'visible', timeout: 10_000 });
      // Wait for fade-in + zoom-in animation to complete
      await page.waitForTimeout(300);
      break;
    }
    case 'group-chat': {
      await page
        .locator('[data-testid="sender-label"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await scrollChatToTop(page);
      break;
    }
    case 'document-code': {
      await page
        .locator('[data-testid="document-card"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('[data-testid="document-card"]').first().click();
      await page
        .locator('[data-testid="document-panel"]')
        .waitFor({ state: 'visible', timeout: 10_000 });
      break;
    }
    case 'document-mermaid': {
      await page
        .locator('[data-testid="document-card"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('[data-testid="document-card"]').first().click();
      await page
        .locator('[data-testid="document-panel"]')
        .waitFor({ state: 'visible', timeout: 10_000 });
      // Wait for mermaid to finish rendering (replaces "Loading diagram..." placeholder)
      await page
        .locator('[data-testid="mermaid-diagram"]')
        .waitFor({ state: 'visible', timeout: 15_000 });
      break;
    }
    default: {
      break;
    }
  }
}

/**
 * Generate all store screenshots using Playwright.
 * Requires the full dev stack running: Vite + Wrangler + DB with seed data.
 */
export async function generateScreenshots(rootDir: string): Promise<void> {
  const { chromium } = await import('playwright');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const screenshotConfigs = getScreenshotConfigs();
  const resolutionConfigs = getResolutionConfigs();

  ensureScreenshotDirectories(rootDir, resolutionConfigs);

  const browser = await chromium.launch();
  const temporaryDir = mkdtempSync(path.join(tmpdir(), 'hushbox-screenshots-'));

  try {
    console.log('Authenticating as alice...');
    const storageStatePath = await authenticateAsAlice(browser, temporaryDir);
    console.log('Authenticated.');

    for (const screenshot of screenshotConfigs) {
      const conversationId = seedUUID(screenshot.conversationSeedKey);

      for (const resolution of resolutionConfigs) {
        console.log(
          `Capturing ${screenshot.name} at ${resolution.name} (${String(resolution.outputWidth)}x${String(resolution.outputHeight)} @ ${String(resolution.dpr)}x)...`
        );

        await captureScreenshot(browser, {
          rootDir,
          storageStatePath,
          resolution,
          conversationId,
          screenshot,
        });
      }
    }
  } finally {
    await browser.close();
  }

  console.log(
    `Generated ${String(screenshotConfigs.length * resolutionConfigs.length)} screenshots`
  );
}

/**
 * Generate a single screenshot across all resolutions.
 */
export async function generateSingleScreenshot(
  rootDir: string,
  screenshotName: string
): Promise<void> {
  const { chromium } = await import('playwright');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const screenshotConfigs = getScreenshotConfigs();
  const config = screenshotConfigs.find((c) => c.name === screenshotName);
  if (!config) {
    throw new Error(`Unknown screenshot: ${screenshotName}`);
  }

  const resolutionConfigs = getResolutionConfigs();

  ensureScreenshotDirectories(rootDir, resolutionConfigs);

  const browser = await chromium.launch();
  const temporaryDir = mkdtempSync(path.join(tmpdir(), 'hushbox-screenshots-'));

  try {
    const storageStatePath = await authenticateAsAlice(browser, temporaryDir);
    const conversationId = seedUUID(config.conversationSeedKey);

    for (const resolution of resolutionConfigs) {
      console.log(
        `Capturing ${config.name} at ${resolution.name} (${String(resolution.cssWidth)}x${String(resolution.cssHeight)})...`
      );

      await captureScreenshot(browser, {
        rootDir,
        storageStatePath,
        resolution,
        conversationId,
        screenshot: config,
      });
    }
  } finally {
    await browser.close();
  }

  console.log(`Generated ${config.name} at ${String(resolutionConfigs.length)} resolutions`);
}

/* v8 ignore start -- CLI wiring; fail-fast behavior covered via the execa entry-point tests */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    assertScreenshotSeedDefined();
    const screenshotName = process.argv[2];
    const rootDir = process.cwd();
    await (screenshotName
      ? generateSingleScreenshot(rootDir, screenshotName)
      : generateScreenshots(rootDir));
  });
}
/* v8 ignore stop */
