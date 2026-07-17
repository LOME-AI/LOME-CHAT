import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { expectApiErrors, expectConsoleErrors } from '../fixtures.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { creditButtonFor, fetchWallet, openCustomer360 } from './helpers/customer-360.js';
import {
  executeButton,
  executeOpApi,
  executeOpOk,
  fetchAuditRows,
  fillOpForm,
  previewOpApi,
  submitOpForm,
} from './helpers/op-modal.js';
import { mintLockedUser } from './helpers/targets.js';

/** One nano-USD over the $1,000 wallet-adjustment cap. */
const OVER_CAP_NANO_USD = '1000000000001';

/** The audit `details` shapes this suite distinguishes: an executed effect
 * carries `effects` + `inverseInput`; a guardrail refusal carries
 * `refusal` + the refused `input` and nothing undoable. */
interface AuditDetails {
  readonly refusal?: string;
  readonly input?: { readonly walletId?: string };
  readonly effects?: unknown;
  readonly inverseInput?: unknown;
}

function detailsOf(row: { details: unknown }): AuditDetails {
  return row.details as AuditDetails;
}

/**
 * Engine guardrails, exercised API-first via `adminApi` (statuses and audit
 * rows are the contract under test); the browser appears only where the
 * OpModal's own guardrail UI is the subject. Uses the second dev actor for
 * API traffic so the SPA's default actor keeps more of the shared
 * per-actor read budget (see helpers/customer-360.ts).
 */
test.describe('Admin op guardrails', () => {
  test('an over-cap credit blocks at preview and executes only as an audited, non-undoable refusal', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const wallet = await fetchWallet(api, { email: target.email }, 'purchased');
    const overCapInput = {
      walletId: wallet.id,
      amountNanoUsd: OVER_CAP_NANO_USD,
      reason: 'e2e over-cap credit',
    };

    // Preview refuses (forbidden) and — unlike execute — audits nothing.
    const preview = await previewOpApi(api, 'wallet.credit', overCapInput);
    expect(preview.status()).toBe(403);
    const rowsAfterPreview = await fetchAuditRows(api, { action: 'wallet.credit', limit: 100 });
    expect(
      rowsAfterPreview.filter((row) => detailsOf(row).input?.walletId === wallet.id)
    ).toHaveLength(0);

    // Execute refuses too — but writes the audited refusal row.
    const execute = await executeOpApi(api, 'wallet.credit', overCapInput, {
      idempotencyKey: crypto.randomUUID(),
    });
    expect(execute.status()).toBe(403);

    const rowsAfterExecute = await fetchAuditRows(api, { action: 'wallet.credit', limit: 100 });
    const refusals = rowsAfterExecute.filter((row) => detailsOf(row).input?.walletId === wallet.id);
    expect(refusals).toHaveLength(1);
    const refusal = refusals[0]!;
    expect(detailsOf(refusal).refusal).toContain('amountNanoUsd');
    // A refusal records a refused attempt: no effect happened, nothing is
    // undoable — no effects/inverseInput, no target, no undo linkage.
    expect(detailsOf(refusal).effects).toBeUndefined();
    expect(detailsOf(refusal).inverseInput).toBeUndefined();
    expect(refusal.targetId).toBeNull();
    expect(refusal.undoes).toBeNull();
    expect(refusal.undoneBy).toBeNull();

    // Nothing moved.
    const after = await fetchWallet(api, { email: target.email }, 'purchased');
    expect(after.balanceNanoUsd).toBe(wallet.balanceNanoUsd);

    // The OpModal's own guardrail UI: the over-cap preview surfaces a
    // blocking error and never offers an execute button.
    expectApiErrors(adminPage, [/403 .*POST .*\/admin\/ops\/wallet\.credit\/preview/]);
    expectConsoleErrors(adminPage, [
      /Failed to load resource: the server responded with a status of 403/,
    ]);
    await openCustomer360(adminPage, target.email);
    await creditButtonFor(adminPage, wallet.id).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await fillOpForm(adminPage, {
      amountNanoUsd: OVER_CAP_NANO_USD,
      reason: 'e2e over-cap credit via UI',
    });
    await submitOpForm(adminPage);
    await expect(adminPage.getByTestId(TEST_IDS.adminOpError)).toBeVisible({
      timeout: TIMEOUTS.ASSERT,
    });
    await expect(executeButton(adminPage)).toHaveCount(0);
  });

  test('undo is exactly-once: a second execute against the same undoes conflicts', async ({
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const wallet = await fetchWallet(api, { email: target.email }, 'purchased');

    const credit = await executeOpOk(
      api,
      'wallet.credit',
      { walletId: wallet.id, amountNanoUsd: '2000000000', reason: 'e2e undo-once credit' },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(credit.inverseInput).not.toBeNull();
    const inverseInput = credit.inverseInput!;

    // First undo claims the credit row's one undo slot.
    const undo = await executeOpOk(api, 'wallet.clawback', inverseInput, {
      idempotencyKey: crypto.randomUUID(),
      undoes: credit.auditId,
    });
    expect(undo.auditId).not.toBe(credit.auditId);

    // Second undo: fresh key, distinct body (so the idempotency layer can't
    // absorb it), same `undoes` — the UNIQUE undoes claim refuses with a
    // conflict, never a second clawback.
    const secondUndo = await executeOpApi(
      api,
      'wallet.clawback',
      { ...inverseInput, reason: 'e2e second undo attempt' },
      { idempotencyKey: crypto.randomUUID(), undoes: credit.auditId }
    );
    expect(secondUndo.status()).toBe(409);

    // The pair netted to zero and stayed there.
    const after = await fetchWallet(api, { email: target.email }, 'purchased');
    expect(after.balanceNanoUsd).toBe(wallet.balanceNanoUsd);

    // Exactly one clawback row claims this credit's undo slot.
    const clawbacks = await fetchAuditRows(api, {
      action: 'wallet.clawback',
      targetId: wallet.id,
    });
    expect(clawbacks.filter((row) => row.undoes === credit.auditId)).toHaveLength(1);
  });

  test('idempotency: same key + body replays the stored result; same key + different body conflicts', async ({
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const wallet = await fetchWallet(api, { email: target.email }, 'purchased');
    const idempotencyKey = crypto.randomUUID();
    const input = {
      walletId: wallet.id,
      amountNanoUsd: '3000000000',
      reason: 'e2e replay credit',
    };

    const first = await executeOpOk(api, 'wallet.credit', input, { idempotencyKey });

    // Replay: identical key + body returns the STORED result — same audit
    // row id, no second effect.
    const replay = await executeOpOk(api, 'wallet.credit', input, { idempotencyKey });
    expect(replay.auditId).toBe(first.auditId);

    // Same key, different body: the canonical body-hash mismatch conflicts.
    const mismatch = await executeOpApi(
      api,
      'wallet.credit',
      { ...input, amountNanoUsd: '4000000000' },
      { idempotencyKey }
    );
    expect(mismatch.status()).toBe(409);

    // Exactly one audit row and exactly one balance change happened.
    const rows = await fetchAuditRows(api, { action: 'wallet.credit', targetId: wallet.id });
    expect(rows).toHaveLength(1);
    const after = await fetchWallet(api, { email: target.email }, 'purchased');
    expect(BigInt(after.balanceNanoUsd) - BigInt(wallet.balanceNanoUsd)).toBe(3_000_000_000n);
  });
});
