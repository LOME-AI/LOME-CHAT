import { describe, expect, it, vi } from 'vitest';
import { END_NODE_ID, PolicyHooks, nanoUSD, textTag } from '@hushbox/shared';
import { createEstimateRun } from '../../models/index.js';
import { createServerTransformCompute } from '../../media/index.js';
import { providerUsdToBillableNanoUsd } from '../../billing/index.js';
import { InferenceError } from '../../models/index.js';
import {
  branch,
  buildWorkflow,
  createModelResolver,
  createNodeRegistry,
  modelCall,
  workflowInputs,
} from '../index.js';
import { createWorkflowExecutor } from './interpreter.js';
import { createLiveExecutionRegistry } from './live-execution-registry.js';
import {
  DEFAULT_WORKFLOW_CAPABILITIES,
  createConstraintRegistry,
  predicateCode,
  reducerCode,
} from './workflow-capabilities.js';
import type {
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  SettlementRequest,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { ModelPricingResolver, ModelProvider } from '../../models/index.js';
import type { EngineAdmissionDecision } from './hooks.js';
import type { SubWorkflowBinding } from './live-execution-registry.js';

/**
 * The production constructability proof: the flow engine wired ONLY from the
 * real production factories — the barrel builder, `createModelResolver`,
 * `createNodeRegistry`, `createLiveExecutionRegistry`, `createEstimateRun`, the
 * server transform compute, and `createWorkflowExecutor`. Only the external
 * inference provider and the admission/settlement policy hooks (the chat
 * slice's own work) are stubbed. A single-modelCall text turn constructs,
 * runs, produces a value, and yields a per-generation base-cost charge — so a
 * later composer inherits a proven-constructable production layer, not a stub.
 */

const RUN_KEY = 'run-key';
const HOOKS = PolicyHooks.parse({ admission: 'chat', settlement: 'chat' });

/** The authoritative inline provider cost the fake reports (USD). */
const GENERATION_COST_USD = 0.000_001;

/** Empty sub-workflow catalog: the single-modelCall turn never resolves one. */
function noSubWorkflow(): SubWorkflowBinding | undefined {
  return undefined;
}

function makeTelemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    emitMetric: vi.fn(),
    captureError: vi.fn(),
  };
}

const descriptor: ModelDescriptor = {
  id: 'answer-model',
  provider: 'p',
  version: '1',
  inputs: ['text'],
  outputs: ['text'],
  parameters: {},
  behaviors: [],
  // contextLength + token rates so the real estimateRun can price admission.
  limits: { contextLength: 1000 },
  pricing: { inputPerToken: nanoUSD(2n), outputPerToken: nanoUSD(3n) },
  zdrReachable: true,
  releasedAt: 1_700_000_000,
  fetchedAt: 0,
};

/** A small fixture catalog: the exposed-model snapshot the real resolvers read. */
const pricingResolver: ModelPricingResolver = (id) =>
  id === 'answer-model' ? descriptor : undefined;

/** Streams `echo:<input>` and a terminal finish carrying inline cost + id. */
const provider: ModelProvider = {
  infer: (request: InferenceRequest) =>
    (async function* stream(): AsyncGenerator<InferenceEvent> {
      await Promise.resolve();
      const part = request.inputs[0];
      const text = part?.modality === 'text' ? part.text : '';
      if (text === 'bad') throw new InferenceError('upstream_error', 'model unavailable');
      yield { kind: 'text-delta', index: 0, content: `echo:${text}` };
      yield {
        kind: 'finish',
        metadata: {
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: 'stop',
          providerCostUsd: GENERATION_COST_USD,
          generationId: `gen-${text}`,
        },
      };
    })(),
};

function grant(limit: bigint): EngineAdmissionDecision {
  return {
    admitted: true,
    holdRef: 'hold',
    circuit: {
      estimateNanoUsd: limit,
      costCircuitMultiplier: 5n,
      costCircuitLimitNanoUsd: limit,
    },
  };
}

/** The persisting-turn stamp: without it the estimator holds no storage at all. */
const STORAGE_STAMP = { inputChars: 0, tier: 'free' } as const;

/**
 * A turn whose one model call is read by a `branch` and by nothing else. The
 * branch carries no embedded input ref, so the edge is the only record of the
 * consumption — the shape a definition-side walk over node refs cannot see.
 */
function branchFedTurn(): WorkflowDefinition {
  const models = createModelResolver(pricingResolver);
  const compute = createServerTransformCompute();
  const registries = {
    nodes: createNodeRegistry({ models, compute }),
    constraints: createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES),
  };
  const inputs = workflowInputs({ prompt: textTag() });
  const answer = modelCall({
    id: 'answer',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const route = branch({
    id: 'route',
    predicate: 'routeByFirstWord',
    accepts: textTag(),
    in: answer.out,
    cases: {},
    else: END_NODE_ID,
  });
  const built = buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [answer, route],
    registries,
  })._unsafeUnwrap();
  return { ...built.definition, storage: STORAGE_STAMP };
}

function singleModelTurn(): WorkflowDefinition {
  const models = createModelResolver(pricingResolver);
  const compute = createServerTransformCompute();
  const registries = {
    nodes: createNodeRegistry({ models, compute }),
    constraints: createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES),
  };
  const inputs = workflowInputs({ prompt: textTag() });
  const answer = modelCall({
    id: 'answer',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [answer],
    registries,
  })._unsafeUnwrap().definition;
}

function runTurn(
  definition: WorkflowDefinition,
  prompt: string
): {
  readonly done: Promise<{ readonly outcome: string }>;
  readonly settlements: SettlementRequest[];
} {
  // Every registry and resolver below is the real production factory.
  const models = createModelResolver(pricingResolver);
  const compute = createServerTransformCompute();
  const nodes = createNodeRegistry({ models, compute });
  const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
  const registries = { nodes, constraints };

  const execution = createLiveExecutionRegistry({
    provider,
    models,
    compute,
    subWorkflows: { resolve: noSubWorkflow },
    schemas: { resolveSchema: (name) => constraints.resolve('schema', name)?.schema },
    predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
    reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
  });

  const executor = createWorkflowExecutor({
    registries,
    execution,
    estimateRun: createEstimateRun(pricingResolver),
    clock: { now: () => 1000 },
    rng: { random: () => 0.5 },
    telemetry: makeTelemetry(),
  });

  const settlements: SettlementRequest[] = [];
  const handle = executor.start({
    definition,
    inputs: { prompt: { kind: 'text', text: prompt } },
    hooks: {
      admission: () => Promise.resolve(grant(1_000_000n)),
      settlement: (request) => {
        settlements.push(request);
        return Promise.resolve();
      },
    },
    runKey: RUN_KEY,
    emit: () => {},
  });
  return { done: handle.done, settlements };
}

describe('workflow executor constructed from production factories', () => {
  it('runs a single-modelCall text turn to a value and a base-cost charge', async () => {
    const run = runTurn(singleModelTurn(), 'hello');
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({ answer: { kind: 'text', text: 'echo:hello' } });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'answer',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        generationId: 'gen-hello',
        billableCostNanoUsd: providerUsdToBillableNanoUsd(GENERATION_COST_USD),
        isEstimated: false,
        tokens: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cachedInputTokens: 0 },
      },
    ]);
  });

  /**
   * The reserve and the persisted set are one value. The estimator and the
   * engine are handed the SAME definition here, and the only thing that decides
   * both answers is the consumed set compile derived from it — so a reserve
   * covering a value the run cannot persist, or a persisted value nothing
   * reserved, would have to disagree with itself.
   */
  it('holds no output storage for the value its own run does not persist', async () => {
    const definition = branchFedTurn();

    const run = runTurn(definition, 'hello');
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    // Nothing rests: the branch reads the answer, and a branch is never a sink.
    expect(run.settlements[0]?.outputs).toEqual({});

    const reserved = createEstimateRun(pricingResolver)(definition)._unsafeUnwrap();
    const unread = createEstimateRun(pricingResolver)({
      ...definition,
      nodes: definition.nodes.filter((node) => node.type !== 'branch'),
      edges: definition.edges.filter((edge) => edge.to.node !== 'route'),
    })._unsafeUnwrap();

    // Exact, not generous — and exact still covers a bill of nothing. Dropping
    // the branch makes the answer a sink again, and the reserve grows by the
    // storage that persisting it would cost.
    expect(reserved).toBeLessThan(unread);
    expect(run.settlements[0]?.charges.length).toBe(1);
  });
});
