import { describe, expect, it } from 'vitest';
import type { AnyAdminOpContract } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { AdminOpEngine, AdminOpEngineHooks, AdminOpRunResult } from './engine.js';

/**
 * The reusable per-op test battery (`describeAdminOp`) — every registered op
 * ships one invocation of this harness; later op tasks parameterize it with
 * their own wiring. It is test tooling that lives beside the engine so the
 * battery and the engine version together; it is imported only by test
 * files and never exported from the slice barrel.
 *
 * Battery (per the slice CLAUDE.md): preview ≡ execute with preview
 * committing nothing; audit atomicity under an injected failure; idempotent
 * replay; guardrail refusal in both modes (audited on execute); input
 * validation; for durable ops — undo produces the inverse effects, threads
 * `undoes`, nets the projection to zero, and a second undo fails the unique
 * claim; ephemeral effects run post-commit only and their failure never
 * fails the op. Ops that opt in via `interleaving` additionally get the
 * seeded Iron Law interleaving-invariance property test (execute → seeded
 * user actions → undo ≡ the same actions alone) and the concurrent
 * double-execute-one-key race.
 */

/** Deterministic pseudo-random stream in [0, 1) — the replay artifact is the seed. */
export type SeededRng = () => number;

/** mulberry32: tiny, dependency-free, stable across runtimes. */
export function seededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * One user/system action the Iron Law's `U₁…Uₙ` sequence draws from. Actions
 * must be feasible on any fresh harness whether or not the op ran (the
 * Charter's feasibility rule — never gate on op state), and any randomness
 * must come from the passed rng so the control and op runs consume identical
 * streams.
 */
export interface AdminOpInterleavingAction {
  readonly name: string;
  run(harness: AdminOpHarnessInstance, rng: SeededRng): Promise<void>;
}

/**
 * Opt-in config for the seeded interleaving-invariance battery (money ops,
 * and any durable op whose delta must net to zero across interleavings).
 * Harness projections must be comparable across fresh instances (normalized
 * — no per-instance ids), because the Iron Law test compares an op run
 * against a control harness that never ran the op.
 */
export interface AdminOpInterleavingConfig {
  /** Mandated seeds — a failing test names its seed, which replays it exactly. */
  readonly seeds: readonly number[];
  readonly stepsPerSeed: number;
  /** Fresh valid wire-shape input targeting THIS harness's domain state. */
  opInput(harness: AdminOpHarnessInstance): Record<string, unknown>;
  readonly actions: readonly AdminOpInterleavingAction[];
  /** Optional post-condition (e.g. a scoped conservation audit) per run. */
  afterRun?(harness: AdminOpHarnessInstance): Promise<void>;
}

/** Exported for the harness's own unit tests (the guard arms). */
export async function runSeededActions(
  harness: AdminOpHarnessInstance,
  interleaving: AdminOpInterleavingConfig,
  rng: SeededRng
): Promise<void> {
  for (let step = 0; step < interleaving.stepsPerSeed; step += 1) {
    const action = interleaving.actions[Math.floor(rng() * interleaving.actions.length)];
    if (action === undefined) {
      throw new Error('describeAdminOp: interleaving requires at least one action');
    }
    await action.run(harness, rng);
  }
}

export interface AdminOpEphemeralProbes {
  /** The post-commit side-channel the op's ephemeral effects write to. */
  log(): readonly string[];
  /** Makes every subsequent ephemeral effect throw. */
  armFailure(): void;
}

/** One freshly-wired engine plus the probes the battery asserts against. */
export interface AdminOpHarnessInstance {
  readonly engine: AdminOpEngine;
  readonly actor: string;
  /** Effective-state projection over the op's domain (net-zero comparisons). */
  projection(): Promise<unknown>;
  /** Committed audit rows attributable to this instance's actor. */
  auditCount(): Promise<number>;
  /** Required when the op registers post-commit ephemeral effects. */
  readonly ephemeral?: AdminOpEphemeralProbes;
}

export interface DescribeAdminOpConfig {
  readonly contract: AnyAdminOpContract;
  /** Fresh, isolated wiring per test (unique actor, empty projection). */
  createHarness(options?: { hooks?: AdminOpEngineHooks }): Promise<AdminOpHarnessInstance>;
  /** Fresh valid wire-shape input (unique target per call). */
  validInput(): Record<string, unknown>;
  readonly invalidInput: Record<string, unknown>;
  /** Required when the contract declares guardrails. */
  overGuardrailInput?(): Record<string, unknown>;
  /** Set when the op registers post-commit ephemeral effects. */
  readonly hasEphemeralEffects?: boolean;
  /** Opt-in: seeded Iron Law interleaving battery (durable ops only). */
  readonly interleaving?: AdminOpInterleavingConfig;
}

/**
 * Classifies a concurrent same-key double-execute: a loser may only be the
 * in-progress conflict; a late arrival replays the winner's stored result.
 * Exported for the harness's own unit tests (the race outcome is
 * nondeterministic in vivo, so the guard arms are covered directly).
 */
export function winnerOfConcurrentRace(
  results: readonly Result<AdminOpRunResult, DomainError>[]
): AdminOpRunResult {
  const committed: AdminOpRunResult[] = [];
  for (const result of results) {
    if (result.isOk()) {
      committed.push(result.value);
    } else {
      expect(result.error.code).toBe('conflict');
    }
  }
  const winner = committed[0];
  if (winner === undefined) {
    throw new Error('describeAdminOp: concurrent double-execute committed nothing');
  }
  if (committed.length === 2) {
    expect(committed[1]).toEqual(winner);
  }
  return winner;
}

/** Exported for the harness's own unit tests (the guard arms). */
export function ephemeralProbes(harness: AdminOpHarnessInstance): AdminOpEphemeralProbes {
  if (harness.ephemeral === undefined) {
    throw new Error('describeAdminOp: hasEphemeralEffects requires harness.ephemeral probes');
  }
  return harness.ephemeral;
}

/** Exported for the harness's own unit tests (the guard arms). */
export function requiredInverse(contract: AnyAdminOpContract): string {
  if (contract.inverse === null) {
    throw new Error('describeAdminOp: durable contract without an inverse');
  }
  return contract.inverse;
}

/** Exported for the harness's own unit tests (the guard arms). */
export function requiredInverseInput(result: AdminOpRunResult): Record<string, unknown> {
  if (result.inverseInput === null) {
    throw new Error('describeAdminOp: durable op returned no inverseInput');
  }
  return result.inverseInput;
}

interface BatteryRun {
  readonly mode: 'preview' | 'execute';
  readonly key?: string;
  readonly undoes?: string;
}

function runAttempt(
  harness: AdminOpHarnessInstance,
  name: string,
  input: Record<string, unknown>,
  options: BatteryRun
): ReturnType<AdminOpEngine['run']> {
  return harness.engine.run({
    name,
    input,
    actor: harness.actor,
    mode: options.mode,
    ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
    ...(options.undoes === undefined ? {} : { undoes: options.undoes }),
  });
}

async function runOk(
  harness: AdminOpHarnessInstance,
  name: string,
  input: Record<string, unknown>,
  options: BatteryRun
): Promise<AdminOpRunResult> {
  const result = await runAttempt(harness, name, input, options);
  return result._unsafeUnwrap();
}

async function runErr(
  harness: AdminOpHarnessInstance,
  name: string,
  input: Record<string, unknown>,
  options: BatteryRun
): Promise<string> {
  const result = await runAttempt(harness, name, input, options);
  return result._unsafeUnwrapErr().code;
}

export function describeAdminOp(config: DescribeAdminOpConfig): void {
  const opName = config.contract.name;
  const durable = config.contract.effectClass === 'durable';

  describe(`admin op battery: ${opName}`, () => {
    it('preview returns the effect diff and commits nothing', async () => {
      const harness = await config.createHarness();
      const before = await harness.projection();

      const previewed = await runOk(harness, opName, config.validInput(), { mode: 'preview' });

      expect(previewed.effects.length).toBeGreaterThan(0);
      expect(await harness.projection()).toEqual(before);
      expect(await harness.auditCount()).toBe(0);
    });

    it('execute commits exactly the effects preview showed (one code path)', async () => {
      const harness = await config.createHarness();
      const input = config.validInput();
      const before = await harness.projection();

      const previewed = await runOk(harness, opName, input, { mode: 'preview' });
      const executed = await runOk(harness, opName, input, {
        mode: 'execute',
        key: crypto.randomUUID(),
      });

      expect(executed.effects).toEqual(previewed.effects);
      expect(await harness.auditCount()).toBe(1);
      if (durable) {
        expect(await harness.projection()).not.toEqual(before);
      } else {
        expect(await harness.projection()).toEqual(before);
      }
    });

    it('rolls back effects and audit together under an injected failure', async () => {
      const injected = new Error('injected admin failure after audit');
      const harness = await config.createHarness({
        hooks: {
          afterAudit: () => {
            throw injected;
          },
        },
      });
      const before = await harness.projection();

      await expect(
        runAttempt(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        })
      ).rejects.toThrow(injected.message);

      expect(await harness.projection()).toEqual(before);
      expect(await harness.auditCount()).toBe(0);
    });

    it('replays a repeated idempotency key without re-executing effects', async () => {
      const harness = await config.createHarness();
      const input = config.validInput();
      const key = crypto.randomUUID();

      const first = await runOk(harness, opName, input, { mode: 'execute', key });
      const afterFirst = await harness.projection();
      const replayed = await runOk(harness, opName, input, { mode: 'execute', key });

      expect(replayed).toEqual(first);
      expect(await harness.projection()).toEqual(afterFirst);
      expect(await harness.auditCount()).toBe(1);
    });

    it('rejects invalid input at the boundary with no committed effect', async () => {
      const harness = await config.createHarness();
      const before = await harness.projection();

      const code = await runErr(harness, opName, config.invalidInput, {
        mode: 'execute',
        key: crypto.randomUUID(),
      });

      expect(code).toBe('validation');
      expect(await harness.projection()).toEqual(before);
      expect(await harness.auditCount()).toBe(0);
    });

    it('rejects a missing reason at the boundary', async () => {
      const harness = await config.createHarness();
      const withoutReason = { ...config.validInput() };
      delete withoutReason['reason'];

      const code = await runErr(harness, opName, withoutReason, {
        mode: 'execute',
        key: crypto.randomUUID(),
      });

      expect(code).toBe('validation');
    });

    const overGuardrailInput = config.overGuardrailInput?.bind(config);
    if (overGuardrailInput) {
      it('refuses an over-guardrail input in both modes and audits the execute refusal', async () => {
        const harness = await config.createHarness();
        const before = await harness.projection();

        expect(await runErr(harness, opName, overGuardrailInput(), { mode: 'preview' })).toBe(
          'forbidden'
        );
        expect(await harness.auditCount()).toBe(0);

        expect(
          await runErr(harness, opName, overGuardrailInput(), {
            mode: 'execute',
            key: crypto.randomUUID(),
          })
        ).toBe('forbidden');

        expect(await harness.auditCount()).toBe(1);
        expect(await harness.projection()).toEqual(before);
      });
    }

    if (durable) {
      it('undo runs the inverse, threads undoes, and nets the projection to zero', async () => {
        const harness = await config.createHarness();
        const baseline = await harness.projection();
        const inverseName = requiredInverse(config.contract);

        const executed = await runOk(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        });

        const undone = await runOk(harness, inverseName, requiredInverseInput(executed), {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: executed.auditId,
        });

        expect(undone.effects.length).toBeGreaterThan(0);
        expect(await harness.projection()).toEqual(baseline);
        expect(await harness.auditCount()).toBe(2);
      });

      it('refuses a second undo of the same audit row (unique undoes claim)', async () => {
        const harness = await config.createHarness();
        const inverseName = requiredInverse(config.contract);

        const executed = await runOk(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        });
        const inverseInput = requiredInverseInput(executed);
        await runOk(harness, inverseName, inverseInput, {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: executed.auditId,
        });

        const code = await runErr(harness, inverseName, inverseInput, {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: executed.auditId,
        });

        expect(code).toBe('conflict');
      });
    }

    const interleaving = config.interleaving;
    if (interleaving !== undefined) {
      for (const seed of interleaving.seeds) {
        it(`nets its delta to zero across a seeded interleaving (Iron Law, seed ${String(seed)})`, async () => {
          const inverseName = requiredInverse(config.contract);

          const control = await config.createHarness();
          await runSeededActions(control, interleaving, seededRng(seed));
          const controlProjection = await control.projection();

          const harness = await config.createHarness();
          const executed = await runOk(harness, opName, interleaving.opInput(harness), {
            mode: 'execute',
            key: crypto.randomUUID(),
          });
          await runSeededActions(harness, interleaving, seededRng(seed));
          await runOk(harness, inverseName, requiredInverseInput(executed), {
            mode: 'execute',
            key: crypto.randomUUID(),
            undoes: executed.auditId,
          });

          expect(await harness.projection()).toEqual(controlProjection);
          await interleaving.afterRun?.(control);
          await interleaving.afterRun?.(harness);
        });
      }

      it('commits exactly one effect under a concurrent double-execute of one key', async () => {
        const inverseName = requiredInverse(config.contract);
        const harness = await config.createHarness();
        const baseline = await harness.projection();
        const input = interleaving.opInput(harness);
        const key = crypto.randomUUID();

        const attempt = (): ReturnType<AdminOpEngine['run']> =>
          runAttempt(harness, opName, input, { mode: 'execute', key });
        const results = await Promise.all([attempt(), attempt()]);

        const winner = winnerOfConcurrentRace(results);
        expect(await harness.auditCount()).toBe(1);

        // Exactly one committed effect: a single undo restores the baseline.
        await runOk(harness, inverseName, requiredInverseInput(winner), {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: winner.auditId,
        });
        expect(await harness.projection()).toEqual(baseline);
        await interleaving.afterRun?.(harness);
      });
    }

    if (config.hasEphemeralEffects === true) {
      it('runs ephemeral effects only after a committed execute, never in preview', async () => {
        const harness = await config.createHarness();
        const ephemeral = ephemeralProbes(harness);
        const input = config.validInput();

        await runOk(harness, opName, input, { mode: 'preview' });
        expect(ephemeral.log()).toEqual([]);

        await runOk(harness, opName, input, { mode: 'execute', key: crypto.randomUUID() });
        expect(ephemeral.log().length).toBe(1);
      });

      it('does not run ephemeral effects when the transaction rolls back', async () => {
        const harness = await config.createHarness({
          hooks: {
            afterAudit: () => {
              throw new Error('injected rollback');
            },
          },
        });
        const ephemeral = ephemeralProbes(harness);

        await expect(
          runAttempt(harness, opName, config.validInput(), {
            mode: 'execute',
            key: crypto.randomUUID(),
          })
        ).rejects.toThrow('injected rollback');

        expect(ephemeral.log()).toEqual([]);
      });

      it('does not fail the executed op when an ephemeral effect fails', async () => {
        const harness = await config.createHarness();
        const ephemeral = ephemeralProbes(harness);
        ephemeral.armFailure();

        const executed = await runOk(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        });

        expect(executed.auditId).toBeTruthy();
        expect(await harness.auditCount()).toBe(1);
        expect(ephemeral.log()).toEqual([]);
      });
    }
  });
}
