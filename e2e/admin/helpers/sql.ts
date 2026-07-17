import { TEST_IDS } from '@hushbox/shared';
import type { Page } from '@playwright/test';

/**
 * SQL-panel helpers. BUDGET WARNING: every run — refused ones included — is
 * one `GET /admin/sql` against the SPA actor's 120/hr bucket (and writes a
 * `read.sqlPanel` audit row BEFORE execution); keep per-test query counts
 * modest.
 */

/** Type a query into the editor and run it via the Run button. */
export async function runSql(page: Page, query: string): Promise<void> {
  await page.getByTestId(TEST_IDS.adminSqlEditor).fill(query);
  await page.getByTestId(TEST_IDS.adminSqlRun).click();
}
