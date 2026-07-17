import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { fetchWallet } from './helpers/customer-360.js';
import {
  executeAndAwaitResult,
  executeButton,
  expectPreviewDiff,
  fetchAuditRows,
  fillOpForm,
  readAuditId,
  submitOpForm,
} from './helpers/op-modal.js';
import {
  openPalette,
  palette,
  paletteInput,
  paletteOptions,
  searchPalette,
} from './helpers/palette.js';
import { mintLockedUser } from './helpers/targets.js';

/** $1.50 in nano-USD — a distinctive amount for the actor-switch credit. */
const SWITCHED_CREDIT_NANO_USD = '1500000000';

test.describe('Admin command palette and actor switcher', () => {
  test('⌘K opens the palette; keyboard drives screens, ops, and go-to-user; Escape closes', async ({
    adminPage,
    request,
  }) => {
    // Disposable go-to-user target minted up front (API precondition).
    const target = await mintLockedUser(request);

    // Toggle: the global shortcut opens, Escape closes and resets.
    await openPalette(adminPage);
    await adminPage.keyboard.press('Escape');
    await expect(palette(adminPage)).toHaveCount(0);

    // Screen navigation: type-to-filter puts the Models screen first; the
    // arrow keys move the aria-selected option and Enter runs the top one.
    await openPalette(adminPage);
    await searchPalette(adminPage, 'model');
    // The list keyboard handler lives on the palette input (combobox
    // pattern), so arrows and Enter are pressed there.
    await expect(paletteOptions(adminPage).first()).toHaveAttribute('aria-selected', 'true');
    await paletteInput(adminPage).press('ArrowDown');
    await expect(paletteOptions(adminPage).nth(1)).toHaveAttribute('aria-selected', 'true');
    await paletteInput(adminPage).press('ArrowUp');
    await expect(paletteOptions(adminPage).first()).toHaveAttribute('aria-selected', 'true');
    await paletteInput(adminPage).press('Enter');
    await expect(adminPage).toHaveURL(/\/models/);
    await expect(adminPage.getByTestId(TEST_IDS.adminModelsFilter)).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
    await expect(palette(adminPage)).toHaveCount(0);

    // Op launch: selecting an op option opens the OpModal for that op.
    await openPalette(adminPage);
    await searchPalette(adminPage, 'disable model');
    // The ops list loads only once the palette opens, while the go-to-user
    // entry renders immediately — gate on the op actually being the top
    // option before Enter, or the keypress races the fetch.
    await expect(paletteOptions(adminPage).first()).toContainText('Disable model');
    await expect(paletteOptions(adminPage).first()).toHaveAttribute('aria-selected', 'true');
    await paletteInput(adminPage).press('Enter');
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await adminPage.keyboard.press('Escape');
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

    // Go-to-user: an email matches no screen or op, so the go-to-user entry
    // is the top option; Enter lands on Customer 360 with the typed query,
    // and the screen's own lookup renders the target's panels (one audited
    // read for the SPA's actor).
    await openPalette(adminPage);
    await searchPalette(adminPage, target.email);
    await paletteInput(adminPage).press('Enter');
    await expect(adminPage).toHaveURL(/\/customer-360\?q=/);
    await expect(adminPage.getByTestId(TEST_IDS.adminC360Panels)).toBeVisible({
      timeout: TIMEOUTS.ROUTE,
    });
  });

  test('the actor switcher stamps the switched identity on the audit trail', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);
    // API reads ride the second dev actor and this test performs NO SPA
    // Customer-360 render at all (the op is launched from the palette), so
    // the shared per-actor read budgets are barely touched — the observed
    // failure mode when parallel suite runs exhaust an actor's 120/hr
    // c360 bucket.
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const wallet = await fetchWallet(api, { email: target.email }, 'purchased');

    // Switch the SPA's dev identity to the second allowlisted actor. The
    // identity is in-memory SPA state, so no full page load may follow —
    // the palette + modal flow below is entirely client-side.
    const switcher = adminPage.getByTestId(TEST_IDS.adminActorSwitcher);
    await expect(switcher).toContainText(DEV_ADMIN_ACTORS[0]);
    await switcher.click();
    await expect(switcher).toContainText(DEV_ADMIN_ACTORS[1]);

    // A cheap op as the switched actor, launched through the palette: the
    // wallet.credit OpModal with the minted wallet's id typed in. The query
    // is the op NAME (the option's hint) — 'credit wallet' would also
    // substring-match "Claw back wallet credit", which sorts first.
    await openPalette(adminPage);
    await searchPalette(adminPage, 'wallet.credit');
    // Gate on the async-loaded op being the top option (see test above).
    await expect(paletteOptions(adminPage).first()).toContainText('Credit wallet');
    await expect(paletteOptions(adminPage).first()).toHaveAttribute('aria-selected', 'true');
    await paletteInput(adminPage).press('Enter');
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await fillOpForm(adminPage, {
      walletId: wallet.id,
      amountNanoUsd: SWITCHED_CREDIT_NANO_USD,
      reason: 'e2e actor-switch credit',
    });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Credit wallet/);
    await executeAndAwaitResult(adminPage);
    const auditId = await readAuditId(adminPage);

    // API truth: the committed audit row carries the SWITCHED actor.
    const rows = await fetchAuditRows(api, { action: 'wallet.credit', targetId: wallet.id });
    const creditRow = rows.find((row) => row.id === auditId);
    expect(creditRow?.actor).toBe(DEV_ADMIN_ACTORS[1]);

    // Toggle back so the page ends on the default identity.
    await adminPage.keyboard.press('Escape');
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);
    await switcher.click();
    await expect(switcher).toContainText(DEV_ADMIN_ACTORS[0]);
  });
});
