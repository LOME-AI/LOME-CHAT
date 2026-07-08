import { describe, expect, it, vi } from 'vitest';
import { Node as NodeSchema, textTag } from '@hushbox/shared';
import { ok } from '../../../lib/result/index.js';
import { createValueStore } from './value-store.js';
import { createLiveExecutionRegistry } from './live-execution-registry.js';
import type { InferenceEvent, ModelDescriptor, Node } from '@hushbox/shared';
import type { ModelProvider } from '../../models/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { NodeRunContext } from './execution-registry.js';
import type { ModelBinding } from '../nodes/model-call-execution.js';
import type { SubWorkflowBinding } from './live-execution-registry.js';
import type { RegisteredPredicate, RegisteredReducer } from './execution-registry.js';

const descriptor: ModelDescriptor = {
  id: 'answer-model',
  provider: 'p',
  version: '1',
  inputs: ['text'],
  outputs: ['text'],
  parameters: {},
  behaviors: [],
  limits: {},
  pricing: {},
  zdrReachable: true,
  releasedAt: 1_700_000_000,
  fetchedAt: 0,
};

const binding: ModelBinding = {
  descriptor,
  ports: { in: [textTag()], out: textTag() },
  price: () => ok(1n),
};

const provider: ModelProvider = {
  infer: () =>
    (async function* stream(): AsyncGenerator<InferenceEvent> {
      await Promise.resolve();
      yield { kind: 'text-delta', index: 0, content: 'ok' };
    })(),
};

function modelCallNode(version = 1): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'm',
    type: 'modelCall',
    version,
    out: 'out',
    model: 'answer-model',
    params: {},
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

function transformNode(): Extract<Node, { type: 'transform' }> {
  return NodeSchema.parse({
    id: 't',
    type: 'transform',
    version: 1,
    out: 'out',
    transform: 'echo',
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'transform' }>;
}

function subWorkflowNode(): Extract<Node, { type: 'subWorkflow' }> {
  return NodeSchema.parse({
    id: 's',
    type: 'subWorkflow',
    version: 1,
    out: 'out',
    ref: 'sum',
  }) as Extract<Node, { type: 'subWorkflow' }>;
}

interface Overrides {
  readonly models?: (id: string) => ModelBinding | undefined;
  readonly resolvePorts?: TransformCompute['resolvePorts'];
  readonly subWorkflows?: (ref: string, version: number) => SubWorkflowBinding | undefined;
  readonly predicates?: ReadonlyMap<string, RegisteredPredicate>;
  readonly reducers?: ReadonlyMap<string, RegisteredReducer>;
  readonly telemetry?: Telemetry;
}

function registry(overrides: Overrides = {}): ReturnType<typeof createLiveExecutionRegistry> {
  const compute = {
    execute: vi.fn(),
    resolvePorts: overrides.resolvePorts ?? vi.fn(),
  } as unknown as TransformCompute;
  return createLiveExecutionRegistry({
    provider,
    models: {
      resolve: overrides.models ?? ((id) => (id === 'answer-model' ? binding : undefined)),
    },
    compute,
    subWorkflows: { resolve: overrides.subWorkflows ?? vi.fn() },
    schemas: { resolveSchema: vi.fn() },
    predicates: overrides.predicates ?? new Map(),
    reducers: overrides.reducers ?? new Map(),
    ...(overrides.telemetry === undefined ? {} : { telemetry: overrides.telemetry }),
  });
}

function fakeTelemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    emitMetric: vi.fn(),
    captureError: vi.fn(),
  };
}

function makeCtx(): NodeRunContext {
  return {
    values: createValueStore(1_000_000),
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
  };
}

describe('createLiveExecutionRegistry', () => {
  it('resolves a streaming modelCall execution for a known model at the impl version', () => {
    const exec = registry().resolveExecution(modelCallNode());
    expect(exec?.streaming).toBe(true);
  });

  it('threads an injected telemetry into the modelCall execution for the missing-cost alert', async () => {
    // The provider stream carries no terminal finish (no inline provider cost),
    // so a text modelCall lands on the pathological missing-cost path and must
    // fire the alert through the telemetry the registry injected.
    const telemetry = fakeTelemetry();
    const exec = registry({ telemetry }).resolveExecution(modelCallNode());
    const result = await exec?.run(modelCallNode(), ['hi'], makeCtx());
    expect(result?.isOk()).toBe(true);
    expect(telemetry.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'inference_provider_cost_unavailable'
    );
  });

  it('returns undefined for an unknown model', () => {
    expect(registry({ models: vi.fn() }).resolveExecution(modelCallNode())).toBeUndefined();
  });

  it('returns undefined for a modelCall at an unregistered impl version', () => {
    expect(registry().resolveExecution(modelCallNode(2))).toBeUndefined();
  });

  it('resolves a transform execution when the compute registry declares ports', () => {
    const exec = registry({
      resolvePorts: () => ({ in: [textTag()], out: textTag() }),
    }).resolveExecution(transformNode());
    expect(exec?.streaming).toBe(false);
  });

  it('returns undefined for a transform the compute registry does not know', () => {
    expect(registry().resolveExecution(transformNode())).toBeUndefined();
  });

  it('resolves a subWorkflow execution through the sub-workflow resolver', () => {
    const exec = registry({
      subWorkflows: () => ({ ports: { in: [textTag()], out: textTag() }, run: vi.fn() }),
    }).resolveExecution(subWorkflowNode());
    expect(exec?.streaming).toBe(false);
  });

  it('returns undefined for an unregistered sub-workflow ref', () => {
    expect(registry().resolveExecution(subWorkflowNode())).toBeUndefined();
  });

  it('resolves registered predicate and reducer code', () => {
    const reg = registry({
      predicates: new Map([['p', () => true]]),
      reducers: new Map([['r', () => 'merged']]),
    });
    expect(reg.resolvePredicate('p')?.('x')).toBe(true);
    expect(reg.resolveReducer('r')?.([])).toBe('merged');
    expect(reg.resolvePredicate('missing')).toBeUndefined();
  });
});
