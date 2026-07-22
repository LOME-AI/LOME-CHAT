import { describe, expect, it } from 'vitest';
import { nanoUSD, REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared';
import {
  createTurnCompileRegistries,
  fitAnswerCapToCeiling,
  promptInputTokensFor,
  withStorageStamp,
} from './turn-definition.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import {
  answerMaxOutputTokens,
  buildSmartModelTurn,
  compileAutoEffortTurn,
  effortDimensionForCandidates,
} from './smart-model-turn.js';
import {
  buildSmartModelCandidates,
  createEstimateRun,
  estimateRunCeilingNanoUsd,
  snapshotResolver,
} from '../../models/index.js';
import type { ModelPricingResolver } from '../../models/index.js';
import type { ModelDescriptor } from '@hushbox/shared';

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

describe('Smart Model admission reserve is BALANCE-INVARIANT (money keystone)', () => {
  // A catalog whose text models ladder in price: as the wallet grows, the OLD
  // balance-scaled affordability filter admitted progressively pricier models,
  // so the estimator's MAX-over-candidates climbed with the balance (a $100
  // wallet reserved ≈$100, supporting only ~1 in-flight run). Legacy reserved a
  // context-bounded amount for ONE model, invariant to balance. The fixed menu
  // restores that: the priced candidate set no longer tracks the wallet.
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

  it('reserves the same amount at $100 as at $10 (invariant to balance)', () => {
    expect(reserveAtBalance(100n * ONE_USD)).toBe(reserveAtBalance(10n * ONE_USD));
  });

  it('reserves the same amount at $1000 as at $10 (invariant to balance)', () => {
    expect(reserveAtBalance(1000n * ONE_USD)).toBe(reserveAtBalance(10n * ONE_USD));
  });

  it('bounds the reserve by a single model context-window ceiling, not the balance', () => {
    // The whole point: a $1000 wallet must NOT reserve ≈$1000. The reserve stays
    // under the priciest candidate's full-context ceiling (m/c over its window),
    // which is far below the balance.
    const priciestFullContext = estimateRunCeilingNanoUsd(
      CATALOG[3]!.pricing,
      { kind: 'tokens', inputTokens: 1000, outputTokens: 1000 },
      { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
    )._unsafeUnwrap();
    const reserve = reserveAtBalance(1000n * ONE_USD);
    // Reserve covers the classifier plus the priciest answer, so it exceeds the
    // bare answer ceiling but stays a small multiple of it — never the balance.
    expect(reserve < 1000n * ONE_USD).toBe(true);
    expect(reserve).toBeLessThan(priciestFullContext * 2n);
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
    // free payer, chars=400 → estInput=200; max rates marked = 4600 / 23_000;
    // fixed = 200×4600 + 400×300 = 1_040_000; variable = 23_000 + 4×300 = 24_200;
    // maxOutputTokens = floor((50_000_000 − 1_040_000) / 24_200) = 2_023;
    // min context 4000 − 200 = 3_800 remaining > 2_023 → capped.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      0n
    );
    expect(result).toBe(2023);
  });

  it('shrinks the ceiling by the classifier reserve deducted from the budget', () => {
    // Same inputs as above, but the classifier's worst-case reserve is set aside
    // first: effective = 50_000_000 − 10_000_000 = 40_000_000;
    // maxOutputTokens = floor((40_000_000 − 1_040_000) / 24_200) = 1_609;
    // min context 4000 − 200 = 3_800 remaining > 1_609 → capped.
    const result = answerMaxOutputTokens(
      CATALOG,
      [{ id: 'cheap' }, { id: 'big' }],
      { promptCharacterCount: 400, funding: { remainingNanoUsd: 50_000_000n, kind: 'free' } },
      10_000_000n
    );
    expect(result).toBe(1609);
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

describe('Smart Model answer cap is ALWAYS stamped (chat-402 fix, money keystone)', () => {
  // Empirically-diagnosed 402 flood: a funded $100 persona's admission estimate
  // was $217 because `node.params.maxOutputTokens` was omitted whenever the
  // budget covered the tightest candidate's context — so the multi-candidate
  // estimator priced the WIDEST candidate's full window (uncapped) at the
  // priciest rate. The fix stamps a concrete cap bounded by the tightest
  // candidate, so BOTH the estimate and the real provider request stay bounded.
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
  // paid tier → 4 chars/token → 400 chars = 100 estimated input tokens.
  const CLAMP = TIGHT_CONTEXT - 100;

  /** Mirrors `compileSmartModelBuild`'s paid path: fixed candidate menu, the
   * derived answer ceiling, and the stamped prompt input-token count. */
  function paidDefinition() {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: HUNDRED_USD,
      promptInputTokens: promptInputTokensFor(budget),
    });
    if (picked === null) throw new Error('expected a buildable smart-model turn');
    const ceiling = answerMaxOutputTokens(
      CATALOG,
      picked.candidates,
      budget,
      picked.classifierWorstCaseNanoUsd
    );
    const { nodes, constraints } = createTurnCompileRegistries(snapshotResolver(CATALOG));
    return buildSmartModelTurn({
      classifierModelId: picked.classifierModelId,
      candidates: picked.candidates,
      ...(ceiling === undefined ? {} : { answerMaxOutputTokens: ceiling }),
      promptInputTokens: promptInputTokensFor(budget),
      nodes,
      constraints,
    })._unsafeUnwrap();
  }

  it('returns a concrete cap bounded by the tightest candidate context', () => {
    const result = answerMaxOutputTokens(CATALOG, CANDIDATE_IDS, budget, 0n);
    expect(typeof result).toBe('number');
    expect(result).toBe(CLAMP);
    expect(result!).toBeLessThan(TIGHT_CONTEXT);
    expect(result!).toBeGreaterThanOrEqual(1);
  });

  it('stamps the answer cap into the built definition node params', () => {
    const node = paidDefinition().nodes[0];
    expect(node).toMatchObject({ type: 'smartModel', params: { maxOutputTokens: CLAMP } });
  });

  it('reserves ~$1, well under a $100 balance (not the ~$217 uncapped estimate)', () => {
    const estimate = createEstimateRun(snapshotResolver(CATALOG))(paidDefinition())._unsafeUnwrap();
    // The bug produced ~$217 (2.17× balance); the cap brings it to a ~$1 order.
    expect(estimate).toBeLessThan(HUNDRED_USD);
    expect(estimate).toBeLessThan(5n * ONE_USD);
  });

  it('reserves far less than the widest candidate full-context price', () => {
    // The widest candidate's uncapped full-context price (the pre-fix reserve)
    // exceeds the whole $100 wallet — the root cause of the 402 flood.
    const widestFullContext = estimateRunCeilingNanoUsd(
      CATALOG[1]!.pricing,
      { kind: 'tokens', inputTokens: 100, outputTokens: WIDE_CONTEXT },
      { maxFanOutWidth: 1, maxSteps: 1, maxIterations: 1 }
    )._unsafeUnwrap();
    expect(widestFullContext).toBeGreaterThan(HUNDRED_USD);
    const estimate = createEstimateRun(snapshotResolver(CATALOG))(paidDefinition())._unsafeUnwrap();
    expect(estimate * 20n).toBeLessThan(widestFullContext);
  });

  it('still refuses a genuinely unaffordable wallet (builder affordability gate)', () => {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: 1n,
      promptInputTokens: promptInputTokensFor(budget),
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

  it('builds a single-candidate smartModel node with the effort dimension and a concrete B+H cap', () => {
    const build = compileAutoEffortTurn([pinned, cheapText], 'pinned-model', budget);
    expect(build.kind).toBe('built');
    if (build.kind !== 'built') throw new Error('unreachable');
    const node = build.definition.nodes[0];
    expect(build.definition.nodes).toHaveLength(1);
    expect(node).toMatchObject({
      id: CHAT_TURN_NODE_ID,
      type: 'smartModel',
      classifierModelId: 'cheap-model',
      candidates: [{ id: 'pinned-model' }],
      classify: { model: false, effort: true },
    });
    // The completion cap is concrete (B + H for the highest affordable level):
    // the runtime carves the classified level's budget out of it, never past it.
    const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
    expect(typeof cap).toBe('number');
    expect(cap as number).toBeGreaterThan(REASONING_BUDGET_TOKENS_BY_EFFORT.high);
    // Persisting paid turn: storage-stamped, prompt tokens stamped.
    expect(build.definition.storage).toEqual({ inputChars: 40, tier: 'paid' });
    expect(node?.type === 'smartModel' && node.promptInputTokens).toBeGreaterThan(0);
    expect(build.definition.hooks).toEqual(CHAT_TURN_HOOKS);
  });

  it('admission prices the built definition within the payer budget (reconciled cap)', () => {
    const build = compileAutoEffortTurn([pinned, cheapText], 'pinned-model', budget);
    if (build.kind !== 'built') throw new Error('expected built');
    const estimate = createEstimateRun(snapshotResolver([pinned, cheapText]));
    const priced = estimate(build.definition)._unsafeUnwrap();
    expect(priced <= budget.funding.remainingNanoUsd + 500_000_000n).toBe(true);
  });

  it('carries the pinned model description onto its candidate entry', () => {
    const described = { ...pinned, id: 'described-model', description: 'thinks hard' };
    const build = compileAutoEffortTurn([described, cheapText], 'described-model', budget);
    if (build.kind !== 'built') throw new Error('expected built');
    const node = build.definition.nodes[0];
    expect(node?.type === 'smartModel' && node.candidates[0]?.description).toBe('thinks hard');
  });

  it('falls back when the pinned model has no context length (no pricing basis for the cap)', () => {
    const capless = { ...pinned, id: 'capless-model', limits: {} };
    expect(compileAutoEffortTurn([capless, cheapText], 'capless-model', budget)).toEqual({
      kind: 'fallback',
    });
  });

  it('falls back for a single-level mandatory model (empty offered ladder — no choice exists)', () => {
    // Product note (T16 audit corner): auto on a single-level mandatory model
    // offers nothing to choose, so the classifier stage honestly declines and
    // the regular path runs it at the provider default within H.
    const mandatory = {
      ...pinned,
      id: 'mandatory-model',
      reasoning: { supportedEfforts: ['only'], mandatory: true },
    };
    expect(compileAutoEffortTurn([mandatory, cheapText], 'mandatory-model', budget)).toEqual({
      kind: 'fallback',
    });
  });

  it('falls back for a non-reasoning pinned model (regular path owns it)', () => {
    const plain = { ...descriptorFor('plain-model') };
    expect(compileAutoEffortTurn([plain, cheapText], 'plain-model', budget)).toEqual({
      kind: 'fallback',
    });
  });

  it('falls back for a model unknown to the catalog', () => {
    expect(compileAutoEffortTurn([cheapText], 'ghost-model', budget)).toEqual({ kind: 'fallback' });
  });

  it('falls back when no classifier can be priced (rateless catalog)', () => {
    const rateless = { ...pinned, id: 'rateless-model', pricing: {} };
    expect(compileAutoEffortTurn([rateless], 'rateless-model', budget)).toEqual({
      kind: 'fallback',
    });
  });

  it('falls back when no reasoning level leaves answer headroom under the budget', () => {
    // Free funding carries no cushion, so a 1-nano budget affords no level.
    const broke = {
      promptCharacterCount: 40,
      funding: { kind: 'free' as const, remainingNanoUsd: nanoUSD(1n) },
    };
    expect(compileAutoEffortTurn([pinned, cheapText], 'pinned-model', broke)).toEqual({
      kind: 'fallback',
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

describe('fitAnswerCapToCeiling reconciles the free-tier Smart admission ceiling', () => {
  // Regression: a free-tier default (Smart Model) persisting turn sized its answer
  // against the STORAGE-EXCLUDED classifier reserve with PER-RATE markup, while the
  // admission estimator adds the STORAGE-INCLUSIVE reserve and marks up the SUBTOTAL.
  // At integer nano rates the per-rate markup rounds the 15% away and the reserve is
  // ~3.8M nano larger, so the admission ceiling exceeded the 50M daily allowance and
  // free users could not send. The fit re-sizes the cap through the ONE estimator.
  const FREE_MODEL = 'free/smart';
  const CATALOG = [priced(FREE_MODEL, 2n, 3n, 128_000)];
  const DAILY_ALLOWANCE = 50_000_000n;
  const budget = {
    promptCharacterCount: 400,
    funding: { remainingNanoUsd: DAILY_ALLOWANCE, kind: 'free' as const },
  };

  /** The stamped, guess-capped definition — exactly what `compileSmartModelBuild`
   * builds for a persisting free-tier turn before the ceiling reconciliation. */
  function stampedGuess(): { definition: ReturnType<typeof withStorageStamp>; guessCap: number } {
    const picked = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: budget.funding.remainingNanoUsd,
      promptInputTokens: promptInputTokensFor(budget),
    });
    if (picked === null) throw new Error('expected a buildable free-tier smart-model turn');
    const guessCap = answerMaxOutputTokens(
      CATALOG,
      picked.candidates,
      budget,
      picked.classifierWorstCaseNanoUsd
    );
    if (guessCap === undefined) throw new Error('expected a derived answer cap');
    const { nodes, constraints } = createTurnCompileRegistries(snapshotResolver(CATALOG));
    const built = buildSmartModelTurn({
      classifierModelId: picked.classifierModelId,
      candidates: picked.candidates,
      answerMaxOutputTokens: guessCap,
      promptInputTokens: promptInputTokensFor(budget),
      nodes,
      constraints,
    })._unsafeUnwrap();
    return { definition: withStorageStamp(built, budget, CHAT_TURN_HOOKS), guessCap };
  }

  it('the storage-excluded per-rate guess over-reserves past the daily allowance', () => {
    const { definition } = stampedGuess();
    const ceiling = createEstimateRun(snapshotResolver(CATALOG))(definition)._unsafeUnwrap();
    expect(ceiling > DAILY_ALLOWANCE).toBe(true);
  });

  it('fits the reconciled admission ceiling within the daily allowance', () => {
    const { definition, guessCap } = stampedGuess();
    const fitted = fitAnswerCapToCeiling(
      definition,
      snapshotResolver(CATALOG),
      guessCap,
      DAILY_ALLOWANCE
    );
    const ceiling = createEstimateRun(snapshotResolver(CATALOG))(fitted)._unsafeUnwrap();
    expect(ceiling <= DAILY_ALLOWANCE).toBe(true);
  });

  it('shrinks the answer cap below the over-reserving guess', () => {
    const { definition, guessCap } = stampedGuess();
    const fitted = fitAnswerCapToCeiling(
      definition,
      snapshotResolver(CATALOG),
      guessCap,
      DAILY_ALLOWANCE
    );
    const node = fitted.nodes[0];
    const cap = node?.type === 'smartModel' ? node.params['maxOutputTokens'] : undefined;
    expect(typeof cap === 'number' && cap < guessCap && cap >= 1).toBe(true);
  });
});
