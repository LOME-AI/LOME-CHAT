import { describe, expect, it } from 'vitest';
import { WorkflowDefinition, nanoUSD } from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { WORST_CASE_SEARCH_RESERVATION_NANO_USD } from './estimate.js';
import { VALUE_STORE_BYTE_BUDGET_BYTES } from '../../workflows/engine/value-store.js';
import { createEstimateRun, estimateMinMediaOutputBytes } from './estimate-run.js';
import type { Pricing, ModelDescriptor } from '@hushbox/shared';
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
    limits: params.contextLength === undefined ? {} : { contextLength: params.contextLength },
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

function workflow(nodes: readonly unknown[]): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'text',
    hooks: { admission: 'chat', settlement: 'chat' },
    nodes,
    edges: [],
  });
}

describe('estimateRun', () => {
  it('prices a single modelCall at that model context-window ceiling', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000));
  });

  it('multiplies a model node by its enclosing fanOut declared max width', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([fanOutNode('f1', 'm1', 3), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000 * 3n));
  });

  it('does not multiply a fanOut of width one', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([fanOutNode('f1', 'm1', 1), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000));
  });

  it('multiplies a model node by its enclosing loop declared max iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([loopNode('l1', 'm1', 4), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000 * 4n));
  });

  it('multiplies a model node by its declared agentic maxSteps', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt', { maxSteps: 2 })]));

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000 * 2n));
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
    expect(capped._unsafeUnwrap()).toBe(applyMarkup(6_500_000n));
    expect(capped._unsafeUnwrap() < uncapped._unsafeUnwrap()).toBe(true);
  });

  it('never raises the output leg above the context window when the declared cap exceeds it', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { params: { maxOutputTokens: 5000 } })])
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000));
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

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000));
  });

  it('preserves the maxSteps multiplier on a capped call', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'gpt', { maxSteps: 3, params: { maxOutputTokens: 400 } })])
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(6_500_000n * 3n));
  });

  it('multiplies by the product of nested fanOut width and loop iterations', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    // fanOut(width 2) → loop(iters 3) → modelCall  ⇒ ceiling ×6.
    const result = estimateRun(
      workflow([fanOutNode('f1', 'l1', 2), loopNode('l1', 'm1', 3), modelNode('m1', 'gpt')])
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000 * 6n));
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
    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000 * 2n) + applyMarkup(BASE_1000 * 2n));
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
    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000) + applyMarkup(1_500_000n));
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

    expect(result._unsafeUnwrap()).toBe(
      applyMarkup(BASE_1000) + WORST_CASE_SEARCH_RESERVATION_NANO_USD
    );
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
    expect(withSearch - withoutSearch).toBe(WORST_CASE_SEARCH_RESERVATION_NANO_USD);
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
      applyMarkup(BASE_1000) +
        WORST_CASE_SEARCH_RESERVATION_NANO_USD +
        applyMarkup(BASE_1000) +
        WORST_CASE_SEARCH_RESERVATION_NANO_USD
    );
  });

  it('adds no search reservation to a modelCall with no tools declared', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([modelNode('m1', 'gpt', { tools: [] })]));

    // Web search off ⇒ the ceiling is unchanged (no search term).
    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000));
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
      applyMarkup(BASE_1000 * 6n) + WORST_CASE_SEARCH_RESERVATION_NANO_USD * 6n
    );
  });

  it('ignores non-model nodes when summing', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'gpt', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([transformNode('t1'), modelNode('m1', 'gpt')]));

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000));
  });

  it('prices a smartModel node at the classifier ceiling plus the MAX candidate ceiling', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'cheap', contextLength: 1000 }),
        buildDescriptor({ id: 'mid', contextLength: 2000 }),
        buildDescriptor({ id: 'big', contextLength: 4000 })
      )
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'mid', 'big'])]));

    // Exactly ONE candidate answers, so the ceiling is classifier + max — the
    // sum over candidates would over-hold N×.
    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000) + applyMarkup(BASE_1000 * 4n));
  });

  it('caps smartModel candidate (answer) ceilings via node params while the classifier stays uncapped', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'cheap', contextLength: 1000 }),
        buildDescriptor({ id: 'big', contextLength: 4000 })
      )
    );

    const result = estimateRun(
      workflow([
        smartModelNode('s1', 'cheap', ['cheap', 'big'], { params: { maxOutputTokens: 100 } }),
      ])
    );

    // The answer runs with the node's params, so each candidate's output leg is
    // capped at 100: cheap = 1000×2500 + 100×10_000 = 3_500_000; big = 4000×2500
    // + 100×10_000 = 11_000_000 → max candidate 11_000_000. The classifier call
    // never receives the answer params — it stays at its full-context ceiling.
    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000) + applyMarkup(11_000_000n));
  });

  it('multiplies a smartModel node by its enclosing fanOut declared max width', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'cheap', contextLength: 1000 }))
    );

    const result = estimateRun(
      workflow([fanOutNode('f1', 's1', 3), smartModelNode('s1', 'cheap', ['cheap'])])
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000 * 3n) + applyMarkup(BASE_1000 * 3n));
  });

  it('fails closed when a smartModel candidate is unknown to the catalog', () => {
    const estimateRun = createEstimateRun(
      resolverOf(buildDescriptor({ id: 'cheap', contextLength: 1000 }))
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['cheap', 'ghost'])]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails closed when the smartModel classifier declares no context-token limit', () => {
    const estimateRun = createEstimateRun(
      resolverOf(
        buildDescriptor({ id: 'cheap' }),
        buildDescriptor({ id: 'mid', contextLength: 2000 })
      )
    );

    const result = estimateRun(workflow([smartModelNode('s1', 'cheap', ['mid'])]));

    expect(result._unsafeUnwrapErr().code).toBe('validation');
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

    expect(result._unsafeUnwrap()).toBe(applyMarkup(40_000_000n));
  });

  it('prices a video node per second at the requested resolution', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'vid', outputs: ['video'], pricing: VIDEO_PRICING }))
    );

    const result = estimateRun(
      workflow([modelNode('m1', 'vid', { params: { resolution: '720p', durationSeconds: 4 } })])
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(395_200_000n));
  });

  it('multiplies a media node by its enclosing fanOut declared max width', () => {
    const estimateRun = createEstimateRun(
      resolverOf(mediaDescriptor({ id: 'img', outputs: ['image'], pricing: IMAGE_PRICING }))
    );

    const result = estimateRun(
      workflow([fanOutNode('f1', 'm1', 3), modelNode('m1', 'img', { params: { n: 1 } })])
    );

    expect(result._unsafeUnwrap()).toBe(applyMarkup(40_000_000n * 3n));
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

    expect(result._unsafeUnwrap()).toBe(applyMarkup(BASE_1000));
  });
});
