import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../../config/timeouts.js';
import { expect } from '../fixtures.js';
import type { AdminJobRowWire } from '@hushbox/shared';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Jobs-screen helpers, UI and API halves. Raw element selectors live here,
 * never in specs (rule 3.3).
 */

/**
 * The job type `POST /dev/admin-targets` mints dead/discarded jobs as
 * (mirrors the API's media-reclaim registration — the seeded payload is a
 * legal empty-key-list no-op, so a redriven row always succeeds).
 */
export const MINTED_DEAD_JOB_TYPE = 'media.reclaimUser.v1';

/** The status tabs these specs drive; labels match the screen's buttons. */
export type JobsTab = 'Dead' | 'Discarded';

/** Word-boundary match: tab buttons append a live count ("Dead 3"). */
const JOBS_TAB_PATTERNS: Readonly<Record<JobsTab, RegExp>> = {
  Dead: /^Dead\b/,
  Discarded: /^Discarded\b/,
};

/** Select a status tab and gate on its queue view rendering (table or the
 * explicit empty state — never the transient loading text). */
export async function selectJobsTab(page: Page, tab: JobsTab): Promise<void> {
  await page
    .getByTestId(TEST_IDS.adminJobsTabs)
    .getByRole('button', { name: JOBS_TAB_PATTERNS[tab] })
    .click();
  await expect(
    page.getByTestId(TEST_IDS.adminJobsTable).or(page.getByTestId(TEST_IDS.adminJobsEmpty))
  ).toBeVisible({ timeout: TIMEOUTS.ROUTE });
}

/** Navigate the SPA to the jobs screen and land on the given status tab. */
export async function openJobsScreen(page: Page, tab: JobsTab): Promise<void> {
  await page.goto('/jobs');
  await expect(page.getByTestId(TEST_IDS.adminJobsTabs)).toBeVisible({
    timeout: TIMEOUTS.ROUTE,
  });
  await selectJobsTab(page, tab);
}

/** The queue-table row carrying one job id (rendered in full as a monospace
 * CopyableId, so a text filter matches exactly one main row). */
export function jobRow(page: Page, jobId: string): Locator {
  return page.getByTestId(TEST_IDS.adminJobsTable).locator('tr').filter({ hasText: jobId });
}

/**
 * Pages the queue orders by uuid desc, and minted target ids are random
 * uuids — the sought row can legitimately sit past the first page in a
 * long-lived dev database, so both reveal paths page until found.
 */
const MAX_JOB_PAGES = 40;

/**
 * Reveal one job's row on the active tab, clicking "Load more" until it
 * appears (or no pages remain — then the final assertion reports the miss).
 */
export async function revealJobRow(page: Page, jobId: string): Promise<Locator> {
  const row = jobRow(page, jobId);
  const loadMore = page.getByTestId(TEST_IDS.adminJobsLoadMore);
  for (let pageCount = 0; pageCount < MAX_JOB_PAGES; pageCount += 1) {
    if ((await row.count()) > 0) break;
    if ((await loadMore.count()) === 0) break;
    try {
      await loadMore.click({ timeout: TIMEOUTS.MODAL });
    } catch {
      // The button unmounted between the count probe and the click (the last
      // page finished loading) — loop back and let the row check decide.
    }
  }
  await expect(row).toBeVisible({ timeout: TIMEOUTS.ASSERT });
  return row;
}

interface JobQueuePage {
  readonly rows: readonly AdminJobRowWire[];
  readonly nextCursor: string | null;
}

/**
 * One job row by id via `GET /admin/jobs` (not actor-rate-limited), paging
 * through the minted-target type in any status. Throws when absent so a
 * broken assertion premise fails loudly, never as a soft undefined.
 */
export async function fetchJobRow(api: APIRequestContext, jobId: string): Promise<AdminJobRowWire> {
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < MAX_JOB_PAGES; pageCount += 1) {
    const response = await api.get('/admin/jobs', {
      params: {
        type: MINTED_DEAD_JOB_TYPE,
        limit: 200,
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    if (response.status() !== 200) {
      throw new Error(`jobs read failed: ${String(response.status())}`);
    }
    const page = (await response.json()) as JobQueuePage;
    const row = page.rows.find((candidate) => candidate.id === jobId);
    if (row !== undefined) return row;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  throw new Error(`job ${jobId} not found in the admin job queue`);
}
