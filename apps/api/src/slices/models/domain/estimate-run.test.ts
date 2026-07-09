import { describe, expect, it } from 'vitest';
import { WorkflowDefinition, nanoUSD } from '@hushbox/shared';
import { applyMarkup } from '../../billing/index.js';
import { createEstimateRun } from './estimate-run.js';
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
  candidateIds: readonly string[]
): unknown {
  return {
    id,
    version: 1,
    out: 'out',
    type: 'smartModel',
    classifierModelId,
    candidates: candidateIds.map((candidateId) => ({ id: candidateId })),
    in: { node: 'input', port: 'prompt' },
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
