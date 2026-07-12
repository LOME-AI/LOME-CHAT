/**
 * Scene 5 UI capture — drives the real app's /demo mode through the Phase 3
 * demo beats and records phone-shaped video plus the ground-truth action log
 * that powers the Remotion zoom/pan and cursor sprite.
 *
 * Run (dev stack must be up: `pnpm dev`):
 *   node_modules/.bin/tsx ads/2026-07-hq-tour/03-screen-capture/capture.ts demo
 *   node_modules/.bin/tsx ads/2026-07-hq-tour/03-screen-capture/capture.ts static
 *
 * `demo`   = the cursor take: dropdown → model switch → prompt → stream-in.
 * `static` = the composite safety take: no cursor movement, streaming only.
 *
 * Captures run WITHOUT VITE_E2E on purpose — the app's animations (including
 * the model-switch View Transition) are part of the ad. Determinism comes
 * from waiting on the app's own readiness signals, never from sleeps around
 * state changes.
 */
import { renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEST_IDS } from '@hushbox/shared';
import { startPhoneCapture } from '../../tools/capture/index.js';
import type { Page } from '@playwright/test';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_URL = 'http://localhost:5173/demo';

/** Written-for-the-ad prompt — evocative, private, tasteful; it flashes by. */
const DEMO_PROMPT = "Draft a resignation letter I'm not ready to send.";

const STREAM_SETTLE_MS = 800;

async function waitForAppReady(page: Page): Promise<void> {
  // `data-app-stable` exists only on the /chat index route, not /demo — ready
  // here means the message list is rendered with at least one message in it.
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

  await waitForAppReady(page);
  logger.mark('beat1-conversation-open');
  await page.waitForTimeout(1200);

  // Beat 2: open the model switcher (auto-zoom target — the click is logged).
  await mouse.clickTestId(TEST_IDS.modelSelectorButton);
  await page.getByTestId(TEST_IDS.modelSelectorModal).waitFor({ timeout: 10_000 });
  logger.mark('beat2-model-modal-open');
  await page.waitForTimeout(600);

  // Beat 3: switch to a different model — the second row, whatever it is
  // (rows are `model-item-<id>`; the seeded demo decides the catalog).
  const rows = page.getByTestId(/^model-item-/);
  const target = rows.nth(1);
  const box = await target.boundingBox();
  if (!box) throw new Error('model rows not visible in selector modal');
  await mouse.moveTo(box.x + box.width / 2, box.y + box.height / 2, 'model-item-switch');
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.up();
  logger.log('click', box.x + box.width / 2, box.y + box.height / 2, 'model-item-switch');
  await page.getByTestId(TEST_IDS.modelSelectorModal).waitFor({ state: 'hidden', timeout: 10_000 });
  logger.mark('beat3-model-switched');

  // Beat 4: prompt → send → the new model's reply streams in.
  await mouse.clickTestId(TEST_IDS.promptInput);
  await page.keyboard.type(DEMO_PROMPT, { delay: 34 });
  await mouse.clickTestId(TEST_IDS.sendButton);
  logger.mark('beat4-stream-start');
  await waitForStreamComplete(page);
  logger.mark('beat4-stream-complete');

  // Beat 5: final hold — encryption badge and message cost both on screen.
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
  const session = await startPhoneCapture(APP_URL, OUT_DIR);
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
