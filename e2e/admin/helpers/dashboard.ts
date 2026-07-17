import { TEST_IDS } from '@hushbox/shared';
import type { Locator, Page } from '@playwright/test';

/**
 * The four numeric stat values (`dd`) on the admin dashboard's health tiles
 * (dead jobs / backlog / discarded / actions today). Raw element locators
 * live here, not in specs (rule 3.3 — raw selectors confined to helpers/page
 * objects).
 */
export function dashboardTileValues(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminDashboardTiles).locator('dd');
}
