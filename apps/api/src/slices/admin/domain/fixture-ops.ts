import { z } from 'zod';
import { NanoUSD, defineAdminOpContract, serializeNanoUSD } from '@hushbox/shared';
import { conflictError } from '../../../lib/errors/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { createAdminOpRegistry, defineAdminOp } from './registry.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { AdminOpRegistry } from './registry.js';

/**
 * Test-only fixture ops proving the engine and the `describeAdminOp` battery
 * end-to-end without a real op (real ops live under `domain/operations/`).
 * A durable inverse pair over a scratch effect plus an ephemeral op; never
 * exported from the slice barrel, never mounted.
 */

/** The scratch durable effect, injected by tests (the port the fixture composes). */
export interface AdminFixtureScratch {
  markWithinTx(tx: SettlementTx, targetId: string): Promise<'marked' | 'already-marked'>;
  unmarkWithinTx(tx: SettlementTx, targetId: string): Promise<void>;
}

export interface AdminFixtureDeps {
  readonly scratch: AdminFixtureScratch;
  /** Post-commit side-channel the ephemeral effects append to. */
  readonly ephemeralLog: string[];
  /** Armed by tests to make every registered ephemeral effect throw. */
  readonly ephemeralFailure: { armed: boolean };
}

/** Guardrail cap exercised by the battery's guardrail-trip case. */
export const FIXTURE_AMOUNT_CAP_NANO_USD = 1_000_000_000n;

const reason = z.string().trim().min(1);

const fixtureInput = z.object({
  targetId: z.uuid(),
  amountNanoUsd: NanoUSD,
  reason,
});

export const fixtureMarkContract = defineAdminOpContract({
  name: 'fixture.mark',
  title: 'Mark fixture target',
  kind: 'mutation',
  input: fixtureInput,
  inverse: 'fixture.unmark',
  effectClass: 'durable',
  guardrails: { maxAmountNanoUsd: FIXTURE_AMOUNT_CAP_NANO_USD },
});

export const fixtureUnmarkContract = defineAdminOpContract({
  name: 'fixture.unmark',
  title: 'Unmark fixture target',
  kind: 'mutation',
  input: fixtureInput,
  inverse: 'fixture.mark',
  effectClass: 'durable',
  guardrails: { maxAmountNanoUsd: FIXTURE_AMOUNT_CAP_NANO_USD },
});

export const fixturePingContract = defineAdminOpContract({
  name: 'fixture.ping',
  title: 'Ping fixture target',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: null,
  effectClass: 'ephemeral',
});

function pushEphemeral(deps: AdminFixtureDeps, entry: string): void {
  if (deps.ephemeralFailure.armed) {
    throw new Error('fixture ephemeral effect armed to fail');
  }
  deps.ephemeralLog.push(entry);
}

const fixtureMark = defineAdminOp<AdminFixtureDeps, typeof fixtureMarkContract.input>(
  fixtureMarkContract,
  {
    async execute(ctx, input) {
      const marked = await ctx.deps.scratch.markWithinTx(ctx.tx, input.targetId);
      if (marked === 'already-marked') {
        return err(conflictError('fixture target is already marked'));
      }
      ctx.registerEphemeral({
        name: 'fixture.mark.notify',
        run: () => {
          pushEphemeral(ctx.deps, `marked:${input.targetId}`);
          return Promise.resolve();
        },
      });
      return ok({
        effects: [{ label: 'fixture.marked', before: null, after: input.targetId }],
        target: { type: 'fixture', id: input.targetId },
        // Inverse snapshot semantics: captured from execute-time state.
        inverseInput: {
          targetId: input.targetId,
          amountNanoUsd: serializeNanoUSD(input.amountNanoUsd),
          reason: `undo of fixture.mark on ${input.targetId}`,
        },
      });
    },
  }
);

const fixtureUnmark = defineAdminOp<AdminFixtureDeps, typeof fixtureUnmarkContract.input>(
  fixtureUnmarkContract,
  {
    async execute(ctx, input) {
      await ctx.deps.scratch.unmarkWithinTx(ctx.tx, input.targetId);
      return ok({
        effects: [{ label: 'fixture.unmarked', before: input.targetId, after: null }],
        target: { type: 'fixture', id: input.targetId },
        inverseInput: {
          targetId: input.targetId,
          amountNanoUsd: serializeNanoUSD(input.amountNanoUsd),
          reason: `undo of fixture.unmark on ${input.targetId}`,
        },
      });
    },
  }
);

const fixturePing = defineAdminOp<AdminFixtureDeps, typeof fixturePingContract.input>(
  fixturePingContract,
  {
    execute(ctx, input) {
      ctx.registerEphemeral({
        name: 'fixture.ping.notify',
        run: () => {
          pushEphemeral(ctx.deps, `ping:${input.targetId}`);
          return Promise.resolve();
        },
      });
      return Promise.resolve(
        ok({
          effects: [{ label: 'fixture.pinged', after: input.targetId }],
          target: { type: 'fixture', id: input.targetId },
        })
      );
    },
  }
);

export function createAdminFixtureRegistry(): AdminOpRegistry<AdminFixtureDeps> {
  return createAdminOpRegistry<AdminFixtureDeps>([fixtureMark, fixtureUnmark, fixturePing]);
}
