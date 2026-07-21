import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../../config/timeouts.js';
import {
  clearAuthRateLimits,
  signUpAndVerify,
  uniqueEmail,
  uniqueUsername,
} from '../../helpers/auth.js';
import { requireEnv } from '../../helpers/env.js';
import { idempotentPost } from '../../helpers/idempotent-request.js';
import { withRequestRetry } from '../../helpers/resilient-request.js';
import { expect } from '../fixtures.js';
import { opFieldInput } from './op-modal.js';
import type { SubmitFeedbackBody } from '@hushbox/shared';
import type {
  APIRequestContext,
  Browser,
  Locator,
  Page,
  PlaywrightWorkerArgs,
} from '@playwright/test';

/**
 * Feedback-triage helpers, mirroring `customer-360.ts`: a product-session
 * seeder (the admin project has no product-session fixture of its own) plus the
 * inbox/detail UI half. Raw element selectors live here, never in specs (rule
 * 3.3).
 *
 * BUDGET WARNING: `GET /admin/feedback` (inbox pages AND the audited detail
 * load) is rate-limited at 240/hr per admin actor, and the reset auto-hook does
 * NOT clear the admin limiter keys (`admin:read:feedback:ratelimit:*` — no dev
 * route covers them). Keep per-test feedback reads modest and spread audit
 * reads onto the second dev actor.
 */

const API_BASE = requireEnv('VITE_API_URL');
const APP_BASE = `http://localhost:${requireEnv('HB_PREVIEW_PORT')}`;

export interface SeededFeedbackActor {
  /** A Worker-direct context authenticated as the freshly provisioned user. */
  readonly api: APIRequestContext;
  /** The provisioned user's email, for the dev read-back's DB-truth status. */
  readonly email: string;
}

/**
 * Provision a fresh, verified product user and return a session-authenticated
 * API context for them. The admin project carries no product-session
 * storageState, so this mints one the way the harness does: a real browser
 * login (`signUpAndVerify`) whose cookies are captured into a node API context
 * — the same recipe as the base `authenticatedRequest` fixture.
 */
export async function provisionFeedbackActor(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  request: APIRequestContext,
  password: string
): Promise<SeededFeedbackActor> {
  const email = uniqueEmail('adminfb');
  const username = uniqueUsername('afb');
  await clearAuthRateLimits(request);

  // A throwaway product-origin context (baseURL overridden to the app, since
  // the admin project's baseURL points at the admin SPA). Mirrors
  // `auth.setup.ts`: raw context, browser login, capture storage state.
  const context = await browser.newContext({ baseURL: APP_BASE });
  try {
    const page = await context.newPage();
    await signUpAndVerify(page, request, { username, email, password });
    const storageState = await context.storageState();
    const api = withRequestRetry(
      await playwright.request.newContext({ baseURL: API_BASE, storageState })
    );
    return { api, email };
  } finally {
    await context.close();
  }
}

/**
 * Submit one feedback item through the REAL `POST /feedback` as the provisioned
 * user, with the required `Idempotency-Key`. Returns the new feedback id.
 */
export async function submitFeedbackViaApi(
  api: APIRequestContext,
  body: SubmitFeedbackBody
): Promise<string> {
  const response = await idempotentPost(api, '/feedback', { data: body });
  if (response.status() !== 200) {
    throw new Error(`feedback submit failed: ${String(response.status())}`);
  }
  return ((await response.json()) as { id: string }).id;
}

// ---------------------------------------------------------------------------
// UI half — the inbox table and the inline detail row
// ---------------------------------------------------------------------------

export function feedbackTable(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminFeedbackTable);
}

/** The inbox row whose id cell renders the full feedback id (CopyableId shows
 * the whole uuid). Raw locator confined to this helper. */
export function feedbackRowById(page: Page, id: string): Locator {
  return feedbackTable(page).locator('tbody tr').filter({ hasText: id });
}

/** Open the Feedback screen and gate on the inbox table rendering. */
export async function openFeedbackInbox(page: Page): Promise<void> {
  await page.goto('/feedback');
  await expect(feedbackTable(page)).toBeVisible({ timeout: TIMEOUTS.ROUTE });
}

/** Expand one row's inline detail via its chevron, gating on the detail row. */
export async function openFeedbackDetail(page: Page, id: string): Promise<void> {
  await feedbackRowById(page, id).getByTestId(TEST_IDS.adminFeedbackExpand).click();
  await expect(page.getByTestId(TEST_IDS.adminFeedbackDetail)).toBeVisible({
    timeout: TIMEOUTS.MODAL,
  });
}

/** The detail row's "Set status" action opens the standard `feedback.setStatus`
 * OpModal, prefilled with the row's feedback id. */
export async function openSetStatusOp(page: Page, id: string): Promise<void> {
  await page
    .getByTestId(TEST_IDS.adminFeedbackDetail)
    .getByRole('button', { name: 'Set status' })
    .click();
  await expect(page.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({ timeout: TIMEOUTS.MODAL });
  await expect(opFieldInput(page, 'feedbackId')).toHaveValue(id);
}

/** Pick a status in the op form's Radix select: open the trigger, click the
 * portaled option. */
export async function selectOpStatus(page: Page, status: string): Promise<void> {
  await opFieldInput(page, 'status').click();
  await page.getByRole('option', { name: status, exact: true }).click();
}
