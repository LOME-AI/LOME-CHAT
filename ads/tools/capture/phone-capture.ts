import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { ActionLogger } from './action-logger.js';
import { SmoothMouse } from './smooth-mouse.js';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/** Phone-shaped capture preset: the ad is 9:16 and composites onto a phone. */
export const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3 } as const;

export interface PhoneCaptureSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  mouse: SmoothMouse;
  logger: ActionLogger;
  /** Stops recording, writes the action log, and returns the video path. */
  finish: (logPath: string) => Promise<string>;
}

export interface PhoneCaptureOptions {
  /** Runs before navigation — init scripts, storage state, etc. */
  beforeNavigate?: (page: Page) => Promise<void>;
  /**
   * Forces the app's dark theme via the `themeMode` localStorage key its
   * pre-paint script reads (theme-provider.tsx). Defaults to true — the ad's
   * visual register is dark.
   */
  darkTheme?: boolean;
}

/**
 * Playwright records at the requested recordVideo size, not at device
 * pixels — crispness of the 3× upscale is a verify-at-first-capture item.
 * If it comes back soft, the fallback is CDP screencast or per-frame
 * screenshots (fully deterministic here, since the script owns all timing).
 */
export async function startPhoneCapture(
  appUrl: string,
  outDir: string,
  options: PhoneCaptureOptions = {}
): Promise<PhoneCaptureSession> {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: PHONE_VIEWPORT.width, height: PHONE_VIEWPORT.height },
    deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
    colorScheme: (options.darkTheme ?? true) ? 'dark' : 'light',
    recordVideo: {
      dir: outDir,
      size: {
        width: PHONE_VIEWPORT.width * PHONE_VIEWPORT.deviceScaleFactor,
        height: PHONE_VIEWPORT.height * PHONE_VIEWPORT.deviceScaleFactor,
      },
    },
  });
  const page = await context.newPage();
  if (options.darkTheme ?? true) {
    await page.addInitScript(() => {
      localStorage.setItem('themeMode', 'dark');
    });
  }
  await options.beforeNavigate?.(page);
  const logger = new ActionLogger({ ...PHONE_VIEWPORT }, '(pending)');
  const mouse = new SmoothMouse(page, logger);
  await page.goto(appUrl);

  return {
    browser,
    context,
    page,
    mouse,
    logger,
    finish: async (logPath: string): Promise<string> => {
      const video = page.video();
      await context.close();
      await browser.close();
      const videoPath = video ? await video.path() : path.join(outDir, 'unknown.webm');
      logger.save(logPath);
      return videoPath;
    },
  };
}
