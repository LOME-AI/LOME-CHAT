import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { fetchAuditRows } from './helpers/op-modal.js';
import { runSql } from './helpers/sql.js';

/** The server-side row cap: SELECT-shaped queries are wrapped LIMIT cap+1,
 * so an over-cap result shows exactly this many rows plus the chip. */
const SQL_ROW_CAP = 200;

/**
 * The read-only SQL panel: results, truncation, the write-proof role's
 * refusals, the credential carve-outs, history restore, and the wire truth
 * that every query — refused ones included — is audited BEFORE execution.
 *
 * READ BUDGET: the SPA actor spends 6 SQL reads of 120/hr (refusals count);
 * the second dev actor spends 1 audit read of 240/hr.
 */
test.describe('Admin SQL panel', () => {
  test('runs reads, truncates, refuses writes and carve-outs, restores history, audits first', async ({
    adminPage,
    adminApi,
  }) => {
    // Unique per run, so the audit assertions below prove THIS run's rows —
    // comments survive the server's subquery wrap and the role's checks.
    const marker = crypto.randomUUID();
    const selectQuery = `SELECT 1 AS one -- e2e ${marker}`;
    const writeQuery = `UPDATE users SET locked_at = NULL -- e2e ${marker}`;

    await adminPage.goto('/sql');
    await expect(adminPage.getByTestId(TEST_IDS.adminSqlBadge)).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
    await expect(adminPage.getByTestId(TEST_IDS.adminSqlBadge)).toHaveText('Read-only');

    // Refusals below are deliberate: the write and both carve-outs come back
    // as the SELECT-only role's 403.
    expectApiErrors(adminPage, [/403 .*GET .*\/admin\/sql/]);
    expectConsoleErrors(adminPage, [
      /Failed to load resource: the server responded with a status of 403/,
    ]);

    const status = adminPage.getByTestId(TEST_IDS.adminSqlStatus);
    const error = adminPage.getByTestId(TEST_IDS.adminSqlError);
    const truncated = adminPage.getByTestId(TEST_IDS.adminSqlTruncated);

    // A plain read renders its grid, untruncated.
    await runSql(adminPage, selectQuery);
    await expect(status).toContainText('1 rows', { timeout: TIMEOUTS.ASSERT });
    await expect(adminPage.getByTestId(TEST_IDS.adminSqlResults)).toContainText('one');
    await expect(truncated).toHaveCount(0);

    // Over-cap: the server stops at the cap and flags it.
    await runSql(adminPage, 'SELECT * FROM generate_series(1, 300)');
    await expect(status).toContainText(`${String(SQL_ROW_CAP)} rows`, {
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(truncated).toBeVisible();

    // A write is structurally impossible: the role refuses, the panel says so.
    await runSql(adminPage, writeQuery);
    await expect(error).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    await expect(error).toContainText('SELECT statements only');

    // Credential carve-outs: the token COLUMN is unreadable while the same
    // table's metadata columns read fine; verification_tokens is fully dark.
    await runSql(adminPage, 'SELECT token FROM device_tokens LIMIT 1');
    await expect(error).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    await expect(error).toContainText('FORBIDDEN');
    await runSql(adminPage, 'SELECT id, platform FROM device_tokens LIMIT 1');
    await expect(error).toHaveCount(0, { timeout: TIMEOUTS.ASSERT });
    await expect(status).toContainText(/\d+ rows/);
    await runSql(adminPage, 'SELECT * FROM verification_tokens LIMIT 1');
    await expect(error).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    await expect(error).toContainText('FORBIDDEN');

    // History records the successful runs (newest first) and restores the
    // clicked snapshot into the editor.
    await expect(adminPage.getByTestId(TEST_IDS.adminSqlHistoryItem)).toHaveCount(3);
    await adminPage
      .getByTestId(TEST_IDS.adminSqlHistoryItem)
      .filter({ hasText: `e2e ${marker}` })
      .click();
    await expect(adminPage.getByTestId(TEST_IDS.adminSqlEditor)).toHaveValue(selectQuery);

    // Wire truth via the second actor: `read.sqlPanel` rows exist for BOTH
    // the successful select and the refused write (the row is written before
    // execution, so a refused query is still on the record), carrying the
    // query text and no target.
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const reads = await fetchAuditRows(api, {
      action: 'read.sqlPanel',
      actor: DEV_ADMIN_ACTORS[0],
      limit: 50,
    });
    const queryOf = (row: { details: unknown }): string | undefined =>
      (row.details as { query?: string }).query;
    const selectRow = reads.find((row) => queryOf(row) === selectQuery);
    const writeRow = reads.find((row) => queryOf(row) === writeQuery);
    expect(selectRow).toBeDefined();
    expect(writeRow).toBeDefined();
    expect(writeRow?.targetId).toBeNull();
  });
});
