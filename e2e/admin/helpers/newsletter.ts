import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../../config/timeouts.js';
import { expect } from '../fixtures.js';
import type { NewsletterIssuesWire, NewsletterIssueWire } from '@hushbox/shared';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Admin newsletter-screen helpers, UI and API halves. Raw element selectors
 * live here, never in specs (rule 3.3).
 */

/** Navigate the SPA to the newsletter screen, gated on the compose panel. */
export async function openNewsletterScreen(page: Page): Promise<void> {
  await page.goto('/newsletter');
  await expect(page.getByTestId(TEST_IDS.adminNewsletterSubject)).toBeVisible({
    timeout: TIMEOUTS.ROUTE,
  });
}

export interface ComposeDraft {
  readonly subject: string;
  readonly bodyMarkdown: string;
  /** `datetime-local` value read as UTC by the compose panel. */
  readonly scheduledAtLocal: string;
  readonly reason: string;
}

/** Fill the compose scratchpad (subject, body, send-at, reason). */
export async function fillCompose(page: Page, draft: ComposeDraft): Promise<void> {
  await page.getByTestId(TEST_IDS.adminNewsletterSubject).fill(draft.subject);
  await page.getByTestId(TEST_IDS.adminNewsletterBody).fill(draft.bodyMarkdown);
  await page.getByTestId(TEST_IDS.adminNewsletterScheduledAt).fill(draft.scheduledAtLocal);
  await page.getByTestId(TEST_IDS.adminNewsletterReason).fill(draft.reason);
}

/** The sandboxed preview iframe (rendered email HTML rides its `srcdoc`). */
export function previewFrame(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminNewsletterPreview);
}

/**
 * The issues-table row carrying one issue's subject (subjects are unique per
 * spec run, so the text filter matches exactly one row).
 */
export function issueRow(page: Page, subject: string): Locator {
  return page.getByTestId(TEST_IDS.adminNewsletterTable).locator('tr').filter({ hasText: subject });
}

/**
 * A `datetime-local` value (UTC wall time, seconds precision) `offsetMs`
 * ahead of now. Seconds precision keeps a near-future schedule tight — the
 * schedule op refuses non-future instants, so the offset must cover the
 * OpModal round trip while staying small enough to poll dispatch promptly.
 */
export function utcDatetimeLocalFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19);
}

/** First page of `GET /admin/newsletter/issues` (newest first, capped). */
export async function fetchIssues(api: APIRequestContext): Promise<readonly NewsletterIssueWire[]> {
  const response = await api.get('/admin/newsletter/issues', { params: { limit: 100 } });
  if (response.status() !== 200) {
    throw new Error(`admin newsletter issues read failed: ${String(response.status())}`);
  }
  return ((await response.json()) as NewsletterIssuesWire).rows;
}

/** The one issue whose subject matches, or undefined (subjects unique/run). */
export async function fetchIssueBySubject(
  api: APIRequestContext,
  subject: string
): Promise<NewsletterIssueWire | undefined> {
  const rows = await fetchIssues(api);
  return rows.find((row) => row.subject === subject);
}

/** The matching issue's status, or `'missing'` — the poll projection. */
export async function fetchIssueStatus(api: APIRequestContext, subject: string): Promise<string> {
  const issue = await fetchIssueBySubject(api, subject);
  return issue === undefined ? 'missing' : issue.status;
}

/** The matching issue, throwing when it does not exist (post-poll reads). */
export async function requireIssue(
  api: APIRequestContext,
  subject: string
): Promise<NewsletterIssueWire> {
  const issue = await fetchIssueBySubject(api, subject);
  if (issue === undefined) {
    throw new Error(`newsletter issue "${subject}" not found in the admin issues read`);
  }
  return issue;
}
