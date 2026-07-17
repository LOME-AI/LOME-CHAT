import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../../config/timeouts.js';
import { expect } from '../fixtures.js';
import type { AdminAuditRowWire, AdminOpExecuteResult, AuditSearchWire } from '@hushbox/shared';
import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';

/**
 * Admin op-surface helpers: the OpModal's form → preview → execute/undo
 * grammar (UI half) and the generic op + audit endpoints (API half). Raw
 * element selectors live here, never in specs (rule 3.3).
 */

// ---------------------------------------------------------------------------
// UI half — the OpModal
// ---------------------------------------------------------------------------

export function opModal(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminOpModal);
}

/** One generic-form input by its contract field name (`#op-field-<name>`). */
export function opFieldInput(page: Page, fieldName: string): Locator {
  return opModal(page).locator(`#op-field-${fieldName}`);
}

/** Fill generic-form fields by contract field name. */
export async function fillOpForm(page: Page, values: Record<string, string>): Promise<void> {
  for (const [fieldName, value] of Object.entries(values)) {
    await opFieldInput(page, fieldName).fill(value);
  }
}

/** Submit the form step — runs the rolled-back preview server-side. */
export async function submitOpForm(page: Page): Promise<void> {
  await opModal(page).getByRole('button', { name: 'Preview changes' }).click();
}

/** Wait for the preview step's rendered diff (a successful dry run). */
export async function expectPreviewDiff(page: Page): Promise<void> {
  await expect(page.getByTestId(TEST_IDS.adminOpDiff)).toBeVisible({
    timeout: TIMEOUTS.ASSERT,
  });
}

/** The execute button — labeled "<op title> (N changes)", never "Confirm". */
export function executeButton(page: Page): Locator {
  return page.getByTestId(TEST_IDS.adminOpExecute);
}

/** Execute the previewed op and wait for the result step. */
export async function executeAndAwaitResult(page: Page): Promise<void> {
  await executeButton(page).click();
  await expect(page.getByTestId(TEST_IDS.adminOpResult)).toBeVisible({
    timeout: TIMEOUTS.ASSERT,
  });
}

/** The committed run's audit row id, read off the result step. */
export async function readAuditId(page: Page): Promise<string> {
  const auditId = page.getByTestId(TEST_IDS.adminOpAuditId);
  await expect(auditId).toBeVisible({ timeout: TIMEOUTS.ASSERT });
  const text = await auditId.textContent();
  return (text ?? '').trim();
}

/** Start the inverse flow from the result step (same modal, prefilled). */
export async function clickUndo(page: Page): Promise<void> {
  await page.getByTestId(TEST_IDS.adminOpUndo).click();
}

// ---------------------------------------------------------------------------
// API half — the generic op endpoints + the audit trail read
// ---------------------------------------------------------------------------

/** `POST /admin/ops/:name/preview` — returns the raw response so specs can
 * assert refusal statuses directly. Commits nothing by construction. */
export async function previewOpApi(
  api: APIRequestContext,
  name: string,
  input: Record<string, unknown>
): Promise<APIResponse> {
  return api.post(`/admin/ops/${name}/preview`, { data: { input } });
}

/** `POST /admin/ops/:name/execute` — the Idempotency-Key header is required
 * by the engine; `undoes` threads an undo's target audit row id. */
export async function executeOpApi(
  api: APIRequestContext,
  name: string,
  input: Record<string, unknown>,
  options: { idempotencyKey: string; undoes?: string }
): Promise<APIResponse> {
  return api.post(`/admin/ops/${name}/execute`, {
    headers: { 'Idempotency-Key': options.idempotencyKey },
    data: { input, ...(options.undoes === undefined ? {} : { undoes: options.undoes }) },
  });
}

/** Parse a 200 execute response; throws on any other status. */
export async function executeOpOk(
  api: APIRequestContext,
  name: string,
  input: Record<string, unknown>,
  options: { idempotencyKey: string; undoes?: string }
): Promise<AdminOpExecuteResult> {
  const response = await executeOpApi(api, name, input, options);
  if (response.status() !== 200) {
    throw new Error(`execute ${name} failed: ${String(response.status())}`);
  }
  return (await response.json()) as AdminOpExecuteResult;
}

/**
 * One page of `GET /admin/audit`. BUDGET WARNING: rate-limited 240/hr per
 * admin actor with no reset between tests (see customer-360.ts) — keep
 * per-test audit reads modest.
 */
export async function fetchAuditRows(
  api: APIRequestContext,
  params: {
    actor?: string;
    action?: string;
    targetType?: string;
    targetId?: string;
    limit?: number;
  }
): Promise<readonly AdminAuditRowWire[]> {
  const response = await api.get('/admin/audit', {
    params: {
      ...(params.actor === undefined ? {} : { actor: params.actor }),
      ...(params.action === undefined ? {} : { action: params.action }),
      ...(params.targetType === undefined ? {} : { targetType: params.targetType }),
      ...(params.targetId === undefined ? {} : { targetId: params.targetId }),
      ...(params.limit === undefined ? {} : { limit: params.limit }),
    },
  });
  if (response.status() !== 200) {
    throw new Error(`audit read failed: ${String(response.status())}`);
  }
  return ((await response.json()) as AuditSearchWire).rows;
}
