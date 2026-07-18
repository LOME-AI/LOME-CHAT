import { TEST_IDS } from '@hushbox/shared';
import { requireEnv } from './env.js';
import { openMobileSidebarIfNeeded } from './auth.js';
import type { FeedbackKind } from '@hushbox/shared';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * In-app feedback composer helpers (raw selectors and the dev read-back live
 * here, never in specs — rule 3.3). The modal-open + fill + submit interaction
 * is confined to this helper so the spec only expresses the journey.
 */

const API_BASE = requireEnv('VITE_API_URL');

/** The composer's kind toggle test-ids, keyed by the feedback kind. */
const KIND_TEST_IDS: Record<FeedbackKind, string> = {
  bug: TEST_IDS.feedbackTypeBug,
  idea: TEST_IDS.feedbackTypeIdea,
  praise: TEST_IDS.feedbackTypePraise,
};

/** The success toast the composer shows once a submit has committed. */
export const FEEDBACK_SUCCESS_TOAST = 'Thanks — we read every one.';

/**
 * Open the user menu (sidebar footer dropdown) and click Send feedback, gating
 * on the modal being visible. Mirrors `logoutViaUI`'s sidebar-trigger path.
 */
export async function openFeedbackModal(page: Page): Promise<void> {
  await openMobileSidebarIfNeeded(page);
  await page.getByTestId(TEST_IDS.sidebarTrigger).click();
  await page.getByTestId(TEST_IDS.menuFeedback).click();
  await page.getByTestId(TEST_IDS.feedbackModal).waitFor({ state: 'visible' });
}

export interface FeedbackDraft {
  readonly kind: FeedbackKind;
  readonly body: string;
}

/**
 * Fill the open composer and submit, gating on app state only: the `POST
 * /feedback` returning 200 AND the success toast rendering. No wall-clock wait
 * (rule 2.1).
 */
export async function submitFeedback(page: Page, draft: FeedbackDraft): Promise<void> {
  await page.getByTestId(KIND_TEST_IDS[draft.kind]).click();
  await page.getByTestId(TEST_IDS.feedbackBody).fill(draft.body);

  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/feedback') &&
      response.status() === 200
  );
  await page.getByTestId(TEST_IDS.feedbackSubmit).click();
  await submitted;
  await page.getByText(FEEDBACK_SUCCESS_TOAST).waitFor({ state: 'visible' });
}

/** One persisted feedback row, as the dev read-back route projects it. */
export interface PersistedFeedback {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly status: string;
  readonly body: string;
  readonly createdAt: string;
}

/**
 * Dev read-back: the feedback rows persisted for `email`. Proves the row landed
 * in Postgres (rule 1.5). Throws on any non-200 so a broken seam fails at the
 * assertion site, never as a silent empty list.
 */
export async function fetchFeedbackByEmail(
  request: APIRequestContext,
  email: string
): Promise<readonly PersistedFeedback[]> {
  const response = await request.get(
    `${API_BASE}/dev/feedback/by-email/${encodeURIComponent(email)}`
  );
  if (response.status() !== 200) {
    throw new Error(`dev feedback read-back failed: ${String(response.status())}`);
  }
  return ((await response.json()) as { rows: PersistedFeedback[] }).rows;
}
