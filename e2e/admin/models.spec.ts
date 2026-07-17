import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { test, expect } from './fixtures.js';
import {
  countMatchingModels,
  fetchModels,
  modelRow,
  modelRows,
  pickKillSwitchTarget,
  restoreModelEnabled,
} from './helpers/models.js';
import {
  executeAndAwaitResult,
  executeOpApi,
  expectPreviewDiff,
  fillOpForm,
  opFieldInput,
  submitOpForm,
} from './helpers/op-modal.js';

/**
 * The catalog kill switch: Models screen → type-to-filter → Disable through
 * the OpModal grammar → Enable back, with every state change confirmed via
 * the admin API (rule 1.5) and the already-disabled conflict exercised
 * API-side. The target is always restored to enabled — a disabled model
 * changes live product behavior, and the restore IS the op's own round-trip.
 */
test.describe('Admin model kill switch', () => {
  test('disable and re-enable round-trip the OpModal with API truth and a duplicate-disable conflict', async ({
    adminPage,
    adminApi,
  }) => {
    const api = await adminApi();
    const catalog = await fetchModels(api);
    const target = pickKillSwitchTarget(catalog.models);

    try {
      await adminPage.goto('/models');
      await expect(adminPage.getByTestId(TEST_IDS.adminModelsTable)).toBeVisible({
        timeout: TIMEOUTS.ROUTE,
      });

      // The truncation badge mirrors the API's flag exactly — asserted in
      // both directions so a badge that never renders can't silently pass.
      await expect(adminPage.getByTestId(TEST_IDS.adminModelsTruncated)).toHaveCount(
        catalog.truncated ? 1 : 0
      );

      // Type-to-filter narrows to exactly the rows whose id/name contain the
      // needle — the expected count computed from the API list with the
      // screen's own substring predicate, never guessed.
      await adminPage.getByTestId(TEST_IDS.adminModelsFilter).fill(target.modelId);
      await expect(modelRows(adminPage)).toHaveCount(
        countMatchingModels(catalog.models, target.modelId)
      );
      await expect(modelRow(adminPage, target.modelId)).toBeVisible();

      // Disable via the OpModal: the row prefills modelId; reason is typed.
      await modelRow(adminPage, target.modelId).getByTestId(TEST_IDS.adminModelDisable).click();
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
        timeout: TIMEOUTS.MODAL,
      });
      await expect(opFieldInput(adminPage, 'modelId')).toHaveValue(target.modelId);
      await fillOpForm(adminPage, { reason: 'e2e kill-switch disable' });
      await submitOpForm(adminPage);
      await expectPreviewDiff(adminPage);
      await executeAndAwaitResult(adminPage);
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

      // The invalidated row re-renders in its disabled state…
      await expect(
        modelRow(adminPage, target.modelId).getByTestId(TEST_IDS.adminModelEnable)
      ).toBeVisible({ timeout: TIMEOUTS.ASSERT });

      // …and the API confirms the kill switch is set.
      const afterDisable = await fetchModels(api);
      const disabledRow = afterDisable.models.find((model) => model.modelId === target.modelId);
      expect(disabledRow?.adminDisabledAt ?? null).not.toBeNull();

      // Double-disable via the API (fresh key, varied reason, so the
      // idempotency layer can't absorb it): the already-disabled outcome
      // refuses with a conflict — a second disable's undo could otherwise
      // re-enable a model an earlier actor disabled.
      const duplicate = await executeOpApi(
        api,
        'model.disable',
        { modelId: target.modelId, reason: 'e2e duplicate disable attempt' },
        { idempotencyKey: crypto.randomUUID() }
      );
      expect(duplicate.status()).toBe(409);

      // Enable back through the same modal grammar.
      await modelRow(adminPage, target.modelId).getByTestId(TEST_IDS.adminModelEnable).click();
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
        timeout: TIMEOUTS.MODAL,
      });
      await expect(opFieldInput(adminPage, 'modelId')).toHaveValue(target.modelId);
      await fillOpForm(adminPage, { reason: 'e2e kill-switch re-enable' });
      await submitOpForm(adminPage);
      await expectPreviewDiff(adminPage);
      await executeAndAwaitResult(adminPage);
      await adminPage.keyboard.press('Escape');
      await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toHaveCount(0);

      // Row and API agree the model is enabled again.
      await expect(
        modelRow(adminPage, target.modelId).getByTestId(TEST_IDS.adminModelDisable)
      ).toBeVisible({ timeout: TIMEOUTS.ASSERT });
      const afterEnable = await fetchModels(api);
      expect(
        afterEnable.models.find((model) => model.modelId === target.modelId)?.adminDisabledAt
      ).toBeNull();
    } finally {
      // Hygiene, not an assertion: whatever happened above, the model must
      // not stay kill-switched.
      await restoreModelEnabled(api, target.modelId);
    }
  });
});
