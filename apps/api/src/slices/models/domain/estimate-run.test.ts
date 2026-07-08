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
