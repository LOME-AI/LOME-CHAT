import { TEST_IDS } from '@hushbox/shared';
import { e2eModelIds } from '../../../scripts/lib/e2e-model-ids.js';
import { executeOpApi } from './op-modal.js';
import type { AdminModelWire, AdminModelsWire } from '@hushbox/shared';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Models-screen helpers: the `GET /admin/models` catalog read (not
 * rate-limited — catalog data, not customer metadata) and the row locators
 * the kill-switch spec drives. Raw element selectors live here, never in
 * specs (rule 3.3).
 */

/** One `GET /admin/models` page. Throws on any non-200. */
export async function fetchModels(api: APIRequestContext): Promise<AdminModelsWire> {
  const response = await api.get('/admin/models');
  if (response.status() !== 200) {
    throw new Error(`models read failed: ${String(response.status())}`);
  }
  return (await response.json()) as AdminModelsWire;
}

/**
 * Model ids the E2E suite's chat/media specs depend on resolving (the
 * `E2E_MODELS` set, asserted present by `e2e:prepare`; imported from the
 * db-free id module so this set can never drift from it). The kill-switch
 * spec must never disable one of these — even transiently — so a full-matrix
 * run can't watch a chat turn refuse mid-flight because the admin project
 * happened to be exercising the switch.
 */
const E2E_CRITICAL_MODEL_IDS: ReadonlySet<string> = new Set(e2eModelIds());

/**
 * Deterministic kill-switch target: the first currently-enabled,
 * non-e2e-critical model by model-id sort order. Throws when the catalog
 * offers none (an empty catalog means `e2e:prepare`'s refresh never ran).
 */
export function pickKillSwitchTarget(models: readonly AdminModelWire[]): AdminModelWire {
  const target = models
    .toSorted((a, b) => a.modelId.localeCompare(b.modelId))
    .find((model) => model.adminDisabledAt === null && !E2E_CRITICAL_MODEL_IDS.has(model.modelId));
  if (target === undefined) {
    throw new Error('no enabled, non-e2e-critical model available as a kill-switch target');
  }
  return target;
}

/**
 * How many catalog rows the screen's client-side filter keeps for a needle —
 * the same substring-over-id+name predicate as `filterModels`
 * (apps/admin models-screen), so the narrowing assertion is computed from
 * API truth instead of guessed.
 */
export function countMatchingModels(models: readonly AdminModelWire[], needle: string): number {
  const lowered = needle.trim().toLowerCase();
  return models.filter(
    (model) =>
      model.modelId.toLowerCase().includes(lowered) ||
      (model.name ?? '').toLowerCase().includes(lowered)
  ).length;
}

/**
 * Guarantee the model ends enabled — the kill-switch spec's finally-block
 * hygiene (a disabled model changes live product behavior). Already-enabled
 * answers the engine's conflict, which means there was nothing to restore;
 * any other non-200 is surfaced.
 */
export async function restoreModelEnabled(api: APIRequestContext, modelId: string): Promise<void> {
  const response = await executeOpApi(
    api,
    'model.enable',
    { modelId, reason: 'e2e kill-switch restore' },
    { idempotencyKey: crypto.randomUUID() }
  );
  if (response.status() !== 200 && response.status() !== 409) {
    throw new Error(`kill-switch restore failed: ${String(response.status())}`);
  }
}

/** Every rendered catalog row. */
export function modelRows(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminModelsTable).locator('tbody tr');
}

/** The row for exactly one model id (the id renders as an exact-text
 * monospace span inside the row's CopyableId). */
export function modelRow(page: Page, modelId: string): Locator {
  return modelRows(page).filter({ has: page.getByText(modelId, { exact: true }) });
}
