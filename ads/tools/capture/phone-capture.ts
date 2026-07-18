import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';

import { resolveFfmpeg } from '../media/ffmpeg.js';
import { ActionLogger } from './action-logger.js';
import { buildConcatList, type ConcatFrame } from './encode.js';
import { SmoothMouse } from './smooth-mouse.js';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/** Phone-shaped capture preset: the ad is 9:16 and composites onto a phone. */
export const PHONE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3 } as const;

/** Constant output frame rate, resampled from the variable-rate frame capture. */
const OUTPUT_FPS = 30;

/** Screenshot encoding quality (jpeg, 0–100); the encode re-compresses to VP8. */
const FRAME_QUALITY = 92;

/**
 * Screenshot output scale (× CSS pixels). At device resolution (3 → 1170×2532)
 * each frame is ~60ms, capping real-time capture at ~16 distinct fps; 2 →
 * 780×1688 at ~35ms sustains ~28 distinct fps. 2 trades some crispness for
 * near-OUTPUT_FPS real-time motion. The page still renders at DSR 3, so the 2×
 * output is a downsample of a retina surface (sharper than a native-2× render).
 */
const CAPTURE_SCALE = 2;

/** How long the last captured frame is held on screen (the concat-demuxer tail). */
const FINAL_FRAME_HOLD_MS = 500;

export interface PhoneCaptureSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  mouse: SmoothMouse;
  logger: ActionLogger;
  /**
   * Stops recording, writes the action log, encodes, and returns the video path.
   * Does NOT tear down the browser — always pair it with dispose() in a `finally`.
   */
  finish: (logPath: string) => Promise<string>;
  /**
   * Tears down the browser and deletes the captured frames. Idempotent and safe
   * to call after finish() or on a failed drive — call it from a `finally` so a
   * crash mid-capture never leaves a `.frames-*` directory behind.
   */
  dispose: () => Promise<void>;
}

const FRAME_DIR_PREFIX = '.frames-';

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

function encodeFrames(frames: readonly ConcatFrame[], frameDir: string, outDir: string): string {
  const listPath = path.join(frameDir, 'frames.txt');
  writeFileSync(listPath, buildConcatList(frames, FINAL_FRAME_HOLD_MS));

  const token = path.basename(frameDir).slice(FRAME_DIR_PREFIX.length);
  const video = path.join(outDir, `screencast-${token}.webm`);
  // prettier-ignore
  const args = [
    '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
    '-r', String(OUTPUT_FPS), '-c:v', 'libvpx', '-pix_fmt', 'yuv420p',
    '-crf', '9', '-b:v', '6M', '-auto-alt-ref', '0', video,
  ];
  execFileSync(resolveFfmpeg(), args, { stdio: 'inherit' });
  return video;
}

/**
 * The video is a device-resolution recording of the phone viewport, built from
 * a CDP `Page.captureScreenshot` loop paced to OUTPUT_FPS.
 *
 * Why screenshots, not `recordVideo` or CDP `Page.startScreencast`: both of
 * those capture at the CSS-pixel viewport (390×844) and ignore
 * `deviceScaleFactor` — recordVideo additionally paints into the top-left of a
 * DSR-sized frame and leaves the rest grey. Only screenshots honor DSR; CDP
 * `captureScreenshot` with `clip.scale` (see CAPTURE_SCALE) yields crisp
 * device-scaled frames — the cost per frame (~35ms at scale 2, ~60ms at scale 3)
 * sets the real-time distinct-frame ceiling. The loop captures as fast as it can
 * (capped at OUTPUT_FPS); frame timestamps drive per-frame durations and the
 * encode normalizes to a constant OUTPUT_FPS container (holds duplicated to
 * fill). Frame time zero is aligned to the ActionLogger clock so the Remotion
 * cursor overlay — composited at full fps from the log, not from this video —
 * stays in sync with the recording.
 */
export async function startPhoneCapture(
  appUrl: string,
  outDir: string,
  options: PhoneCaptureOptions = {}
): Promise<PhoneCaptureSession> {
  mkdirSync(outDir, { recursive: true });
  // Sweep frame directories orphaned by a previously hard-killed run (a normal
  // run deletes its own in dispose(), but a SIGKILL skips that).
  for (const entry of readdirSync(outDir)) {
    if (entry.startsWith(FRAME_DIR_PREFIX)) {
      rmSync(path.join(outDir, entry), { recursive: true, force: true });
    }
  }
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: PHONE_VIEWPORT.width, height: PHONE_VIEWPORT.height },
    deviceScaleFactor: PHONE_VIEWPORT.deviceScaleFactor,
    colorScheme: (options.darkTheme ?? true) ? 'dark' : 'light',
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

  const frameDir = path.join(outDir, `${FRAME_DIR_PREFIX}${String(logger.startedAtMs)}`);
  mkdirSync(frameDir, { recursive: true });
  const frames: ConcatFrame[] = [];
  let seq = 0;
  // A holder object (not a `let`) so the loop condition, flipped inside
  // finish()/dispose(), isn't narrowed to an always-truthy constant by flow
  // analysis.
  const control = { recording: true };

  await page.goto(appUrl);

  // Raw CDP captureScreenshot (~35ms at CAPTURE_SCALE 2) skips Playwright's
  // stabilization so mid-animation frames are captured. The frame is written
  // synchronously (cheap relative to the capture) and only then recorded, so a
  // frame is never listed for the encode without its file on disk — and there
  // are no fire-and-forget write promises whose rejection could crash the run.
  const cdp = await context.newCDPSession(page);
  const frameIntervalMs = 1000 / OUTPUT_FPS;
  const captureLoop = (async (): Promise<void> => {
    while (control.recording) {
      const startedMs = Date.now();
      try {
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: FRAME_QUALITY,
          // clip.scale sets the output resolution (CSS size × scale); without a
          // clip, captureScreenshot returns the CSS-pixel viewport (390×844).
          clip: {
            x: 0,
            y: 0,
            width: PHONE_VIEWPORT.width,
            height: PHONE_VIEWPORT.height,
            scale: CAPTURE_SCALE,
          },
        });
        const file = path.join(frameDir, `f${String(seq).padStart(6, '0')}.jpg`);
        seq += 1;
        writeFileSync(file, Buffer.from(data, 'base64'));
        frames.push({ tMs: startedMs - logger.startedAtMs, file });
      } catch {
        // Any capture/write error skips this frame (e.g. an HMR reload
        // mid-shot); a run that captures nothing fails loudly in finish().
      }
      const elapsedMs = Date.now() - startedMs;
      if (elapsedMs < frameIntervalMs) {
        await new Promise((resolve) => {
          setTimeout(resolve, frameIntervalMs - elapsedMs);
        });
      }
    }
  })();

  return {
    browser,
    context,
    page,
    mouse,
    logger,
    finish: async (logPath: string): Promise<string> => {
      control.recording = false;
      await captureLoop;
      if (frames.length === 0) throw new Error('capture produced no frames');
      const video = encodeFrames(frames, frameDir, outDir);
      logger.save(logPath);
      return video;
    },
    dispose: async (): Promise<void> => {
      control.recording = false;
      try {
        await captureLoop;
      } catch {
        // capture loop already settled/failed — proceed to teardown
      }
      try {
        await browser.close();
      } catch {
        // browser already gone
      }
      rmSync(frameDir, { recursive: true, force: true });
    },
  };
}
