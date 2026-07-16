import { TEST_IDS } from '@hushbox/shared';
import type { Locator, Page } from '@playwright/test';

/**
 * The four job-count cells (`pending / running / dead / discarded`) on the
 * admin dashboard's jobs grid. Raw element locators live here, not in specs
 * (rule 3.3 — raw selectors confined to helpers/page objects).
 */
export function dashboardJobCountCells(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminDashboardJobs).locator('dd');
}
