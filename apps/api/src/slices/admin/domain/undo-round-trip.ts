import { isDeepStrictEqual } from 'node:util';
import type { AnyAdminOpContract } from '@hushbox/shared';
import type { AdminOpEngine, AdminOpRunResult } from './engine.js';

/**
 * The registry-driven undo round-trip harness. For any durable admin op it
 * captures a state snapshot, executes the op through the REAL engine, runs the
 * op's REGISTERED inverse as an undo (threading `undoes` and the op's own
 * captured `inverseInput`), snapshots again, and reports whether the post-undo
 * state equals the pre-execute snapshot.
 *
 * This proves inverse *correctness* — that an inverse actually restores state,
 * not merely that one is registered (the registry gate) or that a battery
 * exists (coverage). A wrong inverse leaves `restored === false`; callers turn
 * that into a build failure. The equality is over the harness's own
 * effective-state projection, so append-only trails (audit rows, ledger legs)
 * and timestamps — excluded from the Iron Law projection by design — never
 * appear and never make a correct inverse look wrong.
 *
 * The harness is deliberately assertion-free (no vitest import): it returns the
 * raw snapshots so a caller may compare them with whatever equality its suite
 * uses, plus a `restored` convenience computed by structural deep-equality.
 */
export interface UndoRoundTripHarness {
  readonly engine: AdminOpEngine;
  readonly actor: string;
  /** Effective-state projection over the op's domain (Iron Law `≡ₑ`). */
  projection(): Promise<unknown>;
}

export interface UndoRoundTripResult {
  /** Projection captured before the op executed. */
  readonly baseline: unknown;
  /** Projection captured after execute, before undo. */
  readonly afterExecute: unknown;
  /** Projection captured after the registered inverse ran as undo. */
  readonly afterUndo: unknown;
  readonly executed: AdminOpRunResult;
  readonly undone: AdminOpRunResult;
  /** `afterUndo` deep-equals `baseline` — the Iron Law round-trip held. */
  readonly restored: boolean;
}

export async function runUndoRoundTrip(
  harness: UndoRoundTripHarness,
  contract: AnyAdminOpContract,
  validInput: Record<string, unknown>
): Promise<UndoRoundTripResult> {
  const inverseName = contract.inverse;
  if (inverseName === null) {
    throw new Error(
      `runUndoRoundTrip: ${contract.name} is not durable-invertible (no registered inverse)`
    );
  }

  const baseline = await harness.projection();

  const executedResult = await harness.engine.run({
    name: contract.name,
    input: validInput,
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
  });
  if (executedResult.isErr()) {
    throw new Error(
      `runUndoRoundTrip: ${contract.name} failed to execute: ${executedResult.error.code}`
    );
  }
  const executed = executedResult.value;
  const afterExecute = await harness.projection();

  if (executed.inverseInput === null) {
    throw new Error(`runUndoRoundTrip: durable op ${contract.name} returned no inverseInput`);
  }

  const undoneResult = await harness.engine.run({
    name: inverseName,
    input: executed.inverseInput,
    actor: harness.actor,
    mode: 'execute',
    idempotencyKey: crypto.randomUUID(),
    undoes: executed.auditId,
  });
  if (undoneResult.isErr()) {
    throw new Error(
      `runUndoRoundTrip: inverse ${inverseName} failed to undo ${contract.name}: ` +
        undoneResult.error.code
    );
  }
  const undone = undoneResult.value;
  const afterUndo = await harness.projection();

  return {
    baseline,
    afterExecute,
    afterUndo,
    executed,
    undone,
    restored: isDeepStrictEqual(afterUndo, baseline),
  };
}
