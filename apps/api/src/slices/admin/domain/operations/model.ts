import { ADMIN_OP_CONTRACTS } from '@hushbox/shared';
import { conflictError } from '../../../../lib/errors/index.js';
import { err, ok } from '../../../../lib/result/index.js';
import { disableModelWithinTx, enableModelWithinTx } from '../../../models/index.js';
import { defineAdminOp } from '../registry.js';
import type { AdminOpsClock } from './user.js';

/**
 * The catalog kill switch — the durable pair `model.disable` ↔ `model.enable`
 * over models' published within-tx writes. The catalog refresh upsert never
 * touches `admin_disabled_at`, so a set flag survives every refresh; the
 * already-done outcomes refuse rather than re-apply, so a second disable's
 * undo can never re-enable a model an earlier actor disabled.
 */

const disableContract = ADMIN_OP_CONTRACTS['model.disable'];
const enableContract = ADMIN_OP_CONTRACTS['model.enable'];

export interface AdminModelDeps {
  readonly clock: AdminOpsClock;
}

export const modelDisable = defineAdminOp<AdminModelDeps, (typeof disableContract)['input']>(
  disableContract,
  {
    execute: async (ctx, input) => {
      const outcome = await disableModelWithinTx(ctx.tx, input.modelId, ctx.deps.clock.now());
      if (outcome.isErr()) return err(outcome.error);
      if (outcome.value === 'already-disabled') {
        return err(conflictError('model is already disabled'));
      }
      // `admin_audit.target_id` is text, so provider model id strings are
      // first-class audit-search targets.
      return ok({
        target: { type: 'model', id: input.modelId },
        effects: [{ label: 'model.adminDisabled', before: false, after: true }],
        inverseInput: {
          modelId: input.modelId,
          reason: `undo of model.disable on model ${input.modelId}`,
        },
      });
    },
  }
);

export const modelEnable = defineAdminOp<AdminModelDeps, (typeof enableContract)['input']>(
  enableContract,
  {
    execute: async (ctx, input) => {
      const outcome = await enableModelWithinTx(ctx.tx, input.modelId);
      if (outcome.isErr()) return err(outcome.error);
      if (outcome.value === 'already-enabled') {
        return err(conflictError('model is already enabled'));
      }
      return ok({
        target: { type: 'model', id: input.modelId },
        effects: [{ label: 'model.adminDisabled', before: true, after: false }],
        inverseInput: {
          modelId: input.modelId,
          reason: `undo of model.enable on model ${input.modelId}`,
        },
      });
    },
  }
);
