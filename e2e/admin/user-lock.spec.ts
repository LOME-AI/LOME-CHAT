import { TEST_IDS } from '@hushbox/shared';
import { TIMEOUTS } from '../config/timeouts.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import { fetchCustomer360, openCustomer360 } from './helpers/customer-360.js';
import {
  clickUndo,
  executeAndAwaitResult,
  executeButton,
  executeOpApi,
  executeOpOk,
  expectPreviewDiff,
  fetchAuditRows,
  fillOpForm,
  opFieldInput,
  readAuditId,
  submitOpForm,
} from './helpers/op-modal.js';
import { mintLockedUser } from './helpers/targets.js';

/** The audit `details` shape the engine writes for an executed effect. */
interface AuditDetails {
  readonly effects?: readonly unknown[];
  readonly inverseInput?: Record<string, unknown> | null;
}

function detailsOf(row: { details: unknown }): AuditDetails {
  return row.details as AuditDetails;
}

/**
 * The user containment lifecycle: `user.lock` ↔ `user.unlock` (durable pair
 * with inverse SNAPSHOT semantics — undo restores the original lockReason,
 * never a default) plus the ephemeral `sessions.revokeAll`. State changes
 * are asserted via the admin API (rule 1.5); API-heavy traffic rides the
 * second dev actor to preserve the SPA actor's audited-read budget.
 */
test.describe('Admin user lock lifecycle', () => {
  test('unlock through Customer-360, then undo re-locks with the original chargeback reason', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    // A minted target arrives chargeback-locked — exactly the snapshot the
    // undo must restore.
    const target = await mintLockedUser(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);

    // The 360 header exposes the remediation op for the loaded state.
    await openCustomer360(adminPage, target.email);
    await adminPage.getByRole('button', { name: 'Unlock account' }).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await expect(opFieldInput(adminPage, 'userId')).toHaveValue(target.userId);

    await fillOpForm(adminPage, { reason: 'e2e unlock journey' });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Unlock account \(\d+ changes?\)$/);
    await executeAndAwaitResult(adminPage);
    const unlockAuditId = await readAuditId(adminPage);

    // API truth: the account is unlocked.
    const afterUnlock = await fetchCustomer360(api, { userId: target.userId });
    expect(afterUnlock.user.lockedAt).toBeNull();
    expect(afterUnlock.user.lockReason).toBeNull();

    // Undo: the inverse user.lock opens prefilled from inverseInput — with
    // the ORIGINAL 'chargeback' reason (the snapshot), not a default.
    await clickUndo(adminPage);
    await expect(opFieldInput(adminPage, 'userId')).toHaveValue(target.userId);
    await expect(opFieldInput(adminPage, 'lockReason')).toContainText('chargeback');
    await expect(opFieldInput(adminPage, 'reason')).not.toHaveValue('');
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await expect(executeButton(adminPage)).toHaveText(/^Lock account \(\d+ changes?\)$/);
    await executeAndAwaitResult(adminPage);
    const relockAuditId = await readAuditId(adminPage);
    expect(relockAuditId).not.toBe(unlockAuditId);

    // API truth: re-locked with the snapshot lockReason.
    const afterUndo = await fetchCustomer360(api, { userId: target.userId });
    expect(afterUndo.user.lockedAt).not.toBeNull();
    expect(afterUndo.user.lockReason).toBe('chargeback');

    // The trail is doubly linked: the re-lock's `undoes` names the unlock
    // row, and the unlock row's `undoneBy` names the re-lock.
    const trail = await fetchAuditRows(api, { targetId: target.userId, limit: 50 });
    const unlockRow = trail.find((row) => row.id === unlockAuditId);
    const relockRow = trail.find((row) => row.id === relockAuditId);
    expect(unlockRow?.action).toBe('user.unlock');
    expect(relockRow?.action).toBe('user.lock');
    expect(relockRow?.undoes).toBe(unlockAuditId);
    expect(unlockRow?.undoneBy).toBe(relockAuditId);
  });

  test('lock revokes sessions in the same execute and never clobbers a standing lock', async ({
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);

    // The mint arrives locked; unlock via the op surface to get a disposable
    // UNLOCKED user (minted targets are not loginable — op targets only).
    await executeOpOk(
      api,
      'user.unlock',
      { userId: target.userId, reason: 'e2e lock setup unlock' },
      { idempotencyKey: crypto.randomUUID() }
    );

    // Lock: ONE execute, TWO effects — the durable lock flag and the session
    // revocation enqueued in the same settlement transaction.
    const lock = await executeOpOk(
      api,
      'user.lock',
      { userId: target.userId, lockReason: 'admin', reason: 'e2e admin lock' },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(lock.effects.map((effect) => effect.label)).toEqual(['user.lock', 'user.sessions']);

    const view = await fetchCustomer360(api, { userId: target.userId });
    expect(view.user.lockedAt).not.toBeNull();
    expect(view.user.lockReason).toBe('admin');

    // The committed audit row carries both effects too.
    const lockRows = await fetchAuditRows(api, { action: 'user.lock', targetId: target.userId });
    expect(lockRows).toHaveLength(1);
    expect(detailsOf(lockRows[0]!).effects).toHaveLength(2);

    // Conflict moment: a second lock (fresh key, different body so the
    // idempotency layer cannot absorb it) refuses — the standing lock and
    // its undo snapshot are never clobbered.
    const second = await executeOpApi(
      api,
      'user.lock',
      { userId: target.userId, lockReason: 'chargeback', reason: 'e2e second lock attempt' },
      { idempotencyKey: crypto.randomUUID() }
    );
    expect(second.status()).toBe(409);

    // Nothing changed: still exactly one committed lock row.
    const rowsAfterConflict = await fetchAuditRows(api, {
      action: 'user.lock',
      targetId: target.userId,
    });
    expect(rowsAfterConflict).toHaveLength(1);
  });

  test('sessions.revokeAll is audited but ephemeral: the result step offers no undo', async ({
    adminPage,
    adminApi,
    request,
  }) => {
    const target = await mintLockedUser(request);
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);

    await openCustomer360(adminPage, target.email);
    await adminPage.getByRole('button', { name: 'Revoke all sessions' }).click();
    await expect(adminPage.getByTestId(TEST_IDS.adminOpModal)).toBeVisible({
      timeout: TIMEOUTS.MODAL,
    });
    await expect(opFieldInput(adminPage, 'userId')).toHaveValue(target.userId);

    await fillOpForm(adminPage, { reason: 'e2e revoke all sessions' });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await executeAndAwaitResult(adminPage);
    const auditId = await readAuditId(adminPage);

    // Ephemeral class: session state is recreated by logging in again, so
    // there is nothing to undo — the result step renders no Undo button.
    await expect(adminPage.getByTestId(TEST_IDS.adminOpUndo)).toHaveCount(0);

    // The audit row exists, carries no inverseInput, and joins no undo chain.
    const rows = await fetchAuditRows(api, {
      action: 'sessions.revokeAll',
      targetId: target.userId,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(auditId);
    expect(detailsOf(row).inverseInput).toBeNull();
    expect(row.undoes).toBeNull();
    expect(row.undoneBy).toBeNull();
  });
});
