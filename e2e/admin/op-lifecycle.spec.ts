import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { test, expect } from './fixtures.js';
import { creditButtonFor, fetchWallet, openCustomer360 } from './helpers/customer-360.js';
import {
  clickUndo,
  executeAndAwaitResult,
  executeButton,
  expectPreviewDiff,
  fetchAuditRows,
  fillOpForm,
  opFieldInput,
  readAuditId,
  submitOpForm,
} from './helpers/op-modal.js';
import { mintLockedUser } from './helpers/targets.js';

/** $5 in nano-USD — comfortably under the $1,000 wallet-adjustment cap. */
const CREDIT_NANO_USD = '5000000000';

/**
 * The flagship admin journey: Customer-360 search → wallet credit through
 * the OpModal (form → preview diff → execute → result) → Undo runs the
 * registered inverse (wallet.clawback) prefilled from `inverseInput` and
 * threaded via `undoes` — netting the balance to exactly its prior value
 * with a doubly-linked audit trail. All state changes are asserted via the
 * admin API, not just the UI (rule 1.5).
 */
test.describe('Admin op lifecycle', () => {
  test('credit → preview → execute → undo restores the exact balance with a linked audit trail', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    // Fresh disposable target: private wallets no parallel test touches.
    const target = await mintLockedUser(request);
    const api = await adminApi();
    const before = await fetchWallet(api, { email: target.email }, 'purchased');

    // Reach the 360 view through the SPA's own search form.
    await openCustomer360(adminPage, target.email);
    await creditButtonFor(adminPage, before.id).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    // The walletId prefill came from the row the flow started on.
    await expect(opFieldInput(adminPage, 'walletId')).toHaveValue(before.id);

    // Validation moment: submitting with amount + reason empty surfaces
    // per-field errors and never reaches the preview step.
    await submitOpForm(adminPage);
    await expect(adminPage.getByTestId(TEST_IDS.adminOpFieldError).first()).toBeVisible();

    // Fill and preview: the rolled-back dry run renders a diff and an
    // execute button stating the previewed consequence.
    await fillOpForm(adminPage, {
      amountNanoUsd: CREDIT_NANO_USD,
      reason: 'e2e lifecycle credit',
    });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Credit wallet \(\d+ changes?\)$/);

    // Preview committed nothing: balance unchanged, no audit row exists for
    // this wallet — checked mid-flow, after the preview round trip settled.
    const afterPreview = await fetchWallet(api, { email: target.email }, 'purchased');
    expect(afterPreview.balanceNanoUsd).toBe(before.balanceNanoUsd);
    const auditAfterPreview = await fetchAuditRows(api, {
      action: 'wallet.credit',
      targetId: before.id,
    });
    expect(auditAfterPreview).toHaveLength(0);

    // Execute: result step surfaces the committed audit row id.
    await executeAndAwaitResult(adminPage);
    const creditAuditId = await readAuditId(adminPage);

    // API truth: the balance moved by exactly the credited amount.
    const afterCredit = await fetchWallet(api, { email: target.email }, 'purchased');
    expect(BigInt(afterCredit.balanceNanoUsd)).toBe(
      BigInt(before.balanceNanoUsd) + BigInt(CREDIT_NANO_USD)
    );

    // Undo: the inverse op's form opens prefilled from inverseInput.
    await clickUndo(adminPage);
    await expect(opFieldInput(adminPage, 'walletId')).toHaveValue(before.id);
    await expect(opFieldInput(adminPage, 'amountNanoUsd')).toHaveValue(CREDIT_NANO_USD);
    await expect(opFieldInput(adminPage, 'reason')).not.toHaveValue('');
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Claw back wallet credit \(\d+ changes?\)$/);
    await executeAndAwaitResult(adminPage);
    const clawbackAuditId = await readAuditId(adminPage);
    expect(clawbackAuditId).not.toBe(creditAuditId);

    // API truth: the undo netted the balance to exactly its prior value.
    const afterUndo = await fetchWallet(api, { email: target.email }, 'purchased');
    expect(afterUndo.balanceNanoUsd).toBe(before.balanceNanoUsd);

    // The audit trail carries both rows, doubly linked: the clawback row's
    // `undoes` names the credit row, and the credit row's `undoneBy` names
    // the clawback row.
    const trail = await fetchAuditRows(api, { targetId: before.id, limit: 50 });
    const creditRow = trail.find((row) => row.id === creditAuditId);
    const clawbackRow = trail.find((row) => row.id === clawbackAuditId);
    expect(creditRow?.action).toBe('wallet.credit');
    expect(clawbackRow?.action).toBe('wallet.clawback');
    expect(clawbackRow?.undoes).toBe(creditAuditId);
    expect(creditRow?.undoneBy).toBe(clawbackAuditId);
  });
});
