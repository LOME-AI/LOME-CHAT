import { TEST_SIGNALS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import type { Locator, Page } from '@playwright/test';

/**
 * Wait for the app's stability signal on a page, for contexts that don't go
 * through ChatPage (e.g. a second persona's page). Mirrors
 * `ChatPage.waitForAppStable`.
 */
export async function waitForAppStable(
  page: Page,
  timeout: number = TIMEOUTS.APP_STABLE
): Promise<void> {
  await page.locator(`[${TEST_SIGNALS.appStable}="true"]`).waitFor({ state: 'visible', timeout });
}

/** Wait for the marketing roadmap page's ready signal. */
export async function waitForRoadmapReady(
  page: Page,
  timeout: number = TIMEOUTS.ASSERT
): Promise<void> {
  await page.locator(`[${TEST_SIGNALS.roadmapReady}]`).waitFor({ state: 'visible', timeout });
}

/**
 * Wait for the marketing leaderboard's stats fetch to settle (loaded with data
 * or unavailable — distinguishes both from "not yet loaded").
 */
export async function waitForStatsSettled(
  page: Page,
  timeout: number = TIMEOUTS.ASSERT
): Promise<void> {
  await page
    .locator(`[${TEST_SIGNALS.statsSettled}="true"]`)
    .waitFor({ state: 'visible', timeout });
}

/** The leaderboard's loaded-with-data wrapper (absent while loading or unavailable). */
export function statsReadyBoard(page: Page): Locator {
  return page.locator(`[${TEST_SIGNALS.statsReady}]`);
}

/** Roadmap board sections, addressed by their `data-status` attribute. */
export function roadmapSections(page: Page): Locator {
  return page.locator('section[data-status]');
}

/** Roadmap board sections for a specific status. */
export function roadmapSectionsByStatus(page: Page, status: string): Locator {
  return page.locator(`section[data-status="${status}"]`);
}

/** `<img>` elements on a whole page (for non-ChatPage contexts like a shared-link recipient). */
export function imagesOnPage(page: Page): Locator {
  return page.locator('img');
}

/** `<video>` elements on a whole page (no ARIA role, so a raw element locator is required). */
export function videosOnPage(page: Page): Locator {
  return page.locator('video');
}

/** Per-member budget inputs in the budget settings modal. */
export function budgetMemberInputs(page: Page): Locator {
  return page.locator(`[data-testid^="${TEST_ID_BUILDERS.budgetInput('')}"]`);
}

/** Share/invite link rows within a scope (addressed by the link-item id prefix). */
export function linkItemsIn(scope: Locator): Locator {
  return scope.locator(`[data-testid^="${TEST_ID_BUILDERS.linkItem('')}"]`);
}
