/**
 * Scene 5 UI capture — drives the real app's /demo mode through the Phase 3
 * demo beats and records phone-shaped video plus the ground-truth action log
 * that powers the Remotion zoom/pan and cursor sprite.
 *
 * Run (dev stack must be up: `pnpm dev` — Vite :5173, API :8788):
 *   node_modules/.bin/tsx ads/2026-07-hq-tour/03-screen-capture/capture.ts demo
 *   node_modules/.bin/tsx ads/2026-07-hq-tour/03-screen-capture/capture.ts static
 *
 * `demo`   = the cursor take: dropdown → model switch → prompt → stream-in.
 * `static` = the composite safety take: no cursor movement, streaming only.
 *
 * The demo take drives the FROZEN demo (`?frozen=1`): frozen mode installs no
 * autonomous director and no input block, so trusted Playwright keyboard/mouse
 * drive the real composer and picker directly. `fill=1` pre-fills the first
 * scripted turn as a static backdrop and streams the second turn live when the
 * capture sends. The static take keeps using the live director URL, whose
 * autonomous replay is what a cursor-free "streaming only" safety take needs.
 *
 * Captures run WITHOUT VITE_E2E on purpose — the app's animations (including
 * the model-switch View Transition) are part of the ad. Determinism comes
 * from waiting on the app's own readiness signals, never from sleeps around
 * state changes.
 */
import { renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SMART_MODEL_ID, TEST_ID_BUILDERS, TEST_IDS } from '@hushbox/shared';
import { startPhoneCapture } from '../../tools/capture/index.js';
import type { Page } from '@playwright/test';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Web origin the dev stack serves Vite on; override for a non-default port. */
const WEB_ORIGIN = process.env['HB_WEB_ORIGIN'] ?? 'http://localhost:5173';

/**
 * The demo take drives the frozen demo: a static backdrop (first Q&A) with the
 * next turn left to stream live under trusted input. `convo=demo-welcome` is
 * the reused ad conversation, `fill=1` freezes turn 1 as the backdrop, and
 * `scroll=bottom` opens already scrolled to the latest message.
 */
const APP_URL = `${WEB_ORIGIN}/demo?frozen=1&convo=demo-welcome&fill=1&scroll=bottom`;

/** The static safety take rides the live director (autonomous streaming, no cursor). */
const STATIC_APP_URL = `${WEB_ORIGIN}/demo`;

/**
 * CREATIVE PICK — the model the capture switches TO in beat 3.
 *
 * The frozen demo boots its picker on the strongest accessible text model, so
 * this is the "switch" destination. `smart-model` always exists in the catalog
 * (stable id, never pruned), which makes "strongest → let HushBox choose" a
 * robust, always-available default. Change this one line to retarget the switch
 * (any catalog model id) once the founder confirms the creative choice.
 */
const MODEL_SWITCH_TARGET_ID = SMART_MODEL_ID;

/**
 * The second scripted turn's question. `fill=1` holds turn 1 as the backdrop
 * and streams turn 2 live; typing the scripted question keeps the on-screen
 * composer text in sync with the reply the frozen mock replays.
 */
const DEMO_PROMPT = "If it's encrypted, how can the AI still read my messages?";

const STREAM_SETTLE_MS = 800;

async function waitForAppReady(page: Page): Promise<void> {
  // `data-app-stable` exists only on the /chat index route, not /demo — ready
  // here means the message list is rendered with at least one message in it
  // (the pre-filled backdrop turn).
  await page.getByTestId(TEST_IDS.messageList).waitFor({ timeout: 30_000 });
  await page.getByTestId(TEST_IDS.messageItem).first().waitFor({ timeout: 30_000 });
}

async function waitForStreamComplete(page: Page): Promise<void> {
  const list = page.getByTestId(TEST_IDS.messageList);
  // A stream begins (count > 0), then drains back to zero.
  await list
    .locator('css=[data-streaming-count]:not([data-streaming-count="0"])')
    .waitFor({ timeout: 20_000 })
    .catch(() => {
      // Stream may already have started and finished between checks — fine.
    });
  await page.waitForFunction(
    (testId: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      return el?.dataset['streamingCount'] === '0';
    },
    TEST_IDS.messageList,
    { timeout: 60_000 }
  );
}

async function captureDemoTake(take: number): Promise<void> {
  const session = await startPhoneCapture(APP_URL, OUT_DIR);
  const { page, mouse, logger } = session;

  // Beat 1: hold on the pre-filled backdrop (first Q&A), scrolled to bottom.
  await waitForAppReady(page);
  logger.mark('beat1-conversation-open');
  await page.waitForTimeout(1200);

  // Beat 2: open the model switcher (auto-zoom target — the click is logged).
  await mouse.clickTestId(TEST_IDS.modelSelectorButton);
  await page.getByTestId(TEST_IDS.modelSelectorModal).waitFor({ timeout: 10_000 });
  logger.mark('beat2-model-modal-open');
  await page.waitForTimeout(600);

  // Beat 3: switch to the creative-pick target model (default: Smart Model).
  // Scroll the row into view first so the logged coordinates are its on-screen
  // center even when the target sits below the picker's fold.
  const targetTestId = TEST_ID_BUILDERS.modelItem(MODEL_SWITCH_TARGET_ID);
  const target = page.getByTestId(targetTestId);
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`model-switch target not visible in selector modal: ${targetTestId}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await mouse.moveTo(cx, cy, 'model-item-switch');
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.up();
  logger.log('click', cx, cy, 'model-item-switch');
  await page.getByTestId(TEST_IDS.modelSelectorModal).waitFor({ state: 'hidden', timeout: 10_000 });
  logger.mark('beat3-model-switched');

  // Beat 4: type the second question → send → the selected model's reply
  // streams in live (frozen mode replays the next unfilled scripted turn).
  await mouse.clickTestId(TEST_IDS.promptInput);
  await page.keyboard.type(DEMO_PROMPT, { delay: 34 });
  await mouse.clickTestId(TEST_IDS.sendButton);
  logger.mark('beat4-stream-start');
  await waitForStreamComplete(page);
  logger.mark('beat4-stream-complete');

  // Beat 5: final hold — encryption badge and the now-real message cost both
  // on screen (the demo seeds a real per-turn cost for the streamed reply).
  await page.getByTestId(TEST_IDS.encryptionBadge).waitFor({ timeout: 10_000 });
  await page
    .getByTestId(TEST_IDS.messageCost)
    .last()
    .waitFor({ timeout: 10_000 })
    .catch(() => {
      // Cost may render only for billed turns; the demo seed decides. Logged
      // via the mark below either way — the edit picks the hold frame.
    });
  logger.mark('beat5-final-hold');
  await page.waitForTimeout(1500 + STREAM_SETTLE_MS);

  const video = await session.finish(path.join(OUT_DIR, `demo-take${String(take)}.log.json`));
  renameSync(video, path.join(OUT_DIR, `demo-take${String(take)}.webm`));
  console.warn(`demo take ${String(take)}: video + action log written`);
}

async function captureStaticTake(take: number): Promise<void> {
  const session = await startPhoneCapture(STATIC_APP_URL, OUT_DIR);
  const { page, logger } = session;

  await waitForAppReady(page);
  logger.mark('static-start');
  // No cursor, no interaction: the demo director streams on its own; record
  // a generous window and pick 5 clean seconds in the edit.
  await page.waitForTimeout(9000);
  logger.mark('static-end');

  const video = await session.finish(path.join(OUT_DIR, `static-take${String(take)}.log.json`));
  renameSync(video, path.join(OUT_DIR, `static-take${String(take)}.webm`));
  console.warn(`static take ${String(take)}: video + action log written`);
}

const mode = process.argv[2];
const take = Number(process.argv[3] ?? '1');
if (mode === 'demo') await captureDemoTake(take);
else if (mode === 'static') await captureStaticTake(take);
else throw new Error(`usage: capture.ts <demo|static> [takeNumber] — got "${mode ?? ''}"`);
