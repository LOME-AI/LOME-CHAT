import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import {
  AUDIT_PAGE_SIZE,
  applyAuditFilters,
  auditTableRows,
  seedWalletCredits,
} from './helpers/audit.js';
import { fetchWallet } from './helpers/customer-360.js';
import { executeOpOk } from './helpers/op-modal.js';
import { mintLockedUser } from './helpers/targets.js';

/** $1 in nano-USD. */
const CREDIT_NANO_USD = '1000000000';

/** Enough extra credits that the pair + seeds exceed one audit page. */
const EXTRA_CREDITS = 50;

/** The whole self-seeded trail for the minted wallet: 1 credit + its
 * clawback undo + the seeds — two rows past the page size, so Load more
 * appears and the second page is small. */
const TOTAL_ROWS = EXTRA_CREDITS + 2;

/**
 * The audit-trail screen over a self-seeded trail: filters (pill, exact
 * targetId scoping, empty state), cursor pagination via Load more, and the
 * row drawer with its raw toggle and undo-pair jump links.
 *
 * READ BUDGET (per-actor per-hour buckets, no dev reset): the SPA actor
 * spends 5 audit reads (initial unfiltered mount + 3 filter applies + 1
 * Load more) of 240/hr; the second dev actor spends 1 customer-360 read of
 * 120/hr. Trail seeding rides op EXECUTES, which are not rate-limited.
 */
test.describe('Admin audit trail', () => {
  test('filters, pagination, and the undo-linked drawer over a self-seeded trail', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    // 52 sequential-ish op executes + a browser journey: wider than LONG.
    test.setTimeout(TIMEOUTS.XLONG);

    // Seed a private trail on a minted user's wallet: one undo-linked pair
    // (credit → clawback threading `undoes`) plus enough credits to paginate.
    const target = await mintLockedUser(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const wallet = await fetchWallet(api, { email: target.email }, 'purchased');
    const runTag = crypto.randomUUID();
    const credit = await executeOpOk(
      api,
      'wallet.credit',
      { walletId: wallet.id, amountNanoUsd: CREDIT_NANO_USD, reason: `e2e trail pair ${runTag}` },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(credit.inverseInput).not.toBeNull();
    const clawback = await executeOpOk(api, 'wallet.clawback', credit.inverseInput!, {
      idempotencyKey: crypto.randomUUID(),
      undoes: credit.auditId,
    });
    await seedWalletCredits(api, wallet.id, EXTRA_CREDITS, `e2e trail seed ${runTag}`);

    await adminPage.goto('/audit');
    await expect(adminPage.getByTestId(TEST_IDS.adminAuditFilters)).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
    const rows = auditTableRows(adminPage);

    // Action filter: a pill appears and every row matches the action.
    await applyAuditFilters(adminPage, { action: 'wallet.clawback' });
    await expect(adminPage.getByTestId(TEST_IDS.adminAuditFilterPill)).toContainText(
      'action: wallet.clawback'
    );
    await expect(rows.first()).toBeVisible({ timeout: TIMEOUTS.ASSERT });
    await expect(rows.filter({ hasNotText: 'wallet.clawback' })).toHaveCount(0);

    // targetId filter: exactly the seeded wallet's rows — one server page
    // plus Load more, which drains the remainder and then disappears.
    await applyAuditFilters(adminPage, { targetId: wallet.id });
    await expect(rows).toHaveCount(AUDIT_PAGE_SIZE, { timeout: TIMEOUTS.ASSERT });
    await expect(adminPage.getByTestId(TEST_IDS.adminAuditLoadMore)).toBeVisible();
    await adminPage.getByTestId(TEST_IDS.adminAuditLoadMore).click();
    await expect(rows).toHaveCount(TOTAL_ROWS, { timeout: TIMEOUTS.ASSERT });
    await expect(adminPage.getByTestId(TEST_IDS.adminAuditLoadMore)).toHaveCount(0);
    await expect(rows.filter({ hasNotText: wallet.id })).toHaveCount(0);

    // The drawer on the trail's one clawback row (loaded by the pagination
    // above — jump targets must be in the loaded set).
    const clawbackRow = rows.filter({ hasText: 'wallet.clawback' });
    await expect(clawbackRow).toHaveCount(1);
    await clawbackRow.getByTestId(TEST_IDS.adminAuditInspect).click();
    const drawer = adminPage.getByTestId(TEST_IDS.adminAuditDrawer);
    await expect(drawer).toBeVisible({ timeout: TIMEOUTS.MODAL });
    await expect(drawer.getByText(clawback.auditId, { exact: true })).toBeVisible();

    // Raw toggle: the wire row verbatim, including the undo threading.
    await drawer.getByTestId(TEST_IDS.adminAuditDrawerRaw).click();
    await expect(drawer).toContainText(`"undoes": "${credit.auditId}"`);

    // Undo-pair jumps: clawback → credit (its "Undone by" points back) →
    // clawback again — the pair is doubly linked in the UI.
    await drawer.getByRole('button', { name: `Undoes ${credit.auditId.slice(0, 8)}` }).click();
    await expect(drawer.getByText(credit.auditId, { exact: true })).toBeVisible();
    await expect(drawer).toContainText('wallet.credit');
    await drawer.getByRole('button', { name: `Undone by ${clawback.auditId.slice(0, 8)}` }).click();
    await expect(drawer.getByText(clawback.auditId, { exact: true })).toBeVisible();

    // Esc closes the drawer.
    await adminPage.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // An absurd filter finds nothing and says so (refusal rows are audited
    // too, so empty means "too narrow", never "unrecorded").
    await applyAuditFilters(adminPage, { targetId: crypto.randomUUID() });
    await expect(adminPage.getByTestId(TEST_IDS.adminAuditEmpty)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
  });
});
