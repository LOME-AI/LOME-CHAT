import { describe, expect, it, vi } from 'vitest';
import {
  END_NODE_ID,
  ERROR_CODES,
  jsonTag,
  listTag,
  nanoUSD,
  optionalTag,
  PolicyHooks,
  textTag,
} from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import {
  CLASSIFICATION_SCHEMA_NAME as CLASSIFICATION,
  makeFakeConstraints,
  makeFakeNodeRegistry,
} from '../compile/registry-fakes.js';
import { buildWorkflow } from '../builder/build-workflow.js';
import { branch } from '../builder/branch.js';
import { fanIn } from '../builder/fan-in.js';
import { fanOut } from '../builder/fan-out.js';
import { loop } from '../builder/loop.js';
import { modelCall } from '../builder/model-call.js';
import { subWorkflow } from '../builder/sub-workflow.js';
import { transform } from '../builder/transform.js';
import { workflowInputs } from '../builder/workflow-inputs.js';
import {
  failWith,
  hangThenFail,
  makeFakeExecutionRegistry,
  respondWith,
  streamThenHang,
  streamingEcho,
} from './execution-fakes.js';
import { createWorkflowExecutor } from './interpreter.js';
import type {
  AdmissionRequest,
  FlowInputs,
  FlowRunOutcome,
  FlowStreamEvent,
  NanoUSD,
  SettlementRequest,
  TextTag,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { BuildRegistries } from '../builder/build-workflow.js';
import type { FakeExecutionOptions } from './execution-fakes.js';
import type { EngineAdmissionDecision } from './hooks.js';

const HOOKS = PolicyHooks.parse({ admission: 'chatAdmission', settlement: 'chatSettlement' });

const RUN_KEY = 'key-row-1';

function registries(): BuildRegistries {
  return { nodes: makeFakeNodeRegistry(), constraints: makeFakeConstraints() };
}

function textInput(text: string): FlowInputs[string] {
  return { kind: 'text', text };
}

function grantWithLimit(limitNanoUsd: bigint): EngineAdmissionDecision {
  return {
    admitted: true,
    holdRef: 'hold-1',
    circuit: {
      estimateNanoUsd: limitNanoUsd / 5n,
      costCircuitMultiplier: 5n,
      costCircuitLimitNanoUsd: limitNanoUsd,
    },
  };
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

interface HarnessOptions extends FakeExecutionOptions {
  readonly definition: WorkflowDefinition;
  readonly inputs?: FlowInputs;
  readonly decision?: EngineAdmissionDecision | Promise<never>;
  readonly settle?: (request: SettlementRequest) => Promise<void>;
  readonly estimate?: NanoUSD;
  readonly estimateFails?: boolean;
  readonly valueBudgetBytes?: number;
  readonly startAtMs?: number;
}

interface Harness {
  readonly done: Promise<FlowRunOutcome>;
  readonly stop: (reason: 'user-stop' | 'deadline') => void;
  readonly emitted: FlowStreamEvent[];
  readonly settlements: SettlementRequest[];
  readonly admissionRequests: AdmissionRequest[];
  readonly telemetry: Telemetry;
  readonly clockState: { now: number };
}

function startRun(options: HarnessOptions): Harness {
  const emitted: FlowStreamEvent[] = [];
  const settlements: SettlementRequest[] = [];
  const admissionRequests: AdmissionRequest[] = [];
  const telemetry = makeTelemetry();
  const clockState = { now: options.startAtMs ?? 1000 };
  const decision = options.decision ?? grantWithLimit(1_000_000n);
  const estimate = options.estimate ?? nanoUSD(100n);
  const executor = createWorkflowExecutor({
    registries: registries(),
    execution: makeFakeExecutionRegistry({
      behaviors: options.behaviors,
      ...(options.predicates === undefined ? {} : { predicates: options.predicates }),
      ...(options.reducers === undefined ? {} : { reducers: options.reducers }),
    }),
    estimateRun: () =>
      options.estimateFails === true ? err(validationError('no pricing')) : ok(estimate),
    clock: { now: () => clockState.now },
    rng: { random: () => 0.5 },
    telemetry,
    ...(options.valueBudgetBytes === undefined
      ? {}
      : { valueBudgetBytes: options.valueBudgetBytes }),
  });
  const handle = executor.start({
    definition: options.definition,
    inputs: options.inputs ?? { prompt: textInput('hi') },
    hooks: {
      admission: (request) => {
        admissionRequests.push(request);
        return Promise.resolve(decision);
      },
      settlement:
        options.settle ??
        ((request): Promise<void> => {
          settlements.push(request);
          return Promise.resolve();
        }),
    },
    runKey: RUN_KEY,
    emit: (event) => {
      emitted.push(event);
    },
  });
  return {
    done: handle.done,
    stop: (reason) => {
      handle.stop(reason);
    },
    emitted,
    settlements,
    admissionRequests,
    telemetry,
    clockState,
  };
}

/** A single streaming modelCall over the prompt — the one-node chat shape. */
function answerDefinition(): WorkflowDefinition {
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
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A single sink modelCall whose node id is a reserved prototype name. */
function protoSinkDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const answer = modelCall({
    id: '__proto__',
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
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A one-node chat whose sole workflow input port is a reserved prototype name. */
function protoInputPortDefinition(): WorkflowDefinition {
  // Reference the port through a variable key: dot access would read the
  // prototype accessor, and a string-literal subscript trips dot-notation lint.
  const reservedPort = '__proto__';
  const inputs = workflowInputs({ [reservedPort]: textTag() });
  const answer = modelCall({
    id: 'answer',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports[reservedPort],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [answer],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** classify → branch → answer, with distinct case and else targets. */
function smartDefinition(elseTarget?: 'end'): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
    optional: true,
    onError: 'skip',
  });
  const answerSimple = modelCall({
    id: 'answerSimple',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const answerHard = modelCall({
    id: 'answerHard',
    model: 'hard-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const route = branch({
    id: 'route',
    predicate: 'routeByLabel',
    accepts: optionalTag(jsonTag(CLASSIFICATION)),
    in: classify.out,
    cases: { simple: answerSimple, hard: answerHard },
    else: elseTarget === 'end' ? END_NODE_ID : answerHard,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, route, answerSimple, answerHard],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** Three chained modelCalls — boundary instrumentation for the circuit. */
function chainDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const first = modelCall({
    id: 'first',
    model: 'first-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const second = modelCall({
    id: 'second',
    model: 'second-model',
    accepts: textTag(),
    in: first.out,
    produces: textTag(),
  });
  const third = modelCall({
    id: 'third',
    model: 'third-model',
    accepts: textTag(),
    in: second.out,
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [first, second, third],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A branch that routes every taken path to an untaken one's consumers. */
function deadKindsDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
  });
  const mid = modelCall({
    id: 'mid',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const other = modelCall({
    id: 'other',
    model: 'hard-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const classifyAlt = modelCall({
    id: 'classifyAlt',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
  });
  const route = branch({
    id: 'route',
    predicate: 'routeByLabel',
    accepts: optionalTag(jsonTag(CLASSIFICATION)),
    in: classify.out,
    cases: { simple: mid, alt: classifyAlt },
    else: other,
  });
  const deadBranch = branch({
    id: 'deadBranch',
    predicate: 'textDone',
    accepts: textTag(),
    in: mid.out,
    cases: {},
    else: END_NODE_ID,
  });
  const deadJoin = fanIn({
    id: 'deadJoin',
    reducer: 'pairJoin',
    accepts: [textTag(), textTag()] as const,
    ins: [mid.out, mid.out],
    produces: textTag(),
  });
  const deadSplit = transform({
    id: 'deadSplit',
    transform: 'split',
    accepts: textTag(),
    in: mid.out,
    produces: listTag(textTag()),
  });
  const deadFan = fanOut<TextTag, TextTag>({
    id: 'deadFan',
    over: deadSplit.out,
    maxWidth: 2,
    body: (element) =>
      modelCall({
        id: 'deadDescribe',
        model: 'answer-model',
        accepts: textTag(),
        in: element,
        produces: textTag(),
      }),
  });
  const deadLoop = loop({
    id: 'deadLoop',
    until: 'textDone',
    maxIterations: 2,
    initial: mid.out,
    body: (state) =>
      transform({
        id: 'deadExtend',
        transform: 'echo',
        accepts: textTag(),
        in: state,
        produces: textTag(),
      }),
  });
  const lateRoute = branch({
    id: 'lateRoute',
    predicate: 'routeByLabel',
    accepts: optionalTag(jsonTag(CLASSIFICATION)),
    in: classifyAlt.out,
    cases: {},
    else: other,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [
      classify,
      route,
      mid,
      other,
      classifyAlt,
      deadBranch,
      deadJoin,
      deadSplit,
      deadFan,
      deadLoop,
      lateRoute,
    ],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A fanOut whose body branch always routes to the end sentinel. */
function fanOutEndDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const split = transform({
    id: 'split',
    transform: 'split',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: listTag(textTag()),
  });
  const spread = fanOut<TextTag, TextTag>({
    id: 'spread',
    over: split.out,
    maxWidth: 4,
    body: (element) =>
      branch({
        id: 'gate',
        predicate: 'textDone',
        accepts: textTag(),
        in: element,
        cases: {},
        else: END_NODE_ID,
      }),
  });
  const join = fanIn({
    id: 'join',
    reducer: 'captionsWithPrompt',
    accepts: [listTag(optionalTag(textTag())), textTag()] as const,
    ins: [spread.out, inputs.ports.prompt],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [split, spread, join],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** split → fanOut(streaming body) → fanIn(captionsWithPrompt). */
function fanOutDefinition(maxWidth: number, bodyOnError?: 'fail'): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const split = transform({
    id: 'split',
    transform: 'split',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: listTag(textTag()),
  });
  const spread = fanOut<TextTag, TextTag>({
    id: 'spread',
    over: split.out,
    maxWidth,
    body: (element) =>
      modelCall({
        id: 'describe',
        model: 'answer-model',
        accepts: textTag(),
        in: element,
        produces: textTag(),
        ...(bodyOnError === 'fail'
          ? { onError: 'fail' as const }
          : { optional: true, onError: 'skip' as const }),
      }),
  });
  const join = fanIn({
    id: 'join',
    reducer: 'captionsWithPrompt',
    accepts: [listTag(optionalTag(textTag())), textTag()] as const,
    ins: [spread.out, inputs.ports.prompt],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [split, spread, join],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** An independent streaming sink beside a fanOut — coincident stop+circuit. */
function sinkBesideFanDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const side = modelCall({
    id: 'side',
    model: 'first-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const split = transform({
    id: 'split',
    transform: 'split',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: listTag(textTag()),
  });
  const spread = fanOut<TextTag, TextTag>({
    id: 'spread',
    over: split.out,
    maxWidth: 4,
    body: (element) =>
      modelCall({
        id: 'describe',
        model: 'second-model',
        accepts: textTag(),
        in: element,
        produces: textTag(),
        onError: 'fail',
      }),
  });
  const join = fanIn({
    id: 'join',
    reducer: 'captionsWithPrompt',
    accepts: [listTag(optionalTag(textTag())), textTag()] as const,
    ins: [spread.out, inputs.ports.prompt],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [side, split, spread, join],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

function loopDefinition(maxIterations: number, bodyOnError?: 'skip'): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const refine = loop({
    id: 'refine',
    until: 'textDone',
    maxIterations,
    initial: inputs.ports.prompt,
    body: (state) =>
      transform({
        id: 'extend',
        transform: 'echo',
        accepts: textTag(),
        in: state,
        produces: textTag(),
        ...(bodyOnError === undefined ? {} : { onError: bodyOnError }),
      }),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [refine],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

function subWorkflowDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag(), extra: textTag() });
  const summarize = subWorkflow({
    id: 'summarize',
    ref: 'summarize',
    ins: [inputs.ports.prompt, inputs.ports.extra],
    produces: textTag(),
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [summarize],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** classify → branch over two answers, with a transform chained off one. */
function deadPathDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const classify = modelCall({
    id: 'classify',
    model: 'classifier-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: jsonTag(CLASSIFICATION),
  });
  const mid = modelCall({
    id: 'mid',
    model: 'answer-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const tail = transform({
    id: 'tail',
    transform: 'echo',
    accepts: textTag(),
    in: mid.out,
    produces: textTag(),
  });
  const other = modelCall({
    id: 'other',
    model: 'hard-model',
    accepts: textTag(),
    in: inputs.ports.prompt,
    produces: textTag(),
  });
  const route = branch({
    id: 'route',
    predicate: 'labelDone',
    accepts: jsonTag(CLASSIFICATION),
    in: classify.out,
    cases: { simple: mid, hard: other },
    else: other,
  });
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: [classify, route, mid, tail, other],
    registries: registries(),
  })._unsafeUnwrap().definition;
}

const ROUTE_PREDICATES = {
  routeByLabel: (input: unknown): string =>
    (input as { label?: string } | undefined)?.label ?? 'fallback',
};

describe('createWorkflowExecutor — the streaming chat turn', () => {
  it('streams the terminal node through the run emit seam', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.emitted.length).toBeGreaterThan(1);
    expect(new Set(run.emitted.map((event) => event.streamId)).size).toBe(1);
    expect(run.emitted.map((event) => event.cursor)).toEqual(run.emitted.map((_, index) => index));
    expect(run.emitted[0]?.event).toEqual({ kind: 'text-delta', index: 0, content: 'e' });
  });

  it('settles the terminal output under the producing node id', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
    });
    await run.done;
    expect(run.settlements).toEqual([
      { runKey: RUN_KEY, outputs: { answer: { kind: 'text', text: 'echo:hi' } } },
    ]);
  });

  it('reports the run id as the idempotency run key', () => {
    const executor = createWorkflowExecutor({
      registries: registries(),
      execution: makeFakeExecutionRegistry({
        behaviors: { 'answer-model': streamingEcho() },
      }),
      estimateRun: () => ok(nanoUSD(1n)),
      clock: { now: () => 0 },
      rng: { random: () => 0.5 },
      telemetry: makeTelemetry(),
    });
    const handle = executor.start({
      definition: answerDefinition(),
      inputs: { prompt: textInput('hi') },
      hooks: {
        admission: () => Promise.resolve(grantWithLimit(10n)),
        settlement: () => Promise.resolve(),
      },
      runKey: RUN_KEY,
      emit: () => {},
    });
    expect(handle.runId).toBe(RUN_KEY);
    return handle.done;
  });
});

describe('createWorkflowExecutor — classify→branch→answer', () => {
  it('routes to the labeled case and skips the other target', async () => {
    const hard = vi.fn();
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': {
          run: (input, ctx) => {
            hard();
            return streamingEcho().run(input, ctx);
          },
        },
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(hard).not.toHaveBeenCalled();
    expect(run.settlements[0]?.outputs).toEqual({
      answerSimple: { kind: 'text', text: 'echo:hi' },
    });
  });

  it('falls back to the else route when the optional classifier fails', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': failWith(),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      answerHard: { kind: 'text', text: 'hard answer' },
    });
  });

  it('exits early when the branch routes to the end sentinel', async () => {
    const run = startRun({
      definition: smartDefinition('end'),
      behaviors: {
        'classifier-model': respondWith({ label: 'other' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements).toEqual([{ runKey: RUN_KEY, outputs: {} }]);
  });

  it('skips a node whose required feed comes from an untaken branch path', async () => {
    const run = startRun({
      definition: deadPathDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'hard' }),
        'answer-model': streamingEcho(),
        echo: respondWith('never'),
        'hard-model': respondWith('hard answer'),
      },
      predicates: { labelDone: (input) => (input as { label: string }).label },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      other: { kind: 'text', text: 'hard answer' },
    });
  });

  it('terminal-fails when a required node fails', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': failWith(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.settlements).toEqual([]);
  });
});

describe('createWorkflowExecutor — branch verdict prototype safety', () => {
  it.each(['constructor', '__proto__', 'hasOwnProperty'])(
    'routes a %s verdict to the else target instead of dead-pathing',
    async (reserved) => {
      const run = startRun({
        definition: smartDefinition(),
        behaviors: {
          'classifier-model': respondWith({ label: 'x' }),
          'answer-model': streamingEcho(),
          'hard-model': respondWith('hard answer'),
        },
        predicates: { routeByLabel: () => reserved },
      });
      await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
      expect(run.settlements[0]?.outputs).toEqual({
        answerHard: { kind: 'text', text: 'hard answer' },
      });
    }
  );
});

describe('createWorkflowExecutor — ingress prototype safety', () => {
  it('processes an input whose port name is a reserved prototype name', async () => {
    const run = startRun({
      definition: protoInputPortDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: { ['__proto__']: textInput('hi') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      answer: { kind: 'text', text: 'echo:hi' },
    });
  });

  it('rejects a run missing a required input whose port name is a reserved prototype name', async () => {
    const run = startRun({
      definition: protoInputPortDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {},
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });
});

describe('createWorkflowExecutor — settlement output prototype safety', () => {
  it('settles the output of a sink node whose id is a reserved prototype name', async () => {
    const run = startRun({
      definition: protoSinkDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      ['__proto__']: { kind: 'text', text: 'echo:hi' },
    });
  });
});

describe('createWorkflowExecutor — admission', () => {
  it('hands the admission hook the server-computed estimate', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      estimate: nanoUSD(4200n),
    });
    await run.done;
    expect(run.admissionRequests).toHaveLength(1);
    expect(run.admissionRequests[0]?.estimate).toBe(4200n);
  });

  it('fails without executing anything when admission refuses', async () => {
    const executed = vi.fn();
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: (input, ctx) => {
            executed();
            return streamingEcho().run(input, ctx);
          },
        },
      },
      decision: { admitted: false, code: ERROR_CODES.INSUFFICIENT_ADMISSION },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(executed).not.toHaveBeenCalled();
    expect(run.settlements).toEqual([]);
  });

  it('treats a grant without a circuit readout as a defect', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      decision: { admitted: true, holdRef: 'hold-1' } as EngineAdmissionDecision,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('fails validation when the estimator cannot price the definition', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      estimateFails: true,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });
});

describe('createWorkflowExecutor — the cost circuit', () => {
  it('trips at the next node boundary after accrual crosses hold times K', async () => {
    const third = vi.fn();
    const run = startRun({
      definition: chainDefinition(),
      behaviors: {
        'first-model': respondWith('a', 200n),
        'second-model': respondWith('b', 400n),
        'third-model': {
          run: (input, ctx) => {
            third();
            return respondWith('c').run(input, ctx);
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(third).not.toHaveBeenCalled();
    expect(run.settlements).toEqual([]);
  });

  it('trips at the final boundary when the last node crosses the limit', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho(600n) },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(run.settlements).toEqual([]);
  });

  it('accrues spend reported by failing optional nodes', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': failWith(600n),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
  });
});

describe('createWorkflowExecutor — deadline and stop', () => {
  it('settles the streamed partial when the deadline stops the run', async () => {
    const behavior = streamThenHang('partial answer', 7n);
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.hanging;
    run.stop('deadline');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([
      { runKey: RUN_KEY, outputs: { answer: { kind: 'text', text: 'partial answer' } } },
    ]);
  });

  it('settles nothing when the deadline fires before any output exists', async () => {
    const behavior = hangThenFail();
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.hanging;
    run.stop('deadline');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([]);
  });

  it('settles the streamed partial on an explicit user stop', async () => {
    const behavior = streamThenHang('partial answer');
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.hanging;
    run.stop('user-stop');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toHaveLength(1);
  });

  it('stops at a node boundary once the injected clock passes the deadline', async () => {
    const run = startRun({
      definition: chainDefinition(),
      behaviors: {
        'first-model': {
          run: (input, ctx) => {
            run.clockState.now += 6 * 60 * 1000;
            return respondWith('a').run(input, ctx);
          },
        },
        'second-model': respondWith('b'),
        'third-model': respondWith('c'),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([]);
  });
});

describe('createWorkflowExecutor — the byte budget', () => {
  it('rejects over-budget inputs at validation before admission', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: { prompt: textInput('x'.repeat(64)) },
      valueBudgetBytes: 32,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
    expect(run.settlements).toEqual([]);
  });

  it('terminal-fails cleanly when a node output breaches the budget mid-run', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': respondWith('y'.repeat(64)) },
      valueBudgetBytes: 32,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
  });
});

describe('createWorkflowExecutor — fanOut / fanIn', () => {
  it('fans branches out with one stream each and reduces the collected list', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(),
      },
      reducers: {
        captionsWithPrompt: (inputs) => {
          const [captions, prompt] = inputs as [readonly (string | undefined)[], string];
          return [...captions.map((caption) => caption ?? '∅'), prompt].join('|');
        },
      },
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const streamIds = new Set(run.emitted.map((event) => event.streamId));
    expect(streamIds.size).toBe(2);
    for (const streamId of streamIds) {
      const cursors = run.emitted
        .filter((event) => event.streamId === streamId)
        .map((event) => event.cursor);
      expect(cursors).toEqual(cursors.map((_, index) => index));
    }
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'echo:one|echo:two|one two' },
    });
  });

  it('reduces skipped optional branches as absent elements', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': {
          run: (input, ctx) =>
            input[0] === 'bad' ? failWith().run(input, ctx) : streamingEcho().run(input, ctx),
        },
      },
      reducers: {
        captionsWithPrompt: (inputs) => {
          const [captions, prompt] = inputs as [readonly (string | undefined)[], string];
          return [...captions.map((caption) => caption ?? '∅'), prompt].join('|');
        },
      },
      inputs: { prompt: textInput('one bad') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'echo:one|∅|one bad' },
    });
  });

  it('fails the run when a fail-on-error branch body fails', async () => {
    const run = startRun({
      definition: fanOutDefinition(4, 'fail'),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': {
          run: (input, ctx) =>
            input[0] === 'bad' ? failWith().run(input, ctx) : streamingEcho().run(input, ctx),
        },
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      inputs: { prompt: textInput('one bad') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.settlements).toEqual([]);
  });

  it('trips the circuit when branch spend crosses the limit', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(300n),
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(run.settlements).toEqual([]);
  });

  it('stops without settling when a stop lands mid-fan-out', async () => {
    const behavior = streamThenHang('partial');
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': behavior,
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      inputs: { prompt: textInput('one two') },
    });
    await behavior.hanging;
    run.stop('user-stop');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([]);
  });

  it('settles the partial and stops when a stop coincides with a fan-out circuit trip', async () => {
    const behavior = streamThenHang('partial', 400n);
    const run = startRun({
      definition: sinkBesideFanDefinition(),
      behaviors: {
        'first-model': streamingEcho(),
        split: respondWith(['a', 'b']),
        'second-model': behavior,
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('hi') },
    });
    await behavior.hanging;
    run.stop('user-stop');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    expect(run.settlements).toEqual([
      { runKey: RUN_KEY, outputs: { side: { kind: 'text', text: 'echo:hi' } } },
    ]);
  });

  it('surfaces the circuit code when a branch failure and a circuit trip coincide', async () => {
    const run = startRun({
      definition: fanOutDefinition(4, 'fail'),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': {
          run: (input, ctx) =>
            input[0] === 'bad'
              ? failWith(300n).run(input, ctx)
              : respondWith('ok', 300n).run(input, ctx),
        },
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('one bad') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(run.settlements).toEqual([]);
  });

  it('ends a fan branch locally when its body routes to the end sentinel', async () => {
    const run = startRun({
      definition: fanOutEndDefinition(),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
      },
      predicates: { textDone: () => 'through' },
      reducers: {
        captionsWithPrompt: (inputs) => {
          const [elements, prompt] = inputs as [readonly string[], string];
          return [...elements, prompt].join('|');
        },
      },
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'one|two|one two' },
    });
  });

  it('fails the run when the collection exceeds the declared width', async () => {
    const run = startRun({
      definition: fanOutDefinition(2),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(),
      },
      reducers: { captionsWithPrompt: (inputs) => String(inputs[1]) },
      inputs: { prompt: textInput('a b c') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.settlements).toEqual([]);
  });
});

describe('createWorkflowExecutor — untaken branch paths', () => {
  it('skips every structural node kind fed from an untaken path', async () => {
    const run = startRun({
      definition: deadKindsDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'hard' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
        echo: respondWith('never'),
        split: respondWith(['never']),
      },
      predicates: {
        ...ROUTE_PREDICATES,
        textDone: () => true,
      },
      reducers: { pairJoin: (inputs) => `${String(inputs[0])} ${String(inputs[1])}` },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      other: { kind: 'text', text: 'hard answer' },
    });
  });
});

describe('createWorkflowExecutor — loop', () => {
  it('iterates the body until the condition holds', async () => {
    const run = startRun({
      definition: loopDefinition(8),
      behaviors: {
        echo: {
          run: (input) => Promise.resolve(ok({ value: `${String(input[0])}.`, costNanoUsd: 0n })),
        },
      },
      predicates: { textDone: (state) => typeof state === 'string' && state.endsWith('...') },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      refine: { kind: 'text', text: 'x...' },
    });
  });

  it('keeps the previous state when a skip-on-error body iteration fails', async () => {
    const run = startRun({
      definition: loopDefinition(2, 'skip'),
      behaviors: { echo: failWith() },
      predicates: { textDone: () => false },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      refine: { kind: 'text', text: 'x' },
    });
  });

  it('stops iterating at the declared bound when the condition never holds', async () => {
    const body = vi.fn(
      (input: readonly unknown[]): Promise<ReturnType<typeof ok<never, never>>> =>
        Promise.resolve(ok({ value: `${String(input[0])}.`, costNanoUsd: 0n })) as never
    );
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: { echo: { run: body as never } },
      predicates: { textDone: () => false },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(body).toHaveBeenCalledTimes(3);
    expect(run.settlements[0]?.outputs).toEqual({
      refine: { kind: 'text', text: 'x...' },
    });
  });

  it('trips the circuit between iterations', async () => {
    const run = startRun({
      definition: loopDefinition(8),
      behaviors: {
        echo: {
          run: (input) => Promise.resolve(ok({ value: `${String(input[0])}.`, costNanoUsd: 300n })),
        },
      },
      predicates: { textDone: () => false },
      decision: grantWithLimit(500n),
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
  });
});

describe('createWorkflowExecutor — subWorkflow', () => {
  it('executes a registered sub-workflow over positional inputs', async () => {
    const run = startRun({
      definition: subWorkflowDefinition(),
      behaviors: {
        summarize: {
          run: (input) =>
            Promise.resolve(
              ok({ value: `${String(input[0])}+${String(input[1])}`, costNanoUsd: 0n })
            ),
        },
      },
      inputs: { prompt: textInput('hi'), extra: textInput('there') },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      summarize: { kind: 'text', text: 'hi+there' },
    });
  });
});

describe('createWorkflowExecutor — ingress validation', () => {
  it('fails validation when a referenced workflow input is missing', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {},
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });

  it('fails validation when a supplied input is not a content value', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: { prompt: { kind: 'text', text: 42 } as unknown as FlowInputs[string] },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('rejects a byte payload claiming the text modality', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {
        prompt: {
          kind: 'bytes',
          bytes: new Uint8Array(2),
          mimeType: 'text/plain',
          modality: 'text',
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('rejects an inline byte payload whose shape no channel tag accepts', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      inputs: {
        prompt: {
          kind: 'bytes',
          bytes: new Uint8Array(2),
          mimeType: 'image/png',
          modality: 'image',
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.admissionRequests).toEqual([]);
  });
});

describe('createWorkflowExecutor — defects', () => {
  it('contains a throwing node execution as an internal failure', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: () => {
            throw new Error('boom');
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('contains a settlement hook that throws on a stopped partial', async () => {
    const behavior = streamThenHang('partial answer');
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
      settle: () => Promise.reject(new Error('settle boom')),
    });
    await behavior.hanging;
    run.stop('deadline');
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('contains a throwing admission hook as an internal failure', async () => {
    const telemetry = makeTelemetry();
    const executor = createWorkflowExecutor({
      registries: registries(),
      execution: makeFakeExecutionRegistry({
        behaviors: { 'answer-model': streamingEcho() },
      }),
      estimateRun: () => ok(nanoUSD(1n)),
      clock: { now: () => 0 },
      rng: { random: () => 0.5 },
      telemetry,
    });
    const handle = executor.start({
      definition: answerDefinition(),
      inputs: { prompt: textInput('hi') },
      hooks: {
        admission: () => Promise.reject(new Error('admission boom')),
        settlement: () => Promise.resolve(),
      },
      runKey: RUN_KEY,
      emit: () => {},
    });
    await expect(handle.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('contains a throwing settlement hook as an internal failure', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      settle: () => Promise.reject(new Error('settle boom')),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing execution registration as a defect', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing branch predicate registration as a defect', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a non-string branch verdict as a defect', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': streamingEcho(),
        'hard-model': respondWith('hard answer'),
      },
      predicates: { routeByLabel: () => 42 },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing reducer registration as a defect', async () => {
    const run = startRun({
      definition: fanOutDefinition(4),
      behaviors: {
        split: {
          run: (input) =>
            Promise.resolve(ok({ value: String(input[0]).split(' '), costNanoUsd: 0n })),
        },
        'answer-model': streamingEcho(),
      },
      inputs: { prompt: textInput('one two') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a missing loop condition registration as a defect', async () => {
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: { echo: respondWith('x.') },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a non-boolean loop condition verdict as a defect', async () => {
    const run = startRun({
      definition: loopDefinition(3),
      behaviors: { echo: respondWith('x.') },
      predicates: { textDone: () => 'yes' },
      inputs: { prompt: textInput('x') },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('treats a node output violating its declared tag as a node failure', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': respondWith(42) },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
  });
});
