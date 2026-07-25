import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
  STORAGE_COST_PER_CHARACTER_NANO,
  WEB_SEARCH_RESERVATION_NANO_PER_MODEL,
  WorkflowDefinition,
  classifierReserveChars,
  estimateTokensForTier,
  nanoUSD,
  outputCharsPerTokenForTier,
  smartModelMinimumRequiredNanoUsd,
} from '@hushbox/shared';
import { DAILY_ALLOWANCE_NANO_USD } from '../../billing/index.js';

import { VALUE_STORE_BYTE_BUDGET_BYTES } from '../../workflows/engine/value-store.js';
import { createEstimateRun, estimateMinMediaOutputBytes } from './estimate-run.js';
import { buildSmartModelCandidates, classifierWorstCaseNanoUsd } from './smart-model-candidates.js';
import type { Pricing, ModelDescriptor, SmartModelPoolCandidate, UserTier } from '@hushbox/shared';
import type { ModelPricingResolver } from './estimate-run.js';

/**
 * The admission ceiling estimator prices a definition's declared worst case:
 * each modelCall's per-token ceiling (input+output at the model's full
 * context window) multiplied by its enclosing fanOut width and loop
 * iterations, summed across every model node. Over-estimation is the point —
 * a hold must never under-reserve — so these expectations assert the ceiling,
 * not an expected-value.
 */

const TOKEN_PRICING: Pricing = {
  inputPerToken: nanoUSD(2500n),
  outputPerToken: nanoUSD(10_000n),
};

// contextLength 1000 priced on BOTH legs: 1000×2500 + 1000×10000 = 12_500_000.
const BASE_1000 = 12_500_000n;

function buildDescriptor(params: {
  readonly id: string;
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
  readonly pricing?: Pricing;
}): ModelDescriptor {
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {
      ...(params.contextLength === undefined ? {} : { contextLength: params.contextLength }),
      ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    },
    pricing: params.pricing ?? TOKEN_PRICING,
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

function resolverOf(...descriptors: readonly ModelDescriptor[]): ModelPricingResolver {
  const byId = new Map(descriptors.map((d) => [d.id, d]));
  return (id) => byId.get(id);
}

function modelNode(id: string, model: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'modelCall',
    model,
    params: {},
    in: { node: 'src', port: 'out' },
    ...extra,
  };
}

function fanOutNode(id: string, body: string, maxWidth: number): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'fanOut',
    over: { node: 'src', port: 'out' },
    body,
    maxWidth,
  };
}

function loopNode(id: string, body: string, maxIterations: number): unknown {
  return { id, version: 1, out: 'out', type: 'loop', body, until: 'done', maxIterations };
}

function branchNode(id: string, cases: Record<string, string>, els: string): unknown {
  return { id, version: 1, out: 'out', type: 'branch', predicate: 'p', cases, else: els };
}

function transformNode(id: string): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'transform',
    transform: 't',
    in: { node: 'src', port: 'out' },
  };
}

function subWorkflowNode(id: string, ref: string): unknown {
  return { id, version: 1, out: 'out', type: 'subWorkflow', ref };
}

function smartModelNode(
  id: string,
  classifierModelId: string,
  candidateIds: readonly string[],
  extra: Record<string, unknown> = {}
): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'smartModel',
    classifierModelId,
    candidates: candidateIds.map((candidateId) => ({ id: candidateId })),
    in: { node: 'input', port: 'prompt' },
    ...extra,
  };
}

function workflow(
  nodes: readonly unknown[],
  storage?: { readonly inputChars: number; readonly tier: UserTier }
): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'text',
    hooks: { admission: 'chat', settlement: 'chat' },
    nodes,
    edges: [],
    ...(storage === undefined ? {} : { storage }),
  });
}

describe('estimateRun', () => {
  it('prices a single modelCall at that model context-window ceiling', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('multiplies a model node by its enclosing fanOut declared max width', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([fanOutNode('f1', 'm1', 3), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 3n);
  });

  it('does not multiply a fanOut of width one', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([fanOutNode('f1', 'm1', 1), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('multiplies a model node by its enclosing loop declared max iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([loopNode('l1', 'm1', 4), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 4n);
  });

  it('multiplies a model node by its declared agentic maxSteps', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt', { maxSteps: 2 })]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 2n);
  });

  it('caps the output leg at a declared maxOutputTokens param, shrinking the hold', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const capped = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 400 } })])
    );
    const uncapped = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // input leg stays the full context; output leg = min(1000, 400):
    // 1000×2500 + 400×10_000 = 6_500_000.
    expect(capped._unsafeUnwrap()).toBe(6_500_000n);
    expect(capped._unsafeUnwrap() < uncapped._unsafeUnwrap()).toBe(true);
  });

  it('never raises the output leg above the context window when the declared cap exceeds it', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 5000 } })])
    );

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('bounds the output leg at the catalog maxOutputTokens limit with no declared param', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 300 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // The capped model reserves less than the full-context worst case:
    // input leg 1000×2500 + output leg min(1000, 300)×10_000 = 5_500_000.
    expect(result._unsafeUnwrap()).toBe(5_500_000n);
    expect(result._unsafeUnwrap() < BASE_1000).toBe(true);
  });

  it('bounds a declared maxOutputTokens param above the catalog limit at the limit', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 300 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 800 } })])
    );

    expect(result._unsafeUnwrap()).toBe(5_500_000n);
  });

  it('keeps a declared maxOutputTokens param below the catalog limit (tightest wins)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 300 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 200 } })])
    );

    expect(result._unsafeUnwrap()).toBe(4_500_000n);
  });

  it('never raises the output leg above the context window when the catalog limit exceeds it', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, maxOutputTokens: 5000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('bounds the input leg at the stamped promptInputTokens, shrinking the hold', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const bounded = estimateRun(workflow([modelNode('m1', 'gpt', { promptInputTokens: 200 })]));
    const unbounded = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // input leg = min(1000, 200) = 200; output leg stays the full context:
    // 200×2500 + 1000×10_000 = 10_500_000.
    expect(bounded._unsafeUnwrap()).toBe(10_500_000n);
    expect(bounded._unsafeUnwrap() < unbounded._unsafeUnwrap()).toBe(true);
  });

  it('never raises the input leg above the context window when promptInputTokens exceeds it', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt', { promptInputTokens: 9999 })]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['non-numeric', '400'],
  ])('falls back to the full-context output leg for a %s maxOutputTokens param', (_label, bad) => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: bad } })])
    );

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('preserves the maxSteps multiplier on a capped call', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { maxSteps: 3, params: { maxOutputTokens: 400 } })])
    );

    expect(result._unsafeUnwrap()).toBe(6_500_000n * 3n);
  });

  it('multiplies by the product of nested fanOut width and loop iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // fanOut(width 2) → loop(iters 3) → modelCall  ⇒ ceiling ×6.
    const result = estimateRun(
      workflow([fanOutNode('f1', 'l1', 2), loopNode('l1', 'm1', 3), modelNode('m1', 'gpt')])
    );

    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 6n);
  });

  it('inherits an enclosing fanOut through a branch and sums the branch targets', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'gpt', contextLength: 1000 }),
        buildDescriptor({ id: 'claude', contextLength: 1000 })
      )
    );

    // fanOut(width 2) → branch{a: m1, else: 'end'} plus a second case m2.
    const result = estimateRun(
      workflow([
        fanOutNode('f1', 'b1', 2),
        branchNode('b1', { a: 'm1', b: 'm2' }, 'end'),
        modelNode('m1', 'gpt'),
        modelNode('m2', 'claude'),
      ])
    );

    // Both branch targets ride the fanOut ×2, branch itself adds nothing.
    expect(result._unsafeUnwrap()).toBe(BASE_1000 * 2n + BASE_1000 * 2n);
  });

  it('sums the ceilings of every model node in the definition', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'gpt', contextLength: 1000 }),
        buildDescriptor({
          id: 'claude',
          contextLength: 500,
          pricing: { inputPerToken: nanoUSD(1000n), outputPerToken: nanoUSD(2000n) },
        })
      )
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt'), modelNode('m2', 'claude')]));

    // gpt: 12_500_000 ; claude: 500×1000 + 500×2000 = 1_500_000.
    expect(result._unsafeUnwrap()).toBe(BASE_1000 + 1_500_000n);
  });

  it('adds the worst-case web-search reservation to a modelCall that enabled the search tool', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // A web-search modelCall carries `tools: ['webSearch']`. Admission holds the
    // model token ceiling PLUS the flat search reservation, so the turn is
    // refused up front when it cannot afford both — never admitted then killed
    // mid-run by the cost circuit.
    const result = estimateRun(workflow([modelNode('m1', 'gpt', { tools: ['webSearch'] })]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000 + WEB_SEARCH_RESERVATION_NANO_PER_MODEL);
  });

  it('exceeds the same turn without web search by exactly the reservation (admission refuses a balance between them)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const withSearch = estimateRun(
      workflow([modelNode('m1', 'gpt', { tools: ['webSearch'] })])
    )._unsafeUnwrap();
    const withoutSearch = estimateRun(workflow([modelNode('m1', 'gpt')]))._unsafeUnwrap();

    // Admission refuses when balance < estimate, so a wallet holding exactly the
    // no-search estimate cannot afford the web-search run — refused pre-flight.
    expect(withSearch - withoutSearch).toBe(WEB_SEARCH_RESERVATION_NANO_PER_MODEL);
    expect(withSearch > withoutSearch).toBe(true);
  });

  it('reserves the search worst case per web-search model node (N models → N reservations)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'gpt', contextLength: 1000 }),
        buildDescriptor({ id: 'claude', contextLength: 1000 })
      )
    );

    const result = estimateRun(
      workflow([
        modelNode('m1', 'gpt', { tools: ['webSearch'] }),
        modelNode('m2', 'claude', { tools: ['webSearch'] }),
      ])
    );

    // Each sibling could invoke search up to the cap, so each reserves the worst
    // case — matching legacy's N× multiplication over the selected models.
    expect(result._unsafeUnwrap()).toBe(
      BASE_1000 +
        WEB_SEARCH_RESERVATION_NANO_PER_MODEL +
        BASE_1000 +
        WEB_SEARCH_RESERVATION_NANO_PER_MODEL
    );
  });

  it('adds no search reservation to a modelCall with no tools declared', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt', { tools: [] })]));

    // Web search off ⇒ the ceiling is unchanged (no search term).
    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('scales the web-search reservation by an enclosing fanOut width and loop iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // fanOut(width 2) → loop(iters 3) → web-search modelCall ⇒ the model ceiling
    // ×6 AND the search reservation ×6: each fanned/looped invocation can search
    // up to the cap, so the worst-case hold scales with the enclosure.
    const result = estimateRun(
      workflow([
        fanOutNode('f1', 'l1', 2),
        loopNode('l1', 'm1', 3),
        modelNode('m1', 'gpt', { tools: ['webSearch'] }),
      ])
    );

    expect(result._unsafeUnwrap()).toBe(
      BASE_1000 * 6n + WEB_SEARCH_RESERVATION_NANO_PER_MODEL * 6n
    );
  });

  it('ignores non-model nodes when summing', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([transformNode('t1'), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('prices a smartModel node at the bounded classifier reserve plus the MAX candidate ceiling', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(
      resolverOf(
        cheap,
        buildDescriptor({ id: 'mid', contextLength: 2000 }),
        buildDescriptor({ id: 'big', contextLength: 4000 })
      )
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'mid', 'big'])]));

    // The classifier is priced at its bounded truncated-context reserve (the
    // affordability filter's basis), NOT a full-context modelCall. Exactly ONE
    // candidate answers, so the ceiling is classifier + max candidate.
    const classifierReserve = classifierWorstCaseNanoUsd(cheap, [
      { id: 'cheap' },
      { id: 'mid' },
      { id: 'big' },
    ])!;
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000 * 4n);
  });

  it('holds NO classifier reserve for a single-candidate model-only node (short-circuit never bills)', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap'])]));

    // One candidate, model dimension only: the execution short-circuits with
    // zero classifier generations, so admission reserves the candidate alone.
    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });

  it('reserves only the affordable subset end to end: a low-balance wallet prices cheap, never the expensive candidate', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const big = buildDescriptor({
      id: 'big',
      contextLength: 8000,
      pricing: { inputPerToken: nanoUSD(50_000n), outputPerToken: nanoUSD(50_000n) },
    });
    // A wallet that funds cheap's floor + classifier reserve, but nowhere near
    // big's far larger worst case: the affordable-subset gate admits [cheap].
    const reserve = classifierWorstCaseNanoUsd(cheap, [{ id: 'cheap' }, { id: 'big' }])!;
    const cheapFloor = BASE_1000;
    const built = buildSmartModelCandidates({
      descriptors: [cheap, big],
      balanceNanoUsd: reserve + cheapFloor,
    });
    expect(built?.candidates.map((candidate) => candidate.id)).toEqual(['cheap']);

    const estimateRun = createEstimateRun(resolverOf(cheap, big));
    const subsetCeiling = estimateRun(
      workflow([smartModelNode('s1', built!.classifierModelId, ['cheap'])])
    );
    // One affordable candidate, model dimension only → the classifier
    // short-circuits (no reserve); admission holds the CHEAP ceiling alone.
    expect(subsetCeiling._unsafeUnwrap()).toBe(cheapFloor);

    // Had the pre-legacy fixed menu handed admission the whole pool, the node
    // would have MAXed over big's worst case — strictly more than the subset.
    const fullPoolCeiling = estimateRun(
      workflow([smartModelNode('s1', 'cheap', ['cheap', 'big'])])
    );
    expect(fullPoolCeiling._unsafeUnwrap()).toBeGreaterThan(cheapFloor);
  });

  describe('the run estimator (eligible-subset reserve) never exceeds the client threshold', () => {
    // The client prices the affordability threshold
    // (`smartModelMinimumRequiredNanoUsd`) and the server pre-gate
    // (`buildSmartModelCandidates`) both over the FULL priceable pool; the run
    // estimator re-prices the classifier reserve over `node.candidates` — the
    // ELIGIBLE subset, the classifier's real runtime menu — which is a subset,
    // so its hold is only ever ≤ the reserve the client budgeted for. These pin
    // the exact biconditional END TO END through the real estimator, even when
    // the full pool's cheapest (the classifier) is itself ineligible and thus
    // absent from the eligible subset the estimator prices.
    const TINY = buildDescriptor({
      id: 'tiny',
      contextLength: 500, // < prompt(100) + MINIMUM_OUTPUT_TOKENS(1000) ⇒ ineligible
      pricing: { inputPerToken: nanoUSD(1n), outputPerToken: nanoUSD(2n) },
    });
    const WIDE_CHEAP = buildDescriptor({
      id: 'wide-cheap',
      contextLength: 8000,
      pricing: { inputPerToken: nanoUSD(5n), outputPerToken: nanoUSD(10n) },
    });
    const WIDE_PRICEY = buildDescriptor({
      id: 'wide-pricey',
      contextLength: 8000,
      pricing: { inputPerToken: nanoUSD(6n), outputPerToken: nanoUSD(12n) },
    });
    const DESCRIPTORS = [TINY, WIDE_CHEAP, WIDE_PRICEY];
    const TIER: UserTier = 'paid';
    const PROMPT_CHARS = 400;
    const PROMPT_TOKENS = estimateTokensForTier(TIER, PROMPT_CHARS);
    const STORAGE = {
      outputCharsPerToken: outputCharsPerTokenForTier(TIER),
      inputChars: PROMPT_CHARS,
    };

    function poolCandidate(descriptor: ModelDescriptor): SmartModelPoolCandidate {
      const contextLength = descriptor.limits['contextLength'];
      return {
        id: descriptor.id,
        pricing: descriptor.pricing,
        ...(contextLength === undefined ? {} : { contextLength }),
      };
    }
    const POOL = DESCRIPTORS.map((descriptor) => poolCandidate(descriptor));
    const CLIENT_THRESHOLD = smartModelMinimumRequiredNanoUsd(POOL, PROMPT_TOKENS, STORAGE)!;

    function estimatorHold(balanceNanoUsd: bigint): bigint {
      const built = buildSmartModelCandidates({
        descriptors: DESCRIPTORS,
        balanceNanoUsd,
        promptInputTokens: PROMPT_TOKENS,
        storage: STORAGE,
      })!;
      const node = {
        id: 's1',
        version: 1,
        out: 'out',
        type: 'smartModel',
        classifierModelId: built.classifierModelId,
        candidates: built.candidates,
        promptInputTokens: PROMPT_TOKENS,
        params: {},
        in: { node: 'input', port: 'prompt' },
      };
      return createEstimateRun(resolverOf(...DESCRIPTORS))(
        workflow([node], { inputChars: PROMPT_CHARS, tier: TIER })
      )._unsafeUnwrap();
    }

    it('refuses one nano below the client threshold and admits at it (client-deny ⇒ server-deny)', () => {
      expect(
        buildSmartModelCandidates({
          descriptors: DESCRIPTORS,
          balanceNanoUsd: CLIENT_THRESHOLD - 1n,
          promptInputTokens: PROMPT_TOKENS,
          storage: STORAGE,
        })
      ).toBeNull();
      expect(
        buildSmartModelCandidates({
          descriptors: DESCRIPTORS,
          balanceNanoUsd: CLIENT_THRESHOLD,
          promptInputTokens: PROMPT_TOKENS,
          storage: STORAGE,
        })
      ).not.toBeNull();
    });

    it('keeps the ineligible cheapest as the classifier but out of the eligible candidate set', () => {
      const built = buildSmartModelCandidates({
        descriptors: DESCRIPTORS,
        balanceNanoUsd: CLIENT_THRESHOLD * 100n,
        promptInputTokens: PROMPT_TOKENS,
        storage: STORAGE,
      })!;
      expect(built.classifierModelId).toBe('tiny');
      expect(built.candidates.map((candidate) => candidate.id)).not.toContain('tiny');
      // At a well-funded balance both wide models qualify, so the estimator prices
      // the classifier reserve over a two-candidate subset that still excludes the
      // classifier itself — a strict subset of the full pool the threshold priced.
      expect(built.candidates.map((candidate) => candidate.id)).toEqual([
        'wide-cheap',
        'wide-pricey',
      ]);
    });

    it('holds ≤ the admitted balance at the boundary and when well funded (no unpredicted 402)', () => {
      expect(estimatorHold(CLIENT_THRESHOLD)).toBeLessThanOrEqual(CLIENT_THRESHOLD);
      const funded = CLIENT_THRESHOLD * 100n;
      expect(estimatorHold(funded)).toBeLessThanOrEqual(funded);
    });
  });

  it('holds the classifier reserve for a single-candidate node declaring the effort dimension (pinned + auto)', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['cheap'], { classify: { model: false, effort: true } }),
      ])
    );

    const classifierReserve = classifierWorstCaseNanoUsd(cheap, [{ id: 'cheap' }])!;
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000);
  });

  it('caps smartModel candidate (answer) ceilings via node params, classifier at its bounded reserve', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(
      resolverOf(cheap, buildDescriptor({ id: 'big', contextLength: 4000 }))
    );

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['cheap', 'big'], { params: { maxOutputTokens: 100 } }),
      ])
    );

    // The answer runs with the node's params, so each candidate's output leg is
    // capped at 100: cheap = 1000×2500 + 100×10_000 = 3_500_000; big = 4000×2500
    // + 100×10_000 = 11_000_000 → max candidate 11_000_000. The classifier call
    // never receives the answer params — it stays at its bounded reserve.
    const classifierReserve = classifierWorstCaseNanoUsd(cheap, [{ id: 'cheap' }, { id: 'big' }])!;
    expect(result._unsafeUnwrap()).toBe(classifierReserve + 11_000_000n);
  });

  it('multiplies a smartModel node (classifier reserve and candidate) by its enclosing fanOut width', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    // Effort dimension declared so the single-candidate node still runs a
    // classifier (the model-only single candidate holds no reserve at all).
    const result = estimateRun(
      workflow([
        fanOutNode('f1', 's1', 3),
        smartModelNode('s1', 'cheap', ['cheap'], { classify: { model: false, effort: true } }),
      ])
    );

    // Both the classifier reserve and the candidate ceiling scale by the width.
    const classifierReserve = classifierWorstCaseNanoUsd(cheap, [{ id: 'cheap' }])! * 3n;
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000 * 3n);
  });

  it('refuses gracefully when a nested enclosure multiplier exceeds the safe-integer range (classifier reserve)', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    // workflow.ts bounds each container's maxWidth/maxIterations at .int().min(1)
    // with no upper bound, so nested same-axis loops can accumulate an enclosure
    // product past Number.MAX_SAFE_INTEGER while every individual bound stays
    // schema-valid: 1e8 × 1e8 = 1e16 > MAX_SAFE_INTEGER. The classifier reserve
    // feeds that product straight to the core reservationCeiling, which THROWS a
    // RangeError on a non-safe multiplier — so admission must refuse it on the
    // Result channel exactly like the sibling candidate (modelCall) path, never
    // let the throw escape as an uncaught defect (500 + Sentry).
    const definition = workflow([
      loopNode('outer', 'inner', 100_000_000),
      loopNode('inner', 's1', 100_000_000),
      smartModelNode('s1', 'cheap', ['cheap'], { classify: { model: false, effort: true } }),
    ]);

    const result = estimateRun(definition);

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when the smartModel classifier is unknown to the catalog', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'mid', contextLength: 2000 }))
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'ghost', ['mid'])]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a smartModel candidate is unknown to the catalog', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'cheap', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'ghost'])]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('prices the classifier without requiring its own context limit (truncated-context reserve)', () => {
    // The classifier reserve truncates input at MAX_CLASSIFIER_CONTEXT_CHARS and
    // caps output at CLASSIFIER_OUTPUT_TOKEN_CAP, so the classifier model needs a
    // per-token rate but NOT a context-window limit of its own.
    const cheap = buildDescriptor({ id: 'cheap' });
    const estimateRun = createEstimateRun(
      resolverOf(cheap, buildDescriptor({ id: 'mid', contextLength: 2000 }))
    );

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['mid'], { classify: { model: false, effort: true } }),
      ])
    );

    const classifierReserve = classifierWorstCaseNanoUsd(cheap, [{ id: 'mid' }])!;
    // mid contextLength 2000 priced on both legs = 2000×2500 + 2000×10_000.
    expect(result._unsafeUnwrap()).toBe(classifierReserve + BASE_1000 * 2n);
  });

  it('fails closed when the smartModel classifier lacks a per-token rate', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'cheap', contextLength: 1000, pricing: { perImage: nanoUSD(1n) } }),
        buildDescriptor({ id: 'mid', contextLength: 2000 })
      )
    );

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['mid'], { classify: { model: false, effort: true } }),
      ])
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  // The load-bearing money invariant: a free-tier default (Smart Model) turn's
  // worst-case admission ceiling must fit the daily allowance, or the free tier
  // cannot send at all. Before the corrected formula this priced full context on
  // every leg (~$4–$25); the stamped prompt basis + bounded answer cap + bounded
  // classifier reserve bring it under $0.05.
  it('holds the free-tier Smart worst-case admission ceiling within the daily allowance', () => {
    const cheap = buildDescriptor({
      id: 'cheap',
      contextLength: 200_000,
      pricing: { inputPerToken: nanoUSD(100n), outputPerToken: nanoUSD(100n) },
    });
    const sonnet = buildDescriptor({
      id: 'sonnet',
      contextLength: 200_000,
      pricing: { inputPerToken: nanoUSD(3000n), outputPerToken: nanoUSD(15_000n) },
    });
    const estimateRun = createEstimateRun(resolverOf(cheap, sonnet));

    // A stamped free-tier Smart turn: a real (small) prompt and a bounded answer.
    const bounded = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['cheap', 'sonnet'], {
          promptInputTokens: 500,
          params: { maxOutputTokens: 1000 },
        }),
      ])
    );
    // The identical turn WITHOUT the stamped basis prices full context on every
    // leg — the regression this task fixes.
    const fullContext = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'sonnet'])]));

    expect(bounded._unsafeUnwrap() <= DAILY_ALLOWANCE_NANO_USD).toBe(true);
    // The unstamped ceiling is orders of magnitude over the allowance (the bug).
    expect(fullContext._unsafeUnwrap() > DAILY_ALLOWANCE_NANO_USD * 50n).toBe(true);
  });

  it('fails closed on a subWorkflow node whose nested cost cannot be priced here', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([subWorkflowNode('s1', 'nested')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a model is unknown to the catalog', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'ghost')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a resolved model has no pricing', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000, pricing: {} }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when a resolved model declares no context-token limit', () => {
    const estimateRun = createEstimateRun(resolverOf(buildDescriptor({ id: 'gpt' })));

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

/**
 * Media (image/video) nodes price deterministically from catalog rates and
 * the node's declared call params — no context window exists to bound them.
 */
function mediaDescriptor(params: {
  readonly id: string;
  readonly outputs: readonly ('image' | 'video')[];
  readonly pricing: Pricing;
}): ModelDescriptor {
  return {
    ...buildDescriptor({ id: params.id, pricing: params.pricing }),
    inputs: ['text'],
    outputs: [...params.outputs],
    behaviors: [],
  };
}

describe('estimateRun — deterministic media ceilings', () => {
  const IMAGE_PRICING: Pricing = { perImage: nanoUSD(40_000_000n) };
  const VIDEO_PRICING: Pricing = {
    perSecondByResolution: { '720p': nanoUSD(98_800_000n) },
  };

  it('refuses a multi-image node at estimate time (one generation call, one artifact)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img', { params: { n: 2 } })]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('prices an image node with no params at one output image', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img')]));

    expect(result._unsafeUnwrap()).toBe(40_000_000n);
  });

  it('prices a video node per second at the requested resolution', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '720p', durationSeconds: 4 } })])
    );

    expect(result._unsafeUnwrap()).toBe(395_200_000n);
  });

  it('multiplies a media node by its enclosing fanOut declared max width', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(
      workflow([fanOutNode('f1', 'm1', 3), modelNode('m1', 'img', { params: { n: 1 } })])
    );

    expect(result._unsafeUnwrap()).toBe(40_000_000n * 3n);
  });

  it('refuses a video node missing the params that make it priceable', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'vid')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a video node whose resolution is absent from the pricing matrix', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '4k', durationSeconds: 4 } })])
    );

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses an unpriced image node (fail-closed, never a silent zero)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: {} }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img')]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});

describe('estimateMinMediaOutputBytes', () => {
  it('returns zero for a non-media (text) call', () => {
    expect(estimateMinMediaOutputBytes('language', {})).toBe(0);
    expect(estimateMinMediaOutputBytes(undefined, {})).toBe(0);
  });

  it('scales a video floor linearly with declared duration', () => {
    const short = estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 4 });
    const long = estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 8 });

    expect(long).toBe(short * 2);
  });

  it('scales a video floor with resolution area (720p < 1080p < 4k)', () => {
    const r720 = estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 8 });
    const r1080 = estimateMinMediaOutputBytes('video', { resolution: '1080p', durationSeconds: 8 });
    const r4k = estimateMinMediaOutputBytes('video', { resolution: '4k', durationSeconds: 8 });

    expect(r1080).toBeGreaterThan(r720);
    expect(r4k).toBeGreaterThan(r1080);
    // 1080p / 720p area ratio is exactly 2.25 — structural, not tied to the floor.
    expect(r1080).toBe(Math.floor((r720 * (1920 * 1080)) / (1280 * 720)));
  });

  it('scales an image floor with megapixels', () => {
    const oneMp = estimateMinMediaOutputBytes('image', { resolution: '1000x1000' });
    const fourMp = estimateMinMediaOutputBytes('image', { resolution: '2000x2000' });

    expect(oneMp).toBeGreaterThan(0);
    expect(fourMp).toBe(oneMp * 4);
  });

  it('scales an image floor with the requested count n', () => {
    const one = estimateMinMediaOutputBytes('image', { resolution: '1000x1000', n: 1 });
    const two = estimateMinMediaOutputBytes('image', { resolution: '1000x1000', n: 2 });

    expect(two).toBe(one * 2);
  });

  it('treats a video with no declared duration as zero (nothing to gate)', () => {
    expect(estimateMinMediaOutputBytes('video', { resolution: '720p' })).toBe(0);
    expect(estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 0 })).toBe(
      0
    );
  });

  it('falls back to the baseline resolution factor when the tier is unrecognized', () => {
    const baseline = estimateMinMediaOutputBytes('video', {
      resolution: '720p',
      durationSeconds: 8,
    });
    const unknown = estimateMinMediaOutputBytes('video', {
      resolution: 'ultra-hd',
      durationSeconds: 8,
    });

    // Unknown tier → area unknown → baseline factor (never inflated), so the
    // floor matches the 720p baseline rather than false-rejecting.
    expect(unknown).toBe(baseline);
  });

  it('returns zero for an image with no parseable resolution', () => {
    expect(estimateMinMediaOutputBytes('image', {})).toBe(0);
    expect(estimateMinMediaOutputBytes('image', { resolution: 42 })).toBe(0);
  });

  it('treats a non-positive image count as one', () => {
    const single = estimateMinMediaOutputBytes('image', { resolution: '1000x1000' });
    const zeroCount = estimateMinMediaOutputBytes('image', { resolution: '1000x1000', n: 0 });

    expect(zeroCount).toBe(single);
  });

  it('never resolves a hostile resolution key to an inherited member', () => {
    // `'constructor'` on a plain-object map would resolve Object's constructor;
    // the Map-backed lookup yields undefined → treated as an unparseable string.
    expect(
      estimateMinMediaOutputBytes('video', { resolution: 'constructor', durationSeconds: 8 })
    ).toBe(estimateMinMediaOutputBytes('video', { resolution: '720p', durationSeconds: 8 }));
  });

  it('sits just under the value-store budget at the video floor boundary, and just over one step higher', () => {
    // 4k, 74s is the largest declaration whose minimum-plausible bytes still fit
    // the 20 MB budget under the conservative floor; 75s is the first that cannot.
    const underBudget = estimateMinMediaOutputBytes('video', {
      resolution: '4k',
      durationSeconds: 74,
    });
    const overBudget = estimateMinMediaOutputBytes('video', {
      resolution: '4k',
      durationSeconds: 75,
    });

    expect(underBudget).toBeLessThanOrEqual(VALUE_STORE_BYTE_BUDGET_BYTES);
    expect(overBudget).toBeGreaterThan(VALUE_STORE_BYTE_BUDGET_BYTES);
  });
});

describe('estimateRun — media output size gate', () => {
  // Prices 4k so the ONLY thing that can reject an oversize 4k declaration is
  // the size gate, never a missing pricing rate.
  const VIDEO_PRICING_4K: Pricing = {
    perSecondByResolution: { '4k': nanoUSD(98_800_000n) },
  };

  it('rejects a video whose minimum-plausible output cannot fit the value-store budget', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING_4K }))
    );

    const params = { resolution: '4k', durationSeconds: 75 };
    // The declaration is genuinely over budget and would otherwise price fine.
    expect(estimateMinMediaOutputBytes('video', params)).toBeGreaterThan(
      VALUE_STORE_BYTE_BUDGET_BYTES
    );

    const result = estimateRun(workflow([modelNode('m1', 'vid', { params })]));

    // Surfaced via the same VALIDATION fail-closed channel as any unpriceable
    // node; the interpreter turns this into `failBeforeAdmission` (before the
    // admission hook and before any provider call).
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('admits a normal-size video generation — same pricing, smaller declaration', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING_4K }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '4k', durationSeconds: 4 } })])
    );

    expect(result.isOk()).toBe(true);
  });

  it('leaves a text-only run unaffected by the media size gate', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });
});

/**
 * A persisting turn stamps `storage = { inputChars, tier }` onto its DEFINITION,
 * and the ceiling then covers, PASS-THROUGH (never marked up): input storage ONCE
 * at the definition level (`inputChars × charRate`), output storage per
 * answer-producing node (`outputCeiling × outputCharsPerToken(tier) × charRate`),
 * the classifier reserve's own storage, and media output storage
 * (`estimatedBytes × byteRate`). Every canonical (with-storage) figure below is
 * hand-derived from those formulas. A run WITHOUT a storage stamp is unchanged
 * (pinned by the suites above), so these assert the storage delta directly. The
 * estimator reads the stamp per-run from the definition it is handed — one
 * estimator instance, no per-caller storage argument.
 */
describe('estimateRun — persisting-turn storage', () => {
  const CHAR_RATE = STORAGE_COST_PER_CHARACTER_NANO; // 300 nano/char
  const IMAGE_PRICING: Pricing = { perImage: nanoUSD(40_000_000n) };
  const VIDEO_PRICING: Pricing = { perSecondByResolution: { '720p': nanoUSD(98_800_000n) } };

  it('adds output storage per text node at the free (4 chars/token) ratio and input storage once', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt')], { inputChars: 100, tier: 'free' })
    );

    // provider = BASE_1000 = 14,375,000.
    // output-storage = outputCeiling(1000) × outputCharsPerToken(free=4) × 300 = 1,200,000.
    // input-storage (once) = 100 × 300 = 30,000. Storage never marks up.
    expect(outputCharsPerTokenForTier('free')).toBe(4);
    const outputStorage = 1000n * BigInt(outputCharsPerTokenForTier('free')) * CHAR_RATE;
    expect(result._unsafeUnwrap()).toBe(BASE_1000 + outputStorage + 100n * CHAR_RATE);
    expect(outputStorage).toBe(1_200_000n);
  });

  it('sizes output storage at the paid (conservative, 2 chars/token) ratio', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')], { inputChars: 0, tier: 'paid' }));

    // paid output ratio is 2 (conservative): 1000 × 2 × 300 = 600,000; no input chars.
    expect(outputCharsPerTokenForTier('paid')).toBe(2);
    const outputStorage = 1000n * BigInt(outputCharsPerTokenForTier('paid')) * CHAR_RATE;
    expect(result._unsafeUnwrap()).toBe(BASE_1000 + outputStorage);
    expect(outputStorage).toBe(600_000n);
  });

  it('includes media output storage for an image node (ESTIMATED_IMAGE_BYTES × byte rate)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'img')], { inputChars: 0, tier: 'free' }));

    // provider = 40,000,000 = 46,000,000.
    // media-storage = ESTIMATED_IMAGE_BYTES(8,000,000) × 18 = 144,000,000. No output tokens.
    const mediaStorage = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(result._unsafeUnwrap()).toBe(40_000_000n + mediaStorage);
    expect(mediaStorage).toBe(144_000_000n);
  });

  it('includes media output storage for a video node (duration × per-second bytes × byte rate)', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '720p', durationSeconds: 4 } })], {
        inputChars: 0,
        tier: 'free',
      })
    );

    // provider = 98,800,000 × 4 = 395,200,000 = 454,480,000.
    // media-storage = 4 × ESTIMATED_VIDEO_BYTES_PER_SECOND(5,000,000) × 18 = 360,000,000.
    const mediaStorage =
      4n * BigInt(ESTIMATED_VIDEO_BYTES_PER_SECOND) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(result._unsafeUnwrap()).toBe(395_200_000n + mediaStorage);
    expect(mediaStorage).toBe(360_000_000n);
  });

  it('adds classifier, candidate-output, and input storage to a smartModel node', () => {
    const cheap = buildDescriptor({ id: 'cheap', contextLength: 1000 });
    const estimateRun = createEstimateRun(resolverOf(cheap));

    const pinnedAuto = { classify: { model: false, effort: true } };
    const withStorageDefinition = workflow([smartModelNode('s1', 'cheap', ['cheap'], pinnedAuto)], {
      inputChars: 50,
      tier: 'free',
    });
    const withoutStorageDefinition = workflow([
      smartModelNode('s1', 'cheap', ['cheap'], pinnedAuto),
    ]);

    // Classifier reserve storage (raw): reserve chars input + output cap chars, at
    // the trial output ratio (classifier storage is always the trial ratio).
    const reserveChars = classifierReserveChars([{ id: 'cheap' }]);
    const classifierStorage =
      BigInt(reserveChars) * CHAR_RATE +
      BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * BigInt(outputCharsPerTokenForTier('trial')) * CHAR_RATE;
    // The one candidate ('cheap', full-context 1000 output) at the free output ratio.
    const candidateOutputStorage = 1000n * BigInt(outputCharsPerTokenForTier('free')) * CHAR_RATE;
    const inputStorage = 50n * CHAR_RATE;

    const delta =
      estimateRun(withStorageDefinition)._unsafeUnwrap() -
      estimateRun(withoutStorageDefinition)._unsafeUnwrap();
    expect(delta).toBe(classifierStorage + candidateOutputStorage + inputStorage);
  });

  it('adds no storage when the definition carries no storage stamp', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    // Provider cost only — the pre-storage default for general (non-persisting) runs.
    expect(result._unsafeUnwrap()).toBe(BASE_1000);
  });
});
