import { describe, expect, it, vi } from 'vitest';
import { PolicyHooks, listTag, nanoUSD, optionalTag, textTag } from '@hushbox/shared';
import { usdToNanoUsd } from '../../billing/index.js';
import { ok } from '../../../lib/result/index.js';
import { fanIn } from '../builder/fan-in.js';
import { fanOut } from '../builder/fan-out.js';
import { modelCall } from '../builder/model-call.js';
import { subWorkflow } from '../builder/sub-workflow.js';
import { workflowInputs } from '../builder/workflow-inputs.js';
import { buildWorkflow } from '../builder/build-workflow.js';
import { InferenceError } from '../../models/index.js';
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
  TextTag,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { ModelProvider } from '../../models/index.js';
import type { TransformCompute } from '../../media/index.js';
import type { NodeRegistryContext } from '../compile/context.js';
import type { ModelBinding } from '../nodes/model-call-execution.js';
import type { EngineAdmissionDecision } from './hooks.js';

const RUN_KEY = 'run-key';
const HOOKS = PolicyHooks.parse({ admission: 'chat', settlement: 'chat' });

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
  limits: {},
  pricing: {},
  zdrReachable: true,
  releasedAt: 1_700_000_000,
  fetchedAt: 0,
};

const binding: ModelBinding = {
  descriptor,
  ports: { in: [textTag()], out: textTag() },
  price: () => ok(5n),
};

/** The authoritative inline provider cost each live branch reports (USD). */
const BRANCH_COST_USD = 0.000_001;

/**
 * Streams `echo:<input>` for every element except 'bad', which fails. Every
 * successful generation carries an inline provider cost and a per-generation id
 * so the real facts thread through to `SettlementRequest.charges`.
 */
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
          providerCostUsd: BRANCH_COST_USD,
          generationId: `gen-${text}`,
        },
      };
    })(),
};

/** Test-local compile node registry: a double for model + splitter ports. */
const nodes: NodeRegistryContext = {
  hasNode: (_type, version) => version === 1,
  resolveValuePorts: (node) => {
    if (node.type === 'subWorkflow') return { in: [textTag()], out: listTag(textTag()) };
    return { in: [textTag()], out: textTag() };
  },
};

const constraints = createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES);
const registries = { nodes, constraints };

/** fanOut a splitter's list over an optional modelCall, joining the successful subset. */
function multiModelDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const splitter = subWorkflow({
    id: 'splitter',
    ref: 'splitter',
    ins: [inputs.ports.prompt],
    produces: listTag(textTag()),
  });
  const spread = fanOut<TextTag, TextTag>({
    id: 'spread',
    over: splitter.out,
    maxWidth: 4,
    body: (element) =>
      modelCall({
        id: 'answer',
        model: 'answer-model',
        accepts: textTag(),
        in: element,
        produces: textTag(),
        optional: true,
        onError: 'skip',
      }),
  });
  const join = fanIn({
    id: 'join',
    reducer: 'joinOptionalTexts',
    accepts: [listTag(optionalTag(textTag()))] as const,
    ins: [spread.out],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [splitter, spread, join],
    registries,
  })._unsafeUnwrap().definition;
}

const compute = {
  execute: vi.fn(),
  resolvePorts: vi.fn(),
} as unknown as TransformCompute;

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

function startLive(elements: readonly string[]): {
  readonly done: ReturnType<ReturnType<typeof createWorkflowExecutor>['start']>['done'];
  readonly settlements: SettlementRequest[];
} {
  const settlements: SettlementRequest[] = [];
  const execution = createLiveExecutionRegistry({
    provider,
    models: { resolve: (id) => (id === 'answer-model' ? binding : undefined) },
    compute,
    subWorkflows: {
      resolve: (ref, version) =>
        ref === 'splitter' && version === 1
          ? {
              ports: { in: [textTag()], out: listTag(textTag()) },
              run: () => Promise.resolve(ok({ value: [...elements], costNanoUsd: 0n })),
            }
          : undefined,
    },
    schemas: { resolveSchema: (name) => constraints.resolve('schema', name)?.schema },
    predicates: predicateCode(DEFAULT_WORKFLOW_CAPABILITIES),
    reducers: reducerCode(DEFAULT_WORKFLOW_CAPABILITIES),
  });
  const executor = createWorkflowExecutor({
    registries,
    execution,
    estimateRun: () => ok(nanoUSD(100n)),
    clock: { now: () => 1000 },
    rng: { random: () => 0.5 },
    telemetry: makeTelemetry(),
  });
  const handle = executor.start({
    definition: multiModelDefinition(),
    inputs: { prompt: { kind: 'text', text: 'go' } },
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

describe('live workflow run — data-driven fanOut over live capability branches', () => {
  it('fans, reduces, and settles the successful subset when an optional branch fails', async () => {
    const run = startLive(['good', 'bad']);
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({ join: { kind: 'text', text: 'echo:good' } });
    // Only the surviving branch (element 0) is charged; the failed 'bad' branch
    // produced no content and is never billed. The real inline cost, model
    // facts, and generation id thread through from the live modelCall.
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'answer#0',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        generationId: 'gen-good',
        baseCostNanoUsd: usdToNanoUsd(BRANCH_COST_USD),
        isEstimated: false,
      },
    ]);
  });

  it('reduces every branch when all succeed', async () => {
    const run = startLive(['one', 'two']);
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'echo:one\necho:two' },
    });
    // One charge per branch, distinct keys, each carrying its real generation id.
    const charges = (run.settlements[0]?.charges ?? []).toSorted((a, b) =>
      a.key.localeCompare(b.key)
    );
    expect(charges).toEqual([
      {
        key: 'answer#0',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        generationId: 'gen-one',
        baseCostNanoUsd: usdToNanoUsd(BRANCH_COST_USD),
        isEstimated: false,
      },
      {
        key: 'answer#1',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        generationId: 'gen-two',
        baseCostNanoUsd: usdToNanoUsd(BRANCH_COST_USD),
        isEstimated: false,
      },
    ]);
  });
});
