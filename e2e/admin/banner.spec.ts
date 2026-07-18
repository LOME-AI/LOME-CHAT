import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { applyAuditFilters, auditTableRows } from './helpers/audit.js';
import {
  fetchPublicBanner,
  groupSubInput,
  restoreBannerDisabled,
  selectMessageVariant,
} from './helpers/banner.js';
import {
  executeAndAwaitResult,
  executeButton,
  expectPreviewDiff,
  fetchAuditRows,
  fillOpForm,
  opFieldInput,
  readAuditId,
  submitOpForm,
} from './helpers/op-modal.js';
import { openPalette, paletteInput, paletteOptions, searchPalette } from './helpers/palette.js';
import type { Locator, Page } from '@playwright/test';

/** The audit `details` shapes this spec distinguishes: an executed effect
 * carries `effects` + `inverseInput`; every row echoes the submitted input. */
interface AuditDetails {
  readonly input?: { readonly reason?: string };
  readonly effects?: unknown;
  readonly inverseInput?: unknown;
}

function detailsOf(row: { details: unknown }): AuditDetails {
  return row.details as AuditDetails;
}

function messageRow(page: Page, index: number): Locator {
  return page.getByTestId(TEST_ID_BUILDERS.adminOpGroupRow('messages', index));
}

function messageRowDelete(page: Page, index: number): Locator {
  return page.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowDelete('messages', index));
}

function messageRowMoveUp(page: Page, index: number): Locator {
  return page.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveUp('messages', index));
}

function messageRowMoveDown(page: Page, index: number): Locator {
  return page.getByTestId(TEST_ID_BUILDERS.adminOpGroupRowMoveDown('messages', index));
}

function messagePrepend(page: Page): Locator {
  return page.getByTestId(TEST_ID_BUILDERS.adminOpGroupPrepend('messages'));
}

function enabledToggle(page: Page): Locator {
  return page.getByTestId(TEST_ID_BUILDERS.adminOpBooleanToggle('enabled'));
}

/**
 * Launch an op form from the palette. Gate on the async-loaded op being the
 * top option before Enter, or the keypress races the fetch; the modal-visible
 * wait also covers the held state while the blind prefill probe settles.
 */
async function openOpFromPalette(page: Page, query: string, title: string): Promise<void> {
  await openPalette(page);
  await searchPalette(page, query);
  await expect(paletteOptions(page).first()).toContainText(title);
  await expect(paletteOptions(page).first()).toHaveAttribute('aria-selected', 'true');
  await paletteInput(page).press('Enter');
  await expect(page.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
    timeout: TIMEOUTS.MODAL,
  });
}

/**
 * The `banner.set` lifecycle through the OpModal grammar: palette launch →
 * the repeatable messages group's dynamic rows → the enabled-with-zero
 * refusal at preview → a real set (preview commits nothing, execute goes
 * live) → reopen (the blind `GET /prefill` probe seeds the live config) →
 * an edit executed FROM the seeded form → a reorder + prepend executed
 * FROM the seeded form (Move up swaps rows, prepend inserts at the front)
 * → undo from the audit trail's
 * inline Undo → reopen again (the probe seeds the restored disabled state)
 * → a resolver-less op opening blank off its 404 probe. Every state change
 * is confirmed via the admin API and the PUBLIC `GET /announcements/banner`
 * read (rule 1.5).
 *
 * GLOBAL STATE: `banner_config` is one global row rendered app-wide, so the
 * enabled window is kept as short as possible (execute → edit → reorder →
 * undo, nothing else between) and the finally block always restores the
 * disabled state — the
 * same hygiene pattern as the model kill-switch spec. Residual risk: in a
 * full parallel run, `e2e/announcement-banner.spec.ts` (chromium project)
 * mutates the same single `banner_config` row concurrently with this spec
 * (admin project) with no cross-project serialization — overlap can trip
 * this spec's pre-test precondition, which fails loudly by design.
 *
 * READ BUDGET (per-actor per-hour buckets, no dev reset): API audit reads
 * ride the second dev actor (3 of 240/hr); the SPA's default actor spends
 * 2 audit reads (unfiltered /audit mount + 1 filter apply).
 */
test.describe('Admin banner lifecycle', () => {
  test('set → refused-empty preview → execute goes live → reopen prefills → edit from prefill → reorder and prepend from prefill → undo from the audit trail restores the prior state', async ({
    adminPage,
    adminApi,
  }) => {
    // Four full OpModal round trips + three prefill reopens + an /audit
    // journey: wider than XLONG.
    test.setTimeout(TIMEOUTS.XXLONG);

    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const runTag = crypto.randomUUID();
    const refusalReason = `e2e banner refusal ${runTag}`;
    const setReason = `e2e banner set ${runTag}`;
    const firstText = `e2e banner first message ${runTag}`;
    const secondText = `e2e banner second message ${runTag}`;
    const firstHref = 'https://status.hushbox.ai/e2e-banner';
    const firstLinkText = 'Status page';
    const editReason = `e2e banner edit ${runTag}`;
    const editedText = `e2e banner edited message ${runTag}`;
    const reorderReason = `e2e banner reorder ${runTag}`;
    const thirdText = `e2e banner third message ${runTag}`;

    // The pre-test state the undo must restore. Disabled is also this spec's
    // own postcondition (the finally block), so a non-null hash here means an
    // earlier run leaked global state — fail loudly at the precondition.
    const before = await fetchPublicBanner(api);
    expect(before.hash, 'pre-test banner must be disabled (global-state hygiene)').toBeNull();

    // The refusal probe's preview is an expected 400 on the SPA's proxied
    // origin (same allowance pattern as the guardrails spec). The blind
    // prefill probe's 404 is suite-allowed in the admin fixtures.
    expectApiErrors(adminPage, [/400 .*POST .*\/admin\/ops\/banner\.set\/preview/]);
    expectConsoleErrors(adminPage, [
      /Failed to load resource: the server responded with a status of 400/,
    ]);

    try {
      // 1. Open the banner.set form from the palette (the ops catalog's
      // keyboard-first surface). The prefill probe finds the cleanup-restored
      // config (disabled, zero messages), so the form seeds indistinguishable
      // from blank.
      await openOpFromPalette(adminPage, 'banner.set', 'Set banner');

      // 2. Dynamic rows. The group opens with exactly one trailing empty row,
      // which carries no delete button.
      await expect(messageRow(adminPage, 0)).toBeVisible();
      await expect(messageRow(adminPage, 1)).toHaveCount(0);
      await expect(messageRowDelete(adminPage, 0)).toHaveCount(0);

      // Typing into the trailing row appends a fresh trailing row and makes
      // the typed row deletable.
      await groupSubInput(adminPage, 'messages', 0, 'text').fill(firstText);
      await expect(messageRow(adminPage, 1)).toBeVisible();
      await expect(messageRowDelete(adminPage, 0)).toBeVisible();
      await expect(messageRowDelete(adminPage, 1)).toHaveCount(0);

      // A second message grows the list again.
      await groupSubInput(adminPage, 'messages', 1, 'text').fill(secondText);
      await expect(messageRow(adminPage, 2)).toBeVisible();

      // Deleting row 0 shrinks the list and realigns indices: the second
      // message's text now lives at index 0.
      await messageRowDelete(adminPage, 0).click();
      await expect(messageRow(adminPage, 2)).toHaveCount(0);
      await expect(groupSubInput(adminPage, 'messages', 0, 'text')).toHaveValue(secondText);

      // 3. Refusal probe: back to zero message rows, enabled ON. The client
      // form submits (the cross-field rule lives in the op body, not the
      // contract) and the engine refuses the preview with a validation error.
      await messageRowDelete(adminPage, 0).click();
      await expect(messageRow(adminPage, 1)).toHaveCount(0);
      await expect(groupSubInput(adminPage, 'messages', 0, 'text')).toHaveValue('');
      await enabledToggle(adminPage).click();
      await expect(enabledToggle(adminPage)).toHaveAttribute('aria-checked', 'true');
      await fillOpForm(adminPage, { reason: refusalReason });
      await submitOpForm(adminPage);
      await expect(adminPage.getByTestId(TEST_IDS.adminOpError)).toBeVisible({
        timeout: TIMEOUTS.ASSERT,
      });
      await expect(executeButton(adminPage)).toHaveCount(0);

      // API truth: the refused preview audited nothing and committed nothing.
      const rowsAfterRefusal = await fetchAuditRows(api, { action: 'banner.set', limit: 100 });
      expect(
        rowsAfterRefusal.filter((row) => detailsOf(row).input?.reason === refusalReason)
      ).toHaveLength(0);
      expect(await fetchPublicBanner(api)).toEqual(before);

      // 4. Valid fill: back to the form (values survive the blocked preview —
      // the switch is still ON), two messages with different variants, the
      // first carrying a link.
      await adminPage.getByRole('button', { name: 'Back to form' }).click();
      await expect(enabledToggle(adminPage)).toHaveAttribute('aria-checked', 'true');
      await groupSubInput(adminPage, 'messages', 0, 'text').fill(firstText);
      await selectMessageVariant(adminPage, 0, 'warning');
      await groupSubInput(adminPage, 'messages', 0, 'href').fill(firstHref);
      await groupSubInput(adminPage, 'messages', 0, 'linkText').fill(firstLinkText);
      await groupSubInput(adminPage, 'messages', 1, 'text').fill(secondText);
      await selectMessageVariant(adminPage, 1, 'critical');
      await fillOpForm(adminPage, { reason: setReason });
      await submitOpForm(adminPage);

      // The preview diff renders the prior state (disabled, no messages) and
      // the after state (both messages), as one banner.config effect.
      await expectPreviewDiff(adminPage);
      const diff = adminPage.getByTestId(TEST_IDS.adminOpDiff);
      await expect(diff).toContainText('banner.config');
      await expect(diff).toContainText('"enabled":false');
      await expect(diff).toContainText('"enabled":true');
      await expect(diff).toContainText(firstText);
      await expect(diff).toContainText(secondText);
      await expect(executeButton(adminPage)).toHaveText(/^Set banner \(1 change\)$/);

      // Preview committed nothing: the public read is byte-identical.
      expect(await fetchPublicBanner(api)).toEqual(before);

      // 5. Execute: result step, then API truth — the audit row and the live
      // public banner.
      await executeAndAwaitResult(adminPage);
      const setAuditId = await readAuditId(adminPage);
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

      const rowsAfterExecute = await fetchAuditRows(api, { action: 'banner.set', limit: 100 });
      const setRow = rowsAfterExecute.find((row) => row.id === setAuditId);
      expect(setRow?.action).toBe('banner.set');
      expect(setRow?.actor).toBe(DEV_ADMIN_ACTORS[0]);
      expect(detailsOf(setRow ?? { details: undefined }).input?.reason).toBe(setReason);
      expect(detailsOf(setRow ?? { details: undefined }).effects).toBeDefined();
      expect(detailsOf(setRow ?? { details: undefined }).inverseInput).toBeDefined();

      const live = await fetchPublicBanner(api);
      expect(live.hash).not.toBeNull();
      expect(live.messages).toEqual([
        { text: firstText, variant: 'warning', href: firstHref, linkText: firstLinkText },
        { text: secondText, variant: 'critical' },
      ]);

      // 6. Reopen banner.set: the blind prefill probe seeds the form with
      // the live config — switch ON, both rows verbatim (variant, text,
      // href, linkText), one trailing empty row after them, reason blank.
      await openOpFromPalette(adminPage, 'banner.set', 'Set banner');
      await expect(enabledToggle(adminPage)).toHaveAttribute('aria-checked', 'true');
      await expect(groupSubInput(adminPage, 'messages', 0, 'text')).toHaveValue(firstText);
      await expect(groupSubInput(adminPage, 'messages', 0, 'variant')).toContainText('warning');
      await expect(groupSubInput(adminPage, 'messages', 0, 'href')).toHaveValue(firstHref);
      await expect(groupSubInput(adminPage, 'messages', 0, 'linkText')).toHaveValue(firstLinkText);
      await expect(groupSubInput(adminPage, 'messages', 1, 'text')).toHaveValue(secondText);
      await expect(groupSubInput(adminPage, 'messages', 1, 'variant')).toContainText('critical');
      await expect(messageRow(adminPage, 2)).toBeVisible();
      await expect(messageRow(adminPage, 3)).toHaveCount(0);
      await expect(messageRowDelete(adminPage, 2)).toHaveCount(0);
      await expect(opFieldInput(adminPage, 'reason')).toHaveValue('');

      // 7. Edit FROM the seeded form — the workflow prefill exists for:
      // change only the second message's text, preview, execute. The public
      // read shows the edited config with the untouched link intact.
      await groupSubInput(adminPage, 'messages', 1, 'text').fill(editedText);
      await fillOpForm(adminPage, { reason: editReason });
      await submitOpForm(adminPage);
      await expectPreviewDiff(adminPage);
      await expect(adminPage.getByTestId(TEST_IDS.adminOpDiff)).toContainText(editedText);
      await executeAndAwaitResult(adminPage);
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

      const edited = await fetchPublicBanner(api);
      expect(edited.hash).not.toBeNull();
      expect(edited.messages).toEqual([
        { text: firstText, variant: 'warning', href: firstHref, linkText: firstLinkText },
        { text: editedText, variant: 'critical' },
      ]);

      // 8. Reorder + prepend FROM the seeded form: reopen (the probe seeds
      // the edited two-message config), swap the rows with Move up, prepend
      // a third message at the front, execute. The public read proves the
      // persisted order is the FORM order after the moves.
      await openOpFromPalette(adminPage, 'banner.set', 'Set banner');
      await expect(groupSubInput(adminPage, 'messages', 0, 'text')).toHaveValue(firstText);
      await expect(groupSubInput(adminPage, 'messages', 1, 'text')).toHaveValue(editedText);

      // The move-button grammar: up disabled on the first row, down disabled
      // on the last filled row (it must never swap into the trailing empty
      // slot), neither rendered on the trailing empty row.
      await expect(messageRowMoveUp(adminPage, 0)).toBeDisabled();
      await expect(messageRowMoveDown(adminPage, 1)).toBeDisabled();
      await expect(messageRowMoveUp(adminPage, 2)).toHaveCount(0);
      await expect(messageRowMoveDown(adminPage, 2)).toHaveCount(0);

      // Moving row 1 up swaps the two rows — the first row's link fields
      // travel with it down to index 1.
      await messageRowMoveUp(adminPage, 1).click();
      await expect(groupSubInput(adminPage, 'messages', 0, 'text')).toHaveValue(editedText);
      await expect(groupSubInput(adminPage, 'messages', 1, 'text')).toHaveValue(firstText);
      await expect(groupSubInput(adminPage, 'messages', 1, 'href')).toHaveValue(firstHref);
      await expect(groupSubInput(adminPage, 'messages', 1, 'linkText')).toHaveValue(firstLinkText);

      // Prepend inserts an empty row at index 0 (focus lands in its first
      // control) and pushes the others down; the third message fills it.
      await messagePrepend(adminPage).click();
      await expect(groupSubInput(adminPage, 'messages', 0, 'variant')).toBeFocused();
      await selectMessageVariant(adminPage, 0, 'info');
      await groupSubInput(adminPage, 'messages', 0, 'text').fill(thirdText);

      // The form's row order, index by index, before submitting: three
      // filled rows then exactly one trailing empty row.
      await expect(groupSubInput(adminPage, 'messages', 0, 'text')).toHaveValue(thirdText);
      await expect(groupSubInput(adminPage, 'messages', 1, 'text')).toHaveValue(editedText);
      await expect(groupSubInput(adminPage, 'messages', 2, 'text')).toHaveValue(firstText);
      await expect(messageRow(adminPage, 3)).toBeVisible();
      await expect(messageRow(adminPage, 4)).toHaveCount(0);

      await fillOpForm(adminPage, { reason: reorderReason });
      await submitOpForm(adminPage);
      await expectPreviewDiff(adminPage);
      await expect(adminPage.getByTestId(TEST_IDS.adminOpDiff)).toContainText(thirdText);
      await executeAndAwaitResult(adminPage);
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

      // API truth: the public banner serves the NEW order — prepended,
      // formerly-second, formerly-first (link intact on the moved row).
      const reordered = await fetchPublicBanner(api);
      expect(reordered.hash).not.toBeNull();
      expect(reordered.messages).toEqual([
        { text: thirdText, variant: 'info' },
        { text: editedText, variant: 'critical' },
        { text: firstText, variant: 'warning', href: firstHref, linkText: firstLinkText },
      ]);

      // 9. Undo from the audit surface: the trail's inline Undo opens the
      // inverse flow prefilled from the engine's pre-state snapshot. The
      // target is the ORIGINAL set row — its snapshot is the pre-test
      // disabled state, so executing the inverse restores it even though
      // later edits superseded the row (snapshots, not deltas).
      await adminPage.goto('/audit');
      await expect(adminPage.getByTestId(TEST_IDS.adminAuditFilters)).toBeVisible({
        timeout: TIMEOUTS.ROUTE,
      });
      await applyAuditFilters(adminPage, { action: 'banner.set' });
      const bannerAuditRow = auditTableRows(adminPage).filter({ hasText: setReason });
      await expect(bannerAuditRow).toHaveCount(1);
      await bannerAuditRow.getByTestId(TEST_IDS.adminAuditUndo).click();
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
        timeout: TIMEOUTS.MODAL,
      });
      await expect(opFieldInput(adminPage, 'reason')).toHaveValue('undo of banner.set');
      await submitOpForm(adminPage);
      await expectPreviewDiff(adminPage);
      await executeAndAwaitResult(adminPage);
      const undoAuditId = await readAuditId(adminPage);
      expect(undoAuditId).not.toBe(setAuditId);
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

      // The pair is doubly linked, and the public read is back to the exact
      // pre-test (disabled, null-hash) state.
      const trail = await fetchAuditRows(api, { action: 'banner.set', limit: 100 });
      const undoRow = trail.find((row) => row.id === undoAuditId);
      expect(undoRow?.undoes).toBe(setAuditId);
      expect(trail.find((row) => row.id === setAuditId)?.undoneBy).toBe(undoAuditId);

      const restored = await fetchPublicBanner(api);
      expect(restored.hash).toBeNull();
      expect(restored).toEqual(before);

      // 10. Reopen after the undo: the probe seeds the restored disabled
      // state — switch OFF, only the trailing empty row, reason blank
      // (indistinguishable from a blank form, by design).
      await openOpFromPalette(adminPage, 'banner.set', 'Set banner');
      await expect(enabledToggle(adminPage)).toHaveAttribute('aria-checked', 'false');
      await expect(messageRow(adminPage, 0)).toBeVisible();
      await expect(messageRow(adminPage, 1)).toHaveCount(0);
      await expect(groupSubInput(adminPage, 'messages', 0, 'text')).toHaveValue('');
      await expect(opFieldInput(adminPage, 'reason')).toHaveValue('');
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

      // 11. A resolver-less op still opens its form, blank and promptly:
      // the blind probe 404s (allowed above) and seeds nothing — the modal
      // renders inside the same MODAL budget as every other open.
      await openOpFromPalette(adminPage, 'wallet.credit', 'Credit wallet');
      await expect(opFieldInput(adminPage, 'walletId')).toHaveValue('');
      await expect(opFieldInput(adminPage, 'reason')).toHaveValue('');
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);
    } finally {
      // Hygiene, not an assertion: whatever happened above, the banner must
      // not stay enabled — it renders in every other suite's app.
      await restoreBannerDisabled(api, `e2e banner cleanup ${runTag}`);
    }
  });
});
