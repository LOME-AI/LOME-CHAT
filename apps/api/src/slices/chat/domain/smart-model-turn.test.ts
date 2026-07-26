import { describe, expect, it } from 'vitest';
import { ERROR_CODES, nanoUSD, PAID_CUSHION_NANO_USD } from '@hushbox/shared';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import {
  createTurnCompileRegistries,
  promptInputTokensFor,
  withStorageStamp,
} from './turn-definition.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import {
  answerMaxOutputTokens,
  buildSmartModelTurn,
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

describe('answerMaxOutputTokens', () => {
  // Legacy reserved the Smart Model slot at the MOST EXPENSIVE eligible rates
  // (computeMaxEligibleFees) so the budget absorbs whichever candidate the
  // classifier picks; the context bound is the tightest candidate window.
  const CATALOG = [
    pricedDescriptor('cheap', 2000n, 10_000n, 8000),
    pricedDescriptor('big', 4000n, 20_000n, 4000),
  ];

  it('derives the ceiling from the max candidate rates and min context length', () => {
    // free payer, chars=400 → estInput=200; max billable rates = 4000 / 20_000;
    // fixed = 200×4000 + 400×300 = 920_000; variable = 20_000 + 4×300 = 21_200;
    // maxOutputTokens = floor((50_000_000 − 920_000) / 21_200) = 2_315;
    // min context 4000 − 200 = 3_800 remaining > 2_315 → capped.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      0n
    );
    expect(result).toBe(2315);
  });

  it('shrinks the ceiling by the classifier reserve deducted from the budget', () => {
    // Same inputs as above, but the classifier's worst-case reserve is set aside
    // first: effective = 50_000_000 − 10_000_000 = 40_000_000;
    // maxOutputTokens = floor((40_000_000 − 920_000) / 21_200) = 1_843;
    // min context 4000 − 200 = 3_800 remaining > 1_843 → capped.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      10_000_000n
    );
    expect(result).toBe(1843);
  });

  it('clamps to the tightest remaining context even when the reserve leaves little (admission is the gate)', () => {
    // reserve 45_000_000 leaves 5_000_000 < the minimum-output cost, so
    // `turnMaxOutputTokens` derives no budget-based cap. The cap must still be
    // stamped (never undefined in the affordable-candidate case) so admission
    // prices a BOUNDED reserve — the tightest candidate's remaining context
    // (free tier: min context 4000 − 200 input tokens = 3800) — instead of
    // reserving the widest candidate's full window. A genuinely unaffordable
    // wallet is then refused at admission (the only balance gate), not by an
    // inflated pre-admission full-context hold.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      45_000_000n
    );
    expect(result).toBe(3800);
  });

  it('bounds the ceiling by the tightest candidate provider completion cap', () => {
    // A declared `maxOutputTokens` is a strict tightening (BILLING
    // §Affordability 5): with a budget that would otherwise reach the
    // tightest remaining context (3900), the 1200-token cap wins.
    const capped = [
      { ...pricedDescriptor('cheap', 2000n, 10_000n, 8000), limits: { contextLength: 8000 } },
      {
        ...pricedDescriptor('big', 4000n, 20_000n, 4000),
        limits: { contextLength: 4000, maxOutputTokens: 1200 },
      },
    ];
    const result = answerMaxOutputTokens(
      capped,
      [{ id: 'cheap' }, { id: 'big' }],
      {
        promptCharacterCount: 400,
        funding: { remainingNanoUsd: 10_000_000_000_000n, kind: 'purchased' },
      },
      0n
    );
    expect(result).toBe(1200);
  });

  it('returns undefined when a candidate is missing from the catalog snapshot', () => {
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'ghost' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      0n
    );
    expect(result).toBeUndefined();
  });

  it('clamps to the tightest remaining context when the budget covers it (never undefined)', () => {
    // A huge budget covers the tightest candidate's full context, so
    // `computeSafeMaxTokens` would drop the cap. For a MULTI-candidate Smart
    // Model that is unsafe (admission prices each candidate's OWN full context
    // and takes the MAX), so the ceiling is clamped to the tightest candidate's
    // remaining window: min context 4000 − 100 estimated input tokens = 3900.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      {
        promptCharacterCount: 400,
        funding: { remainingNanoUsd: 10_000_000_000_000n, kind: 'purchased' },
      },
      0n
    );
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

  /** Mirrors `buildSmartModelTurnDefinition`'s paid path: per-candidate caps
   * (from the storage-aware admission), no single node cap, storage-stamped. */
  function paidDefinition() {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: HUNDRED_USD,
      promptInputTokens: promptInputTokensFor(budget),
      storage: STORAGE,
    });
    if (picked === null) throw new Error('expected a buildable smart-model turn');
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
    const result = answerMaxOutputTokens(CATALOG, CANDIDATE_IDS, budget, 0n);
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
      answerMaxOutputTokens: 512,
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
      answerMaxOutputTokens: 512,
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
      answerMaxOutputTokens: 512,
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
    const build = compileAutoEffortTurn(catalog, model, turnBudget)._unsafeUnwrap();
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
      compileAutoEffortTurn([capless, cheapText], 'capless-model', budget)._unsafeUnwrap()
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
      compileAutoEffortTurn([mandatory, cheapText], 'mandatory-model', budget)._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back on a Min-only model (one real choice — no classifier, no reserve)', () => {
    // Exactly one option (Min) ⇒ the deterministic pick belongs to the regular
    // path; building a classifier here would charge for a settled question.
    const minOnly = { ...pinned, id: 'min-only', reasoning: { supportedEfforts: ['none'] } };
    expect(compileAutoEffortTurn([minOnly, cheapText], 'min-only', budget)._unsafeUnwrap()).toEqual(
      {
        kind: 'fallback',
      }
    );
  });

  it('falls back for a non-reasoning pinned model (regular path owns it)', () => {
    const plain = { ...descriptorFor('plain-model') };
    expect(
      compileAutoEffortTurn([plain, cheapText], 'plain-model', budget)._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
  });

  it('falls back for a model unknown to the catalog', () => {
    expect(compileAutoEffortTurn([cheapText], 'ghost-model', budget)._unsafeUnwrap()).toEqual({
      kind: 'fallback',
    });
  });

  it('refuses with the typed classifier code when no classifier can be priced', () => {
    // BILLING §Effort 5/8d: no priceable engine ⇒ a typed refusal, never a
    // silent static pick; explicit levels stay usable.
    const rateless = { ...pinned, id: 'rateless-model', pricing: {} };
    const error = compileAutoEffortTurn([rateless], 'rateless-model', budget)._unsafeUnwrapErr();
    expect(error.code).toBe('unavailable');
    expect(error.wireCode).toBe(ERROR_CODES.CLASSIFIER_UNAVAILABLE);
  });

  it('falls back when no reasoning level leaves answer headroom under the budget', () => {
    // Free funding carries no cushion, so a 1-nano budget affords no level.
    const broke = {
      promptCharacterCount: 40,
      funding: { kind: 'free' as const, remainingNanoUsd: nanoUSD(1n) },
    };
    expect(
      compileAutoEffortTurn([pinned, cheapText], 'pinned-model', broke)._unsafeUnwrap()
    ).toEqual({ kind: 'fallback' });
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
