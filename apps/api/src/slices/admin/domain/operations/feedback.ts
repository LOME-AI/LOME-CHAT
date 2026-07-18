import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { err, ok } from '../../../../lib/result/index.js';
import { setFeedbackStatusWithinTx } from '../../../feedback/index.js';
import { defineAdminOp } from '../registry.js';

/**
 * The feedback triage transition — the self-inverse `feedback.setStatus` over
 * the feedback slice's published within-tx write. Setting a status is undone by
 * setting the PRIOR status back, so the op is its own registered inverse: the
 * body snapshots the prior status (returned by `setFeedbackStatusWithinTx` under
 * the row's `FOR UPDATE` lock) into `inverseInput`, so undo restores the exact
 * prior status, never a default (inverse snapshot semantics). No slice deps are
 * injected — it composes only the engine-owned settlement transaction.
 */

const setStatusContract = ADMIN_OP_CONTRACTS['feedback.setStatus'];

/** feedback.setStatus composes only `ctx.tx`; it injects no slice dependencies. */
export type AdminFeedbackDeps = Record<never, never>;

export const feedbackSetStatus = defineAdminOp<
  AdminFeedbackDeps,
  (typeof setStatusContract)['input']
>(setStatusContract, {
  execute: async (ctx, input) => {
    const outcome = await setFeedbackStatusWithinTx(ctx.tx, {
      feedbackId: input.feedbackId,
      status: input.status,
    });
    if (outcome.isErr()) return err(outcome.error);
    const { priorStatus } = outcome.value;
    return ok({
      effects: [{ label: 'feedback.status', before: priorStatus, after: input.status }],
      target: { type: 'feedback', id: input.feedbackId },
      inverseInput: {
        feedbackId: input.feedbackId,
        status: priorStatus,
        reason: input.reason,
      },
    });
  },
});
