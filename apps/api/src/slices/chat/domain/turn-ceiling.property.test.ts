/**
 * The answer-sizing sweep. Every turn shape the regular chat build can produce is
 * compiled through the production path and then priced by the CANONICAL admission
 * estimator on that COMPILED definition — never by the sizing math itself.
 *
 * Pricing through `createEstimateRun` is the whole point: a property test over the
 * sizing arithmetic alone cannot see the integer-nano markup drift between a
 * rate-bearing guess and admission's subtotal markup, which is the drift that
 * caused live 402 refusals. The sweep drives `compileSingleTurn` /
 * `compileMultiModelTurn`, so the definition under test is the one a request
 * compiles, sized by the build's own derivation rather than a copy of it.
 */

import { describe, expect, it } from 'vitest';
import { nanoUSD } from '@hushbox/shared';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import { createEstimateRun } from '../../models/index.js';
import { CHAT_TURN_HOOKS, TRIAL_TURN_HOOKS } from './constants.js';
import {
  compileMultiModelTurn,
  compileSingleTurn,
  payerSpendableNanoUsd,
} from './turn-definition.js';
import type { TurnBudget } from './turn-definition.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type {
  ModelDescriptor,
  ModelReasoning,
  Node,
  ReasoningEffortSelection,
  WorkflowDefinition,
} from '@hushbox/shared';

interface ModelShape {
  readonly id: string;
  readonly inputPerToken: bigint;
  readonly outputPerToken: bigint;
  readonly contextLength: number;
  readonly maxOutputTokens?: number;
  readonly reasoning?: ModelReasoning;
}

function descriptorOf(shape: ModelShape): ModelDescriptor {
  return {
    id: shape.id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {
      contextLength: shape.contextLength,
      ...(shape.maxOutputTokens === undefined ? {} : { maxOutputTokens: shape.maxOutputTokens }),
    },
    pricing: {
      inputPerToken: nanoUSD(shape.inputPerToken),
      outputPerToken: nanoUSD(shape.outputPerToken),
    },
    ...(shape.reasoning === undefined ? {} : { reasoning: shape.reasoning }),
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

/**
 * Deliberately heterogeneous on every axis the ceiling reads: context window,
 * provider completion cap (present and absent), per-token rates spanning two
 * orders of magnitude, and one reasoning-capable model so the `B + H` arm of the
 * sizing is swept as well as the reasoning-free one.
 */
const CATALOG: readonly ModelDescriptor[] = [
  descriptorOf({
    id: 'wide',
    inputPerToken: 2000n,
    outputPerToken: 10_000n,
    contextLength: 128_000,
  }),
  descriptorOf({
    id: 'tight',
    inputPerToken: 2000n,
    outputPerToken: 10_000n,
    contextLength: 4000,
    maxOutputTokens: 4000,
  }),
  descriptorOf({
    id: 'pricey',
    inputPerToken: 40_000n,
    outputPerToken: 200_000n,
    contextLength: 64_000,
    maxOutputTokens: 8192,
  }),
  descriptorOf({
    id: 'reasoner',
    inputPerToken: 2000n,
    outputPerToken: 10_000n,
    contextLength: 32_000,
    maxOutputTokens: 16_000,
    reasoning: { supportedEfforts: ['low', 'medium', 'high'] },
  }),
];

const BY_ID = new Map(CATALOG.map((descriptor) => [descriptor.id, descriptor]));
const resolver: ModelPricingResolver = (id) => BY_ID.get(id);
const estimate = createEstimateRun(resolver);

const MODEL_SETS: readonly (readonly string[])[] = [
  ['wide'],
  ['tight'],
  ['pricey'],
  ['reasoner'],
  ['wide', 'tight'],
  ['reasoner', 'wide'],
  ['wide', 'pricey', 'tight'],
];
const PROMPT_CHARS: readonly number[] = [0, 400, 4000, 40_000];
const REMAINDERS: readonly bigint[] = [1n, 5_000_000n, 50_000_000n, 5_000_000_000n];
const KINDS = ['purchased', 'free'] as const;
const EFFORTS: readonly (ReasoningEffortSelection | undefined)[] = [undefined, 'low'];
/**
 * Both persistence arms. The trial arm is the one the earlier grid could not see:
 * its definition is left UNSTAMPED, and while the fit skipped unstamped turns the
 * arm carried a wire cap with no money term at all — invisible to a sweep that only
 * built stamped turns, which is why it reached a single route pin instead. A
 * multi-model turn is paid-only, so only the single-model sets carry both.
 */
const HOOKS = [
  { label: 'paid', hooks: CHAT_TURN_HOOKS },
  { label: 'trial', hooks: TRIAL_TURN_HOOKS },
] as const;

interface SweptTurn {
  readonly label: string;
  readonly budget: TurnBudget;
  readonly definition: WorkflowDefinition;
}

interface GridPoint {
  readonly models: readonly string[];
  readonly promptCharacterCount: number;
  readonly remainingNanoUsd: bigint;
  readonly kind: (typeof KINDS)[number];
  readonly reasoningEffort: ReasoningEffortSelection | undefined;
  readonly persistence: (typeof HOOKS)[number];
}

/** The budget/effort axes of the grid, independent of the model set. */
interface Variation {
  readonly promptCharacterCount: number;
  readonly remainingNanoUsd: bigint;
  readonly kind: (typeof KINDS)[number];
  readonly reasoningEffort: ReasoningEffortSelection | undefined;
}

const VARIATIONS: readonly Variation[] = PROMPT_CHARS.flatMap((promptCharacterCount) =>
  REMAINDERS.flatMap((remainingNanoUsd) =>
    KINDS.flatMap((kind) =>
      EFFORTS.map((reasoningEffort) => ({
        promptCharacterCount,
        remainingNanoUsd,
        kind,
        reasoningEffort,
      }))
    )
  )
);

/** One model set's grid rows. A multi-model turn is paid-only, so it has no trial arm. */
function rowsFor(models: readonly string[]): readonly GridPoint[] {
  const arms = models.length === 1 ? HOOKS : HOOKS.slice(0, 1);
  return VARIATIONS.flatMap((variation) =>
    arms.map((persistence) => ({ models, ...variation, persistence }))
  );
}

const GRID: readonly GridPoint[] = MODEL_SETS.flatMap((models) => rowsFor(models));

interface Sweep {
  readonly turns: readonly SweptTurn[];
  /** Grid points the build refused with a typed 400 — no definition to price. */
  readonly refusedLabels: readonly string[];
}

function labelOf(point: GridPoint): string {
  return [
    point.models.join('+'),
    `chars=${String(point.promptCharacterCount)}`,
    `remaining=${String(point.remainingNanoUsd)}`,
    point.kind,
    `effort=${point.reasoningEffort ?? 'none'}`,
    point.persistence.label,
  ].join(' ');
}

/** Every grid point compiled through the production build. */
function sweep(): Sweep {
  const turns: SweptTurn[] = [];
  const refusedLabels: string[] = [];
  for (const point of GRID) {
    const budget: TurnBudget = {
      promptCharacterCount: point.promptCharacterCount,
      funding: { remainingNanoUsd: point.remainingNanoUsd, kind: point.kind },
    };
    const options = {
      budget,
      hooks: point.persistence.hooks,
      ...(point.reasoningEffort === undefined ? {} : { reasoningEffort: point.reasoningEffort }),
    };
    const label = labelOf(point);
    const [first = ''] = point.models;
    const compiled =
      point.models.length === 1
        ? compileSingleTurn(resolver, first, options)
        : compileMultiModelTurn(resolver, point.models, options);
    if (compiled.isErr()) refusedLabels.push(label);
    else turns.push({ label, budget, definition: compiled.value });
  }
  return { turns, refusedLabels };
}

const { turns: TURNS, refusedLabels: REFUSED } = sweep();

/**
 * The floor a reasoning turn's wire cap bottoms out at on this fixture: the `low`
 * level's own budget plus one minimum viable answer. Written as the two constants
 * rather than re-derived from the node, so the test states the floor instead of
 * agreeing with an implementation of it.
 */
const REASONING_FLOOR_CAP = REASONING_BUDGET_TOKENS_BY_EFFORT.low + MINIMUM_OUTPUT_TOKENS;

function answerCaps(definition: WorkflowDefinition): readonly (number | undefined)[] {
  return definition.nodes
    .filter((node) => node.type === 'modelCall')
    .map((node) => {
      const declared = node.params['maxOutputTokens'];
      return typeof declared === 'number' ? declared : undefined;
    });
}

/** Whether the sizing has nothing left to give on this node. */
function atOrBelowFloor(node: Node): boolean {
  if (node.type !== 'modelCall') return true;
  const cap = node.params['maxOutputTokens'];
  // No derivable cap means no reconcile ran and there is nothing to shrink — the
  // estimator prices the model's own hard cap and admission refuses.
  if (typeof cap !== 'number') return true;
  return (
    cap <= (node.params['reasoning'] === undefined ? MINIMUM_OUTPUT_TOKENS : REASONING_FLOOR_CAP)
  );
}

function pricedNanoUsd(turn: SweptTurn): bigint {
  return estimate(turn.definition)._unsafeUnwrap();
}

describe('every compiled turn is priced by the canonical admission estimator', () => {
  it('compiles 448 definitions from the grid and refuses 256 as typed 400s', () => {
    // 4 single-model sets × 2 persistence arms + 3 multi-model sets (paid-only), each
    // over 4 prompt sizes × 4 balances × 2 tiers × 2 effort selections = 704 grid
    // points. The refusals are the non-reasoning model sets at an explicit level: an
    // unsupported level refuses rather than substituting, so there is no definition
    // to price for those.
    expect(TURNS.length + REFUSED.length).toBe(704);
    expect(TURNS).toHaveLength(448);
    expect(REFUSED).toHaveLength(256);
  });

  it('sweeps both persistence arms, so the unstamped one cannot hide a defect again', () => {
    const unstamped = TURNS.filter((turn) => turn.definition.storage === undefined);
    const stamped = TURNS.filter((turn) => turn.definition.storage !== undefined);
    expect(unstamped.length).toBeGreaterThan(0);
    expect(stamped.length).toBeGreaterThan(0);
  });

  it('gives every compiled turn of every tier a wire cap, so none carries one with no money term', () => {
    // The regression this sweep exists to catch was a cap with no money term behind
    // it. A budgeted turn therefore always carries a numeric cap the estimator sized,
    // on the unstamped arm exactly as on the stamped one.
    const uncapped = TURNS.filter((turn) => answerCaps(turn.definition).includes(undefined));
    expect(uncapped.map((turn) => turn.label)).toEqual([]);
  });

  it('prices an unstamped turn strictly below its stamped twin, so trial pays no storage', () => {
    // §Trial Usage's "trial never persists" is unconditional, and §Math & Terms
    // prices `trialTurnCost` with no storage term at all. An unstamped definition
    // carries none BY CONSTRUCTION rather than by a second formula subtracting it,
    // which is what pricing it through `createEstimateRun` buys.
    const budget: TurnBudget = {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 5_000_000_000n, kind: 'purchased' },
    };
    const shared = { budget, hooks: CHAT_TURN_HOOKS };
    const paid = compileSingleTurn(resolver, 'wide', shared)._unsafeUnwrap();
    const trial = compileSingleTurn(resolver, 'wide', {
      ...shared,
      hooks: TRIAL_TURN_HOOKS,
    })._unsafeUnwrap();
    expect(trial.storage).toBeUndefined();
    expect(paid.storage).toEqual({ inputChars: 400, tier: 'paid' });
    expect(estimate(trial)._unsafeUnwrap()).toBeLessThan(estimate(paid)._unsafeUnwrap());
  });

  it('prices every one of them, so no compiled shape escapes the estimator', () => {
    const unpriceable = TURNS.filter((turn) => estimate(turn.definition).isErr()).map(
      (turn) => turn.label
    );
    expect(unpriceable).toEqual([]);
  });

  it('fits the estimator ceiling inside the payer funds, or has nothing left to shrink', () => {
    // `reserve ⊇ bill` leaves exactly two legal outcomes per turn: the fitted
    // ceiling is within the payer's spendable funds, or the sizing is already at
    // its floor and admission's balance gate refuses the run. The floor differs by
    // arm, deliberately: a reasoning-free answer bottoms out at one token, while a
    // reasoning turn bottoms out at its level's budget plus a minimum viable answer
    // — the level was the client's explicit ask, so an unaffordable one refuses
    // rather than being silently downgraded.
    const overFunds = TURNS.filter(
      (turn) => pricedNanoUsd(turn) > payerSpendableNanoUsd(turn.budget)
    );
    const notAtFloor = overFunds.filter(
      (turn) => !turn.definition.nodes.every((node) => atOrBelowFloor(node))
    );
    expect(notAtFloor.map((turn) => turn.label)).toEqual([]);
  });

  it('reaches both floors, so the clause above excuses nothing it has not seen', () => {
    const overFunds = TURNS.filter(
      (turn) => pricedNanoUsd(turn) > payerSpendableNanoUsd(turn.budget)
    );
    const capsSeen = new Set(
      overFunds.flatMap((turn) => answerCaps(turn.definition)).filter((cap) => cap !== undefined)
    );
    expect(capsSeen).toContain(1);
    expect(capsSeen).toContain(REASONING_FLOOR_CAP);
  });

  it('exercises both outcomes, so the property above is not vacuous', () => {
    const fitting = TURNS.filter(
      (turn) => pricedNanoUsd(turn) <= payerSpendableNanoUsd(turn.budget)
    );
    expect(fitting.length).toBeGreaterThan(0);
    expect(fitting.length).toBeLessThan(TURNS.length);
  });

  it('never stamps an answer cap above a sibling`s own physical bound', () => {
    // §Multi-Model 3: a tight-context sibling must not be asked for more than it
    // can physically emit. The searched headroom is the WIDEST sibling's room, so
    // what keeps every node inside its own bound is the per-node clamp each one
    // applies when the cap is stamped — not one tightest-sibling value.
    const violations = TURNS.flatMap((turn) =>
      turn.definition.nodes.flatMap((node) => {
        if (node.type !== 'modelCall') return [];
        const declared = node.params['maxOutputTokens'];
        if (typeof declared !== 'number') return [];
        const limits = BY_ID.get(node.model)?.limits ?? {};
        const bound = Math.min(
          limits['contextLength'] ?? 0,
          limits['maxOutputTokens'] ?? Number.MAX_SAFE_INTEGER
        );
        return declared > bound ? [`${turn.label} :: ${node.model} cap=${String(declared)}`] : [];
      })
    );
    expect(violations).toEqual([]);
  });
});
