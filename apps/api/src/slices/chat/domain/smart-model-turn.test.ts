import { describe, expect, it } from 'vitest';
import { ERROR_CODES, nanoUSD, PAID_CUSHION_NANO_USD } from '@hushbox/shared';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { classifierReserveLineItems } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import { reservationCeiling } from '@hushbox/shared/affordability/estimate/reducers';
import {
  createTurnCompileRegistries,
  promptInputTokensFor,
  withStorageStamp,
} from './turn-definition.js';
import { COST_CIRCUIT_MULTIPLIER } from '../../billing/index.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import {
  buildSmartModelTurn,
  candidateAnswerCeiling,
  compileSmartModelBuild,
  compileAutoEffortTurn,
  effortDimensionForCandidates,
  smartModelEffectiveBalanceNanoUsd,
} from './smart-model-turn.js';
import {
  buildSmartModelCandidates,
  createEstimateRun,
  estimateRunCeilingNanoUsd,
  snapshotResolver,
} from '../../models/index.js';
import type { AutoEffortTurnBuild } from './smart-model-turn.js';
import type { TurnBudget } from './turn-definition.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor, WorkflowDefinition } from '@hushbox/shared';

function descriptorFor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1000 },
    pricing: { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) },
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

const KNOWN_MODELS = new Set(['cheap-model', 'mid-model']);
const resolver: ModelPricingResolver = (id) =>
  KNOWN_MODELS.has(id) ? descriptorFor(id) : undefined;

/** A catalog descriptor with explicit per-token rates and context window. */
function pricedDescriptor(
  id: string,
  inputPerToken: bigint,
  outputPerToken: bigint,
  contextLength: number
): ModelDescriptor {
  return {
    ...descriptorFor(id),
    limits: { contextLength },
    pricing: { inputPerToken: nanoUSD(inputPerToken), outputPerToken: nanoUSD(outputPerToken) },
  };
}

/** A priced text descriptor with explicit per-token rates and context window. */
function priced(
  id: string,
  inputRate: bigint,
  outputRate: bigint,
  contextLength: number
): ModelDescriptor {
  return {
    ...descriptorFor(id),
    limits: { contextLength },
    pricing: { inputPerToken: nanoUSD(inputRate), outputPerToken: nanoUSD(outputRate) },
  };
}

const ONE_USD = 1_000_000_000n;

describe('smartModelEffectiveBalanceNanoUsd (tier-effective, cushion-inclusive gate)', () => {
  // The affordability gate must reason over the SAME tier-effective balance the
  // admission Redis gate and the client affordability preflight use
  // (`spendableFundsNanoUsd`): a paid wallet spends into the $0.50 cushion, so a
  // $0-purchased budgeted turn is still fundable. Passing the raw remainder here
  // (the prior bug) refused paid-within-cushion sends the client accepts.
  it('adds the paid negative-balance cushion for a budgeted purchased turn', () => {
    const budget = {
      promptCharacterCount: 100,
      funding: { remainingNanoUsd: 0n, kind: 'purchased' as const },
    };
    expect(smartModelEffectiveBalanceNanoUsd(budget, 999n)).toBe(PAID_CUSHION_NANO_USD);
  });

  it('applies no cushion for a free-tier budgeted turn (allowance rides a separate scope)', () => {
    const budget = {
      promptCharacterCount: 100,
      funding: { remainingNanoUsd: 5000n, kind: 'free' as const },
    };
    expect(smartModelEffectiveBalanceNanoUsd(budget, 999n)).toBe(5000n);
  });

  it('falls back to the sender purchased balance when no budget is supplied', () => {
    expect(smartModelEffectiveBalanceNanoUsd(undefined, 12_345n)).toBe(12_345n);
  });
});

describe('Smart Model admission reserve tracks the AFFORDABLE subset (legacy behavior)', () => {
  // A catalog whose text models ladder in price. The founder decision reserves
  // the worst case over ONLY the models the wallet can afford (legacy
  // `findAffordableCandidates`): a small wallet admits just the cheap models and
  // reserves little; a large wallet admits the whole pool and reserves the
  // priciest candidate's worst case — the same bounded MAX the old fixed menu
  // held, so a well-funded wallet's concurrency is not regressed.
  const CATALOG = [
    priced('a/cheap', 2n, 3n, 8000),
    priced('m/a', 2_500_000n, 2_500_000n, 1000),
    priced('m/b', 25_000_000n, 25_000_000n, 1000),
    priced('m/c', 250_000_000n, 250_000_000n, 1000),
  ];
  const resolver = snapshotResolver(CATALOG);

  /** The realised admission reserve for a solo paid send at a given balance,
   * built through the no-budget path (the uncapped defensive build the route
   * takes when no budget is supplied) and priced by the real estimator. */
  function reserveAtBalance(balanceNanoUsd: bigint): bigint {
    const picked = buildSmartModelCandidates({ descriptors: CATALOG, balanceNanoUsd });
    if (picked === null) throw new Error('expected a buildable smart-model turn');
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: picked.classifierModelId,
      candidates: picked.candidates,
      nodes,
      constraints,
    })._unsafeUnwrap();
    return createEstimateRun(resolver)(definition)._unsafeUnwrap();
  }

  it('refuses the send outright when the wallet cannot fund even the cheapest candidate', () => {
    expect(buildSmartModelCandidates({ descriptors: CATALOG, balanceNanoUsd: 0n })).toBeNull();
  });

  it('grows the reserve as the balance admits progressively pricier candidates', () => {
    const low = reserveAtBalance(10n * ONE_USD);
    const mid = reserveAtBalance(100n * ONE_USD);
    const high = reserveAtBalance(1000n * ONE_USD);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it('does not regress a well-funded wallet: the full-pool subset reserves the priciest candidate worst case, never the balance', () => {
    const HUGE_BALANCE = 10n ** 15n;
    const fullPoolReserve = reserveAtBalance(HUGE_BALANCE);
    // The priciest candidate over its own full context — the MAX the estimator
    // holds once every model is affordable (the old bounded, balance-invariant
    // reserve). A large wallet reserves exactly this plus the classifier, never
    // the balance itself, so concurrent-run capacity is preserved.
    const priciestFullContext = estimateRunCeilingNanoUsd(
      CATALOG[3]!.pricing,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
    )._unsafeUnwrap();
    expect(fullPoolReserve < HUGE_BALANCE).toBe(true);
    expect(fullPoolReserve).toBeGreaterThanOrEqual(priciestFullContext);
    expect(fullPoolReserve).toBeLessThan(priciestFullContext * 2n);
  });
});

describe('candidateAnswerCeiling', () => {
  // The Smart Model slot's single-cap bound is PHYSICAL: the tightest candidate's
  // own completion cap and remaining context. Whether the payer can afford it is
  // the canonical admission estimator's question, asked once by the reconcile —
  // so nothing here deducts the classifier reserve or reads a rate.
  const CATALOG = [
    pricedDescriptor('cheap', 2000n, 10_000n, 8000),
    pricedDescriptor('big', 4000n, 20_000n, 4000),
  ];

  it('clamps to the tightest candidate remaining context', () => {
    // free payer, chars=400 → estInput=200; min context 4000 − 200 = 3800.
    const result = candidateAnswerCeiling(CATALOG, [{ id: 'cheap' }, { id: 'big' }], {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 50_000_000n, kind: 'free' },
    });
    expect(result).toBe(3800);
  });

  it('carries no money term — a nearly empty wallet gets the same bound as a full one', () => {
    // The deleted per-rate sizing returned 2,315 here and 1,843 once a classifier
    // reserve was deducted; both were a second cost formula, and the estimator's
    // own fit is what bounds the money now.
    const ceilingAt = (remainingNanoUsd: bigint): number | undefined =>
      candidateAnswerCeiling(CATALOG, [{ id: 'cheap' }, { id: 'big' }], {
        promptCharacterCount: 400,
        funding: { remainingNanoUsd, kind: 'free' },
      });
    expect(ceilingAt(5_000_000n)).toBe(ceilingAt(50_000_000n));
  });

  it('bounds the ceiling by the tightest candidate provider completion cap', () => {
    // A declared `maxOutputTokens` is a strict tightening (BILLING
    // §Affordability 5): with a context that would otherwise reach the
    // tightest remaining window (3900), the 1200-token cap wins.
    const capped = [
      { ...pricedDescriptor('cheap', 2000n, 10_000n, 8000), limits: { contextLength: 8000 } },
      {
        ...pricedDescriptor('big', 4000n, 20_000n, 4000),
        limits: { contextLength: 4000, maxOutputTokens: 1200 },
      },
    ];
    const result = candidateAnswerCeiling(capped, [{ id: 'cheap' }, { id: 'big' }], {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 10_000_000_000_000n, kind: 'purchased' },
    });
    expect(result).toBe(1200);
  });

  it('returns undefined when a candidate is missing from the catalog snapshot', () => {
    const result = candidateAnswerCeiling(CATALOG, [{ id: 'cheap' }, { id: 'ghost' }], {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 50_000_000n, kind: 'free' },
    });
    expect(result).toBeUndefined();
  });

  it('stamps a concrete cap even for a wallet that covers the whole window (never undefined)', () => {
    // Admission prices each candidate's OWN full context and takes the MAX, so an
    // omitted cap would reserve the widest candidate's whole window at the
    // priciest rate: min context 4000 − 100 paid input tokens = 3900.
    const result = candidateAnswerCeiling(CATALOG, [{ id: 'cheap' }, { id: 'big' }], {
      promptCharacterCount: 400,
      funding: { remainingNanoUsd: 10_000_000_000_000n, kind: 'purchased' },
    });
    expect(result).toBe(3900);
  });
});

describe('Smart Model per-candidate caps keep the reserve within the balance (money keystone)', () => {
  // Each eligible candidate carries its OWN affordable cap: a cheap wide model
  // reaches (much of) its context, a pricey one is budget-bound — and the
  // admission reserve (MAX over the subset, priced EXACTLY as the estimator with
  // storage) never exceeds the wallet. The old single-cap throttle (everyone to
  // the tightest window) is gone.
  const WIDE_CONTEXT = 1_050_000;
  const TIGHT_CONTEXT = 8000;
  const CATALOG = [
    priced('cheap/classifier', 2n, 3n, TIGHT_CONTEXT),
    priced('wide/pro', 4n, 200_000n, WIDE_CONTEXT),
  ];
  const CANDIDATE_IDS = [{ id: 'cheap/classifier' }, { id: 'wide/pro' }];
  const HUNDRED_USD = 100n * ONE_USD;
  const budget = {
    promptCharacterCount: 400,
    funding: { remainingNanoUsd: HUNDRED_USD, kind: 'purchased' as const },
  };
  // paid tier → output storage 2 chars/token; input storage = prompt chars.
  const STORAGE = { outputCharsPerToken: 2, inputChars: budget.promptCharacterCount };

  /** The admission pick this catalog, prompt and wallet produce. */
  function paidCandidates() {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: HUNDRED_USD,
      promptInputTokens: promptInputTokensFor(budget),
      storage: STORAGE,
    });
    if (picked === null) throw new Error('expected a buildable smart-model turn');
    return picked;
  }

  /** Mirrors `buildSmartModelTurnDefinition`'s paid path: per-candidate caps
   * (from the storage-aware admission), no single node cap, storage-stamped. */
  function paidDefinition() {
    const picked = paidCandidates();
    const { nodes, constraints } = createTurnCompileRegistries(snapshotResolver(CATALOG));
    const built = buildSmartModelTurn({
      classifierModelId: picked.classifierModelId,
      candidates: picked.candidates,
      promptInputTokens: promptInputTokensFor(budget),
      nodes,
      constraints,
    })._unsafeUnwrap();
    return withStorageStamp(built, budget, CHAT_TURN_HOOKS);
  }

  it('returns a concrete cap bounded by the tightest candidate context (trial single-cap helper)', () => {
    const result = candidateAnswerCeiling(CATALOG, CANDIDATE_IDS, budget);
    expect(typeof result).toBe('number');
    expect(result).toBe(TIGHT_CONTEXT - 100);
  });

  it('stamps each eligible candidate its own affordable cap (≥ MINIMUM), no single node cap', () => {
    const node = paidDefinition().nodes[0];
    expect(node).toMatchObject({ type: 'smartModel' });
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    expect(node.params['maxOutputTokens']).toBeUndefined();
    for (const candidate of node.candidates) {
      expect(candidate.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    }
  });

  it('the storage-inclusive admission reserve stays within the balance (no under-reserve, no 402)', () => {
    const estimate = createEstimateRun(snapshotResolver(CATALOG))(paidDefinition())._unsafeUnwrap();
    expect(estimate).toBeGreaterThan(0n);
    expect(estimate).toBeLessThanOrEqual(HUNDRED_USD);
  });

  it('still refuses a genuinely unaffordable wallet (builder affordability gate)', () => {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: 1n,
      promptInputTokens: promptInputTokensFor(budget),
      storage: STORAGE,
    });
    expect(picked).toBeNull();
  });

  /**
   * The paid definition restricted to ONE of its candidates, keeping that
   * candidate's own stamped cap. A one-candidate slot opens no model dimension,
   * so its reserve is the answer leg alone — the direct-pick figure. That is what
   * makes the pool's reserve decomposable without re-deriving any of the
   * estimator's arithmetic here.
   */
  /** The larger of two nano-USD figures; `Math.max` cannot take bigints. */
  function larger(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
  }

  function soloReserve(modelId: string): bigint {
    const pooled = paidDefinition().nodes[0];
    if (pooled?.type !== 'smartModel') throw new Error('expected a smartModel node');
    const only = pooled.candidates.find((candidate) => candidate.id === modelId);
    if (only === undefined) throw new Error(`expected ${modelId} among the candidates`);
    const solo = { ...paidDefinition(), nodes: [{ ...pooled, candidates: [only] }] };
    return createEstimateRun(snapshotResolver(CATALOG))(solo)._unsafeUnwrap();
  }

  it('reserves the MAX over candidates plus one classifier reserve, never the Σ', () => {
    const pooled = createEstimateRun(snapshotResolver(CATALOG))(paidDefinition())._unsafeUnwrap();
    const cheap = soloReserve('cheap/classifier');
    const wide = soloReserve('wide/pro');
    const max = larger(cheap, wide);
    // Exactly one candidate answers, so the pool's own legs contribute their MAX.
    // The remainder above that MAX is one classifier reserve — a positive amount,
    // and strictly less than a second answer leg would be.
    expect(pooled).toBeGreaterThan(max);
    expect(pooled).toBeLessThan(cheap + wide);
    expect(pooled - max).toBeGreaterThan(0n);
  });

  it('sizes a pooled candidate exactly as a direct pick minus the classifier cost', () => {
    // BILLING §Smart Model 8. Both arms price the SAME catalog and the SAME
    // prompt, and the per-candidate cap is the one the pool stamped, so the whole
    // difference between "in the pool" and "picked directly" must be the one
    // classifier reserve the pool buys.
    //
    // The delta is asserted against the reserve the ADMISSION side computed
    // independently, never against itself: `pooled - max` compared to
    // `max + (pooled - max)` is an identity over any three numbers, and it would
    // hold just as well if the estimator priced the reserve TWICE. Pinning the
    // independent figure is what makes a double-priced reserve fail here.
    const pooled = createEstimateRun(snapshotResolver(CATALOG))(paidDefinition())._unsafeUnwrap();
    const cheap = soloReserve('cheap/classifier');
    const wide = soloReserve('wide/pro');
    const max = larger(cheap, wide);
    expect(pooled - max).toBe(paidCandidates().classifierWorstCaseNanoUsd);
    // The literal, so a silent move in either the reserve formula or the
    // estimator's fold shows up as a number rather than as a passing identity:
    // 4,943 reserve characters at 2 chars/token = 2,472 input tokens at 2n, plus
    // the 2,048-token output cap at 3n. Provider legs only — a storage term
    // creeping into the classifier reserve would break this equality, which is
    // the other property it pins.
    expect(pooled - max).toBe(11_088n);
    // And the classifier's leg is small next to an answer leg — it prices a
    // truncated context and a capped output, not a full turn.
    expect(pooled - max).toBeLessThan(max);
  });
});

describe('buildSmartModelTurn', () => {
  it('compiles a one-node smartModel turn under the paid chat hooks', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model', description: 'cheap' }, { id: 'mid-model' }],
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.deadlineClass).toBe('text');
    expect(definition.hooks).toEqual(CHAT_TURN_HOOKS);
    const node = definition.nodes[0];
    expect(definition.nodes).toHaveLength(1);
    expect(node).toMatchObject({
      id: CHAT_TURN_NODE_ID,
      type: 'smartModel',
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model', description: 'cheap' }, { id: 'mid-model' }],
    });
  });

  it('compiles the same turn under the trial hooks when a policy is supplied', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }],
      hooks: TRIAL_TURN_HOOKS,
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.hooks).toEqual(TRIAL_TURN_HOOKS);
    expect(definition.nodes[0]).toMatchObject({ type: 'smartModel' });
  });

  it('injects the answer output-token ceiling into the node params when defined', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      answerCapTokens: 512,
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.nodes[0]).toMatchObject({
      type: 'smartModel',
      params: { maxOutputTokens: 512 },
    });
  });

  it('leaves the node params empty when no ceiling is derived', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }],
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.nodes[0]).toMatchObject({ type: 'smartModel', params: {} });
  });

  it('stamps promptInputTokens on the node (admission-only, not in params)', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      answerCapTokens: 512,
      promptInputTokens: 250,
      nodes,
      constraints,
    })._unsafeUnwrap();
    const node = definition.nodes[0];
    expect(node?.type === 'smartModel' && node.promptInputTokens).toBe(250);
    // The answer call params carry only the real output cap.
    expect(node).toMatchObject({ type: 'smartModel', params: { maxOutputTokens: 512 } });
  });

  it('stamps the explicit hard-off reasoning wire into the node params when reasoningOff is set', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'mid-model' }],
      answerCapTokens: 512,
      reasoningOff: true,
      nodes,
      constraints,
    })._unsafeUnwrap();
    // The cap is untouched (plain-turn sizing; B = 0) — only the wire rides.
    expect(definition.nodes[0]).toMatchObject({
      type: 'smartModel',
      params: { maxOutputTokens: 512, reasoning: { enabled: false } },
    });
  });

  it('refuses a candidate list naming an unexposed model with a validation error', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const result = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'cheap-model' }, { id: 'ghost-model' }],
      nodes,
      constraints,
    });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('carries a declared classify dimension set onto the node', () => {
    const { nodes, constraints } = createTurnCompileRegistries(resolver);
    const definition = buildSmartModelTurn({
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'mid-model' }],
      classify: { model: false, effort: true },
      nodes,
      constraints,
    })._unsafeUnwrap();
    expect(definition.nodes[0]).toMatchObject({
      type: 'smartModel',
      classify: { model: false, effort: true },
    });
  });
});

/** A reasoning-capable priced text descriptor (effort-native, full ladder). */
function reasoningDescriptor(
  id: string,
  inputPerToken: bigint,
  outputPerToken: bigint,
  contextLength: number
): ModelDescriptor {
  return {
    ...descriptorFor(id),
    reasoning: { supportedEfforts: null },
    limits: { contextLength },
    pricing: { inputPerToken: nanoUSD(inputPerToken), outputPerToken: nanoUSD(outputPerToken) },
  };
}

describe('the trial Smart Model arm carries a money-bounded wire cap', () => {
  // The SECOND ungated door. A trial turn is quota-gated and its definition is
  // deliberately unstamped, so while the fit skipped unstamped definitions this arm
  // took the physical ceiling with no money term — and unlike the single-model arm it
  // had no wire-cap pin at all, so a single-arm fix would have left it open and green.
  //
  // Rates are realistic on purpose: at 2–3 nano per token the 1¢ ceiling buys the
  // whole context window, the money term never binds, and the pin would pass either
  // way. At 1,500 billable nano per output token it binds hard.
  const TRIAL_CEILING_NANO = 10_000_000n;
  const CONTEXT = 1_000_000;
  const candidate: ModelDescriptor = {
    ...descriptorFor('trial/candidate'),
    limits: { contextLength: CONTEXT },
    pricing: { inputPerToken: nanoUSD(1000n), outputPerToken: nanoUSD(1500n) },
  };
  const catalog = [candidate];
  const trialBudget: TurnBudget = {
    promptCharacterCount: 400,
    funding: { kind: 'free', remainingNanoUsd: TRIAL_CEILING_NANO },
  };
  // Trial candidates carry NO per-candidate cap — that is what routes this arm
  // through the single shared cap rather than the paid path's per-candidate ones.
  const picked = { classifierModelId: candidate.id, candidates: [{ id: candidate.id }] };

  async function trialDefinition(): Promise<WorkflowDefinition> {
    const compiled = await compileSmartModelBuild(catalog, picked, {
      hooks: TRIAL_TURN_HOOKS,
      budget: trialBudget,
    });
    const build = compiled._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable trial smart-model turn');
    return build.definition;
  }

  it('leaves the definition unstamped, so nothing it prices carries storage', async () => {
    const definition = await trialDefinition();
    expect(definition.storage).toBeUndefined();
  });

  it('prices the whole node within the per-message ceiling', async () => {
    const definition = await trialDefinition();
    const priced = createEstimateRun(snapshotResolver(catalog))(definition)._unsafeUnwrap();
    expect(priced).toBeLessThanOrEqual(TRIAL_CEILING_NANO);
  });

  it('shrinks the cap below the physical room, which is what a money term means here', async () => {
    const definition = await trialDefinition();
    const node = definition.nodes[0];
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    const cap = node.params['maxOutputTokens'];
    const room = candidateAnswerCeiling(catalog, picked.candidates, trialBudget);
    // 400 chars at the trial ratio (2 chars/token) = 200 input tokens, so the
    // physical room is 999,800 tokens — and the 1¢ ceiling buys far fewer.
    expect(room).toBe(999_800);
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeLessThan(room!);
  });

  /** The definition re-capped at `tokens`, priced by the canonical estimator. */
  async function pricedAt(tokens: number): Promise<bigint> {
    const definition = await trialDefinition();
    return createEstimateRun(snapshotResolver(catalog))({
      ...definition,
      nodes: definition.nodes.map((one) =>
        one.type === 'smartModel'
          ? { ...one, params: { ...one.params, maxOutputTokens: tokens } }
          : one
      ),
    })._unsafeUnwrap();
  }

  it('deflates the trial cost circuit with the cap, because the circuit is estimate x 5', async () => {
    // The circuit limit is `estimate × COST_CIRCUIT_MULTIPLIER`, so it inherited the
    // cap's inflation and has to be shown to have followed the cap back down rather
    // than assumed to have. Bounded now at 5× the per-message ceiling; at the physical
    // room — the cap this arm carried while the fit skipped unstamped turns — the same
    // circuit sat more than 100× higher.
    const definition = await trialDefinition();
    const priced = createEstimateRun(snapshotResolver(catalog))(definition)._unsafeUnwrap();
    expect(priced * COST_CIRCUIT_MULTIPLIER).toBeLessThanOrEqual(
      TRIAL_CEILING_NANO * COST_CIRCUIT_MULTIPLIER
    );
    const room = candidateAnswerCeiling(catalog, picked.candidates, trialBudget)!;
    const beforeLimit = (await pricedAt(room)) * COST_CIRCUIT_MULTIPLIER;
    expect(beforeLimit).toBeGreaterThan(TRIAL_CEILING_NANO * COST_CIRCUIT_MULTIPLIER * 100n);
  });

  it('is the LARGEST cap the ceiling admits, so the fit is maximal and not merely safe', async () => {
    // The oracle is maximality, derived from the estimator itself rather than copied
    // from whatever the code emitted: one token more must not fit.
    const definition = await trialDefinition();
    const node = definition.nodes[0];
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    const cap = node.params['maxOutputTokens'] as number;
    const estimate = createEstimateRun(snapshotResolver(catalog));
    const at = (tokens: number): bigint =>
      estimate({
        ...definition,
        nodes: definition.nodes.map((one) =>
          one.type === 'smartModel'
            ? { ...one, params: { ...one.params, maxOutputTokens: tokens } }
            : one
        ),
      })._unsafeUnwrap();
    expect(at(cap)).toBeLessThanOrEqual(TRIAL_CEILING_NANO);
    expect(at(cap + 1)).toBeGreaterThan(TRIAL_CEILING_NANO);
  });
});

describe('compileAutoEffortTurn (pinned model + auto effort)', () => {
  const pinned = reasoningDescriptor('pinned-model', 2n, 3n, 400_000);
  const cheapText = {
    ...descriptorFor('cheap-model'),
    pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(1n) },
  };
  const budget = {
    promptCharacterCount: 40,
    funding: { kind: 'purchased' as const, remainingNanoUsd: nanoUSD(10_000_000_000n) },
  };

  /** The built definition, or a thrown failure naming the unexpected outcome. */
  function builtDefinition(
    catalog: readonly ModelDescriptor[],
    model: string,
    turnBudget: TurnBudget
  ): WorkflowDefinition {
    const build = compileAutoEffortTurn(
      catalog,
      model,
      turnBudget,
      CHAT_TURN_HOOKS
    )._unsafeUnwrap();
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    return build.definition;
  }

  it('builds a single-candidate smartModel node with the effort dimension and a concrete B+H cap', () => {
    const definition = builtDefinition([pinned, cheapText], 'pinned-model', budget);
    const node = definition.nodes[0];
    expect(definition.nodes).toHaveLength(1);
    expect(node).toMatchObject({
      id: CHAT_TURN_NODE_ID,
      type: 'smartModel',
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'pinned-model' }],
      classify: { model: false, effort: true },
    });
    // The completion cap is concrete (B + H for the strongest affordable
    // option): the runtime carves the classified level's budget out of it,
    // never past it.
    const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeGreaterThan(REASONING_BUDGET_TOKENS_BY_EFFORT.max);
    // Persisting paid turn: storage-stamped, prompt tokens stamped.
    expect(definition.storage).toEqual({ inputChars: 40, tier: 'paid' });
    expect(node?.type === 'smartModel' && node.promptInputTokens).toBeGreaterThan(0);
    expect(definition.hooks).toEqual(CHAT_TURN_HOOKS);
  });

  it('walks the model’s own offered budgets, not a fixed level list', () => {
    // A context this tight clamps every rung from Low upward to the whole
    // window, so none of them leaves answer headroom; Lite's 2048 is the only
    // budget that still fits. Walking the model's real options finds it — a
    // walk over a fixed High/Medium/Low list sees only the clamped rungs and
    // abandons the turn to the fallback path.
    const tight = reasoningDescriptor('tight-context-model', 2n, 3n, 3400);
    const definition = builtDefinition([tight, cheapText], 'tight-context-model', budget);
    const node = definition.nodes[0];
    const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
    expect(cap as number).toBeGreaterThanOrEqual(REASONING_BUDGET_TOKENS_BY_EFFORT.lite);
  });

  it('admission prices the built definition within the payer budget (reconciled cap)', () => {
    const definition = builtDefinition([pinned, cheapText], 'pinned-model', budget);
    const estimate = createEstimateRun(snapshotResolver([pinned, cheapText]));
    const priced = estimate(definition)._unsafeUnwrap();
    expect(priced <= budget.funding.remainingNanoUsd + 500_000_000n).toBe(true);
  });

  it('carries the pinned model description onto its candidate entry', () => {
    const described = { ...pinned, id: 'described-model', description: 'thinks hard' };
    const definition = builtDefinition([described, cheapText], 'described-model', budget);
    const node = definition.nodes[0];
    expect(node?.type === 'smartModel' && node.candidates[0]?.description).toBe('thinks hard');
  });

  it('falls back when the pinned model has no context length (no pricing basis for the cap)', () => {
    const capless = { ...pinned, id: 'capless-model', limits: {} };
    expect(
      compileAutoEffortTurn(
        [capless, cheapText],
        'capless-model',
        budget,
        CHAT_TURN_HOOKS
      )._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back for a single-level mandatory model (empty offered ladder — no choice exists)', () => {
    // Auto on a single-level mandatory model offers nothing to choose, so the
    // classifier stage honestly declines and the regular path runs it at the
    // provider default within H.
    const mandatory = {
      ...pinned,
      id: 'mandatory-model',
      reasoning: { supportedEfforts: ['only'], mandatory: true },
    };
    expect(
      compileAutoEffortTurn(
        [mandatory, cheapText],
        'mandatory-model',
        budget,
        CHAT_TURN_HOOKS
      )._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back on a Min-only model (one real choice — no classifier, no reserve)', () => {
    // Exactly one option (Min) ⇒ the deterministic pick belongs to the regular
    // path; building a classifier here would charge for a settled question.
    const minOnly = { ...pinned, id: 'min-only', reasoning: { supportedEfforts: ['none'] } };
    expect(
      compileAutoEffortTurn(
        [minOnly, cheapText],
        'min-only',
        budget,
        CHAT_TURN_HOOKS
      )._unsafeUnwrap()
    ).toEqual({
      kind: 'fallback',
    });
  });

  it('falls back for a non-reasoning pinned model (regular path owns it)', () => {
    const plain = { ...descriptorFor('plain-model') };
    expect(
      compileAutoEffortTurn(
        [plain, cheapText],
        'plain-model',
        budget,
        CHAT_TURN_HOOKS
      )._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back for a model unknown to the catalog', () => {
    expect(
      compileAutoEffortTurn([cheapText], 'ghost-model', budget, CHAT_TURN_HOOKS)._unsafeUnwrap()
    ).toEqual({
      kind: 'fallback',
    });
  });

  it('refuses with the typed classifier code when no classifier can be priced', () => {
    // BILLING §Effort 5/8d: no priceable engine ⇒ a typed refusal, never a
    // silent static pick; explicit levels stay usable.
    const rateless = { ...pinned, id: 'rateless-model', pricing: {} };
    const error = compileAutoEffortTurn(
      [rateless],
      'rateless-model',
      budget,
      CHAT_TURN_HOOKS
    )._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });

  it('reports a budget that cannot fund the minimum classified turn as unaffordable', () => {
    // Free funding carries no cushion, so a 1-nano budget affords no level. The
    // outcome is distinct from `fallback`: nothing about the turn is settled, the
    // money simply is not there — and the trial arm has no balance gate behind it
    // to catch that, so it must be able to tell the two apart.
    const broke = {
      promptCharacterCount: 40,
      funding: { kind: 'free' as const, remainingNanoUsd: nanoUSD(1n) },
    };
    expect(
      compileAutoEffortTurn(
        [pinned, cheapText],
        'pinned-model',
        broke,
        CHAT_TURN_HOOKS
      )._unsafeUnwrap()
    ).toEqual({ kind: 'unaffordable' });
  });
});

describe('compileAutoEffortTurn on the trial policy', () => {
  // A trial turn runs the SAME pinned+auto compiler as a paid one — §Reasoning
  // Effort 5 forbids a static fallback on any tier — under the no-persist,
  // no-charge policy and against the fixed per-message ceiling that stands in
  // for a wallet (§Trial Usage).
  const TRIAL_CEILING_NANO = 10_000_000n;
  const budget: TurnBudget = {
    promptCharacterCount: 40,
    funding: { kind: 'free', remainingNanoUsd: nanoUSD(TRIAL_CEILING_NANO) },
  };
  /** The 1¢ ceiling covers a minimum answer at these rates but not the reserve too. */
  const dearOutput = reasoningDescriptor('trial/dear-output', 1000n, 3000n, 1_000_000);
  /** Cheap enough that the classified turn fits, so the priced shape is inspectable. */
  const cheap = reasoningDescriptor('trial/cheap', 2n, 3n, 1_000_000);

  function compileTrial(catalog: readonly ModelDescriptor[], model: string): AutoEffortTurnBuild {
    return compileAutoEffortTurn(catalog, model, budget, TRIAL_TURN_HOOKS)._unsafeUnwrap();
  }

  it('reports a model whose classifier reserve overruns the ceiling as unaffordable', () => {
    // The model is the only priceable row, so it is also the classifier engine and
    // the reserve is priced at its own rates. The companion below shows the answer
    // alone fits the same ceiling, so it is the reserve that decides this.
    expect(compileTrial([dearOutput], 'trial/dear-output')).toEqual({ kind: 'unaffordable' });
  });

  it('admits the same rates once the classifier is not bought', () => {
    // The reserve-free half of the pair: a smartModel slot with no active
    // dimension prices no reserve, and the minimum answer at those rates is
    // inside the ceiling — so the refusal above is the reserve, not the answer.
    const registries = createTurnCompileRegistries(snapshotResolver([dearOutput]));
    const reserveFree = buildSmartModelTurn({
      classifierModelId: dearOutput.id,
      candidates: [{ id: dearOutput.id }],
      classify: { model: false, effort: false },
      answerCapTokens: MINIMUM_OUTPUT_TOKENS,
      promptInputTokens: promptInputTokensFor(budget),
      hooks: TRIAL_TURN_HOOKS,
      nodes: registries.nodes,
      constraints: registries.constraints,
    })._unsafeUnwrap();
    const priced = createEstimateRun(snapshotResolver([dearOutput]))(reserveFree)._unsafeUnwrap();
    expect(priced).toBeLessThanOrEqual(TRIAL_CEILING_NANO);
  });

  it('carries the trial policy hooks onto the classified definition', () => {
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    expect(build.definition.hooks).toEqual(TRIAL_TURN_HOOKS);
  });

  it('leaves the classified trial definition unstamped, so no storage is held', () => {
    // A trial turn persists nothing, so stamping it would reserve storage that
    // settlement can never bill — the whole reason the hooks are a parameter
    // rather than the paid policy this compiler used to hardcode.
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    expect(build.definition.storage).toBeUndefined();
  });

  it('opens the effort dimension on the single-candidate slot', () => {
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    expect(build.definition.nodes[0]).toMatchObject({
      type: 'smartModel',
      candidates: [{ id: 'trial/cheap' }],
      classify: { model: false, effort: true },
    });
  });

  it('prices the classifier reserve into the admission estimate', () => {
    // Deactivating the one declared dimension is the only difference between the
    // two prices, so the delta IS the reserve — measured against the shared
    // reserve line items rather than against a number copied out of the estimator.
    const build = compileTrial([cheap], 'trial/cheap');
    if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
    const estimate = createEstimateRun(snapshotResolver([cheap]));
    const withoutClassifier = {
      ...build.definition,
      nodes: build.definition.nodes.map((node) =>
        node.type === 'smartModel' ? { ...node, classify: { model: false, effort: false } } : node
      ),
    };
    const items = classifierReserveLineItems(cheap, []);
    if (items === undefined) throw new Error('expected priceable classifier line items');
    const reserve = reservationCeiling(
      { items: items.filter((item) => item.kind === 'provider') },
      { outputTokenCeiling: 0n, fanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
    );
    expect(reserve).toBeGreaterThan(0n);
    expect(
      estimate(build.definition)._unsafeUnwrap() - estimate(withoutClassifier)._unsafeUnwrap()
    ).toBe(reserve);
  });

  // The compiler's three outcomes, ordered along ONE axis: the ceiling, the
  // prompt, the ladder and the classifier engine are held fixed and only the
  // answer model's output rate moves. That brackets the ladder outcome — a
  // fitted cap that clears the minimum answer but buys no offered rung — between
  // its two neighbours, so the outcome cannot be attributed to any of the
  // compiler's earlier exits (they are rate-independent, and the built neighbour
  // shows none of them fires on this fixture).
  describe('the fitted cap measured against the model’s own rung ladder', () => {
    /** The cheapest priceable row, so the classifier engine is the same one in all three. */
    const engine = reasoningDescriptor('trial/engine', 1n, 1n, 1_000_000);
    /** One answer model priced three ways; every other input is held fixed. */
    const answerAt = (outputPerToken: bigint): ModelDescriptor =>
      reasoningDescriptor('trial/answer', 2n, outputPerToken, 1_000_000);

    it('falls back when the fitted cap buys no offered rung', () => {
      // At this rate the 1¢ ceiling fits an answer cap that is past the
      // minimum-answer floor but short of the cheapest rung's budget plus that
      // same floor, so every rung the classifier could pick is out of reach.
      // Whether abandoning the classifier here is a banned static fallback or a
      // permitted single-choice pick is being ruled on elsewhere; this pins the
      // outcome so it cannot change unobserved while that is decided.
      //
      // This rate is chosen so the fitted cap lands inside that bracket. If the
      // ladder is retuned, re-place the rate to restore the bracket rather than
      // delete the case: this is the only measurement of that arm, so dropping
      // it un-pins the arm silently. Only this case is calibrated to the ladder
      // — the built neighbour below asserts against the shared budget
      // constants, so it follows a retune on its own. Lower a rung and the pair
      // reddens on one side only, and it is this one: this side is the fixture,
      // that side is the contract.
      expect(compileTrial([answerAt(4000n), engine], 'trial/answer')).toEqual({ kind: 'fallback' });
    });

    it('builds the classified turn once the fitted cap covers the cheapest rung', () => {
      const build = compileTrial([answerAt(3000n), engine], 'trial/answer');
      if (build.kind !== 'built') throw new Error(`expected a built turn, got '${build.kind}'`);
      const node = build.definition.nodes[0];
      const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
      expect(cap as number).toBeGreaterThanOrEqual(
        REASONING_BUDGET_TOKENS_BY_EFFORT.lite + MINIMUM_OUTPUT_TOKENS
      );
    });

    it('reports unaffordable when the cap cannot reach the minimum answer', () => {
      expect(compileTrial([answerAt(10_000n), engine], 'trial/answer')).toEqual({
        kind: 'unaffordable',
      });
    });
  });
});

describe('effortDimensionForCandidates (Smart Model + auto gate)', () => {
  it('returns the both-dimensions classify set when any candidate is reasoning-capable', () => {
    const pinned = reasoningDescriptor('reasoner', 2n, 3n, 100_000);
    const plain = descriptorFor('plain');
    expect(
      effortDimensionForCandidates([plain, pinned], [{ id: 'plain' }, { id: 'reasoner' }])
    ).toEqual({ model: true, effort: true });
  });

  it('returns undefined when NO candidate is reasoning-capable (no call, no charge, no reserve)', () => {
    const plain = descriptorFor('plain');
    expect(effortDimensionForCandidates([plain], [{ id: 'plain' }])).toBeUndefined();
  });
});

describe('free-tier Smart admission: storage-folded per-candidate caps fit the daily allowance', () => {
  // A free-tier Smart Model turn persists, so each candidate's cap must cover the
  // answer/prompt STORAGE the estimator holds (free tier: 4 chars/token — dominant
  // over a cheap model's token rate). Folding storage into the per-candidate cap
  // is what keeps the reserve within the 50M daily allowance; without it the
  // full-context cap's storage alone blows the allowance and free users 402.
  const FREE_MODEL = 'free/smart';
  const CATALOG = [priced(FREE_MODEL, 2n, 3n, 128_000)];
  const DAILY_ALLOWANCE = 50_000_000n;
  const budget = {
    promptCharacterCount: 400,
    funding: { remainingNanoUsd: DAILY_ALLOWANCE, kind: 'free' as const },
  };
  const STORAGE = { outputCharsPerToken: 4, inputChars: budget.promptCharacterCount };

  function definitionWith(storage?: { outputCharsPerToken: number; inputChars: number }) {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: budget.funding.remainingNanoUsd,
      promptInputTokens: promptInputTokensFor(budget),
      ...(storage === undefined ? {} : { storage }),
    });
    if (picked === null) throw new Error('expected a buildable free-tier smart-model turn');
    const { nodes, constraints } = createTurnCompileRegistries(snapshotResolver(CATALOG));
    const built = buildSmartModelTurn({
      classifierModelId: picked.classifierModelId,
      candidates: picked.candidates,
      promptInputTokens: promptInputTokensFor(budget),
      nodes,
      constraints,
    })._unsafeUnwrap();
    return withStorageStamp(built, budget, CHAT_TURN_HOOKS);
  }

  it('the storage-folded per-candidate cap keeps the reserve within the daily allowance', () => {
    const ceiling = createEstimateRun(snapshotResolver(CATALOG))(
      definitionWith(STORAGE)
    )._unsafeUnwrap();
    expect(ceiling).toBeLessThanOrEqual(DAILY_ALLOWANCE);
  });

  it('ignoring storage in the cap would over-reserve past the allowance (the fold matters)', () => {
    const ceiling = createEstimateRun(snapshotResolver(CATALOG))(definitionWith())._unsafeUnwrap();
    expect(ceiling).toBeGreaterThan(DAILY_ALLOWANCE);
  });
});
