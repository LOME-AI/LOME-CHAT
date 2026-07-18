import { TEST_IDS } from '@hushbox/shared';
import { fetchFeedbackByEmail } from '../helpers/feedback.js';
import { test, expect } from './fixtures.js';
import { DEV_ADMIN_ACTORS } from './helpers/actors.js';
import {
  feedbackRowById,
  openFeedbackDetail,
  openFeedbackInbox,
  openSetStatusOp,
  provisionFeedbackActor,
  selectOpStatus,
  submitFeedbackViaApi,
} from './helpers/feedback.js';
import {
  clickUndo,
  executeAndAwaitResult,
  expectPreviewDiff,
  fetchAuditRows,
  fillOpForm,
  opFieldInput,
  readAuditId,
  submitOpForm,
} from './helpers/op-modal.js';

/** The audit `details` shape the engine writes for an executed effect. */
interface AuditEffect {
  readonly label: string;
  readonly before: unknown;
  readonly after: unknown;
}
interface AuditDetails {
  readonly effects?: readonly AuditEffect[];
}
function effectsOf(row: { details: unknown }): readonly AuditEffect[] {
  return (row.details as AuditDetails).effects ?? [];
}

const FRESH_PASSWORD = 'TestPassword123!';

/**
 * The feedback inbox triage lifecycle: a REAL submission surfaces in the admin
 * inbox, its full body rides the audited detail read, and the `feedback.setStatus`
 * op transitions it (self-inverse: undo restores the prior status). State changes
 * are asserted against DB truth via the dev read-back (rule 1.5); the audited
 * detail read and the op effects are asserted on the wire.
 *
 * READ BUDGET: the SPA actor (DEV_ADMIN_ACTORS[0]) spends feedback reads of
 * 240/hr — 1 inbox load + 1 audited detail load, then (each op execute
 * invalidates the admin query root) 1 inbox + 1 detail refetch per execute × 2
 * executes = ~6 total. The second dev actor spends 3 audit reads of 240/hr (the
 * read.feedbackView count, then the setStatus rows after resolve and after undo).
 */
test.describe('Admin feedback triage', () => {
  test('a submitted item surfaces, reads audited, resolves, and undo restores it', async ({
    adminPage,
    adminApi,
    browser,
    playwright,
    request,
  }) => {
    // Seed through the real POST /feedback as a freshly provisioned user.
    const seed = await provisionFeedbackActor(browser, playwright, request, FRESH_PASSWORD);
    const startMarker = crypto.randomUUID();
    const endMarker = crypto.randomUUID();
    // Body longer than the 140-char inbox preview so the inline detail's
    // full-body assertion is meaningful: startMarker lands in the preview,
    // endMarker only in the full body behind the audited detail read.
    const body = `E2E admin feedback ${startMarker} ${'detail '.repeat(30)}END-${endMarker}`;
    const feedbackId = await submitFeedbackViaApi(seed.api, { kind: 'bug', body });
    await seed.api.dispose();

    // The row surfaces in the inbox with its kind, fresh status, and preview.
    await openFeedbackInbox(adminPage);
    const row = feedbackRowById(adminPage, feedbackId);
    await expect(row).toBeVisible();
    await expect(row).toContainText('bug');
    await expect(row).toContainText('new');
    await expect(row).toContainText(startMarker);

    // The inline detail reads the FULL body (endMarker is beyond the truncated preview).
    await openFeedbackDetail(adminPage, feedbackId);
    await expect(adminPage.getByTestId(TEST_IDS.adminFeedbackDetail)).toContainText(endMarker);

    // Wire truth via the second actor: expanding the row was exactly one
    // audited read of this feedback item by the SPA actor.
    const api = await adminApi(DEV_ADMIN_ACTORS[1]);
    const reads = await fetchAuditRows(api, {
      action: 'read.feedbackView',
      targetId: feedbackId,
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]?.actor).toBe(DEV_ADMIN_ACTORS[0]);
    expect(reads[0]?.targetType).toBe('feedback');

    // Triage: set status to resolved through the detail row's op.
    await openSetStatusOp(adminPage, feedbackId);
    await selectOpStatus(adminPage, 'resolved');
    await fillOpForm(adminPage, { reason: 'e2e triage: resolving the report' });
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await executeAndAwaitResult(adminPage);
    const resolveAuditId = await readAuditId(adminPage);

    // DB truth: the row is now resolved.
    const afterResolve = await fetchFeedbackByEmail(request, seed.email);
    expect(afterResolve.find((r) => r.id === feedbackId)?.status).toBe('resolved');

    // Effect truth: exactly the new→resolved transition was audited.
    const resolveRows = await fetchAuditRows(api, {
      action: 'feedback.setStatus',
      targetId: feedbackId,
    });
    expect(resolveRows).toHaveLength(1);
    expect(resolveRows[0]?.id).toBe(resolveAuditId);
    expect(effectsOf(resolveRows[0]!)).toContainEqual(
      expect.objectContaining({ label: 'feedback.status', before: 'new', after: 'resolved' })
    );

    // Undo/reopen: the self-inverse op prefills the prior status ('new').
    await clickUndo(adminPage);
    await expect(opFieldInput(adminPage, 'status')).toContainText('new');
    await expect(opFieldInput(adminPage, 'reason')).not.toHaveValue('');
    await submitOpForm(adminPage);
    await expectPreviewDiff(adminPage);
    await executeAndAwaitResult(adminPage);
    const undoAuditId = await readAuditId(adminPage);

    // DB truth: the status is restored.
    const afterUndo = await fetchFeedbackByEmail(request, seed.email);
    expect(afterUndo.find((r) => r.id === feedbackId)?.status).toBe('new');

    // Trail doubly linked: the undo's resolved→new effect names the resolve row.
    const finalRows = await fetchAuditRows(api, {
      action: 'feedback.setStatus',
      targetId: feedbackId,
    });
    const undoRow = finalRows.find((r) => r.id === undoAuditId);
    const resolveRow = finalRows.find((r) => r.id === resolveAuditId);
    expect(undoRow?.undoes).toBe(resolveAuditId);
    expect(resolveRow?.undoneBy).toBe(undoAuditId);
    expect(effectsOf(undoRow!)).toContainEqual(
      expect.objectContaining({ label: 'feedback.status', before: 'resolved', after: 'new' })
    );
  });
});
