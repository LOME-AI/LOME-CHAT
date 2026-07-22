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
import { forbiddenError, notFoundError, validationError } from '../../../lib/errors/index.js';
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
import { smartModel } from '../builder/smart-model.js';
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
import {
  AllBranchesFailedError,
  SettlementConflictError,
  StorageUnavailableError,
} from './failures.js';
import { ReplayBuffer } from '../../../../../../packages/realtime/src/replay-buffer.js';
import type {
  AdmissionRequest,
  ChatHistoryMessage,
  FilePartMapper,
  FlowAdmissionOutcome,
  FlowHoldIdentity,
  FlowInputs,
  FlowRunOutcome,
  FlowStartRequest,
  FlowStreamEvent,
  NanoUSD,
  SettlementRequest,
  TextTag,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { BuildRegistries } from '../builder/build-workflow.js';
import type { FakeBehavior, FakeExecutionOptions } from './execution-fakes.js';
import type { EngineAdmissionDecision } from './hooks.js';

const HOOKS = PolicyHooks.parse({ admission: 'chatAdmission', settlement: 'chatSettlement' });

// The client-supplied Idempotency-Key (printable-ASCII, attacker-controllable —
// never allowlist it as a Sentry tag) versus the server-minted uuidv7 run id.
const RUN_KEY = 'attacker@example.com controlled key';
const RUN_ID = '018f3a2b-0000-7000-8000-000000000000';

/** The billing facts a fake `answer-model` modelCall threads to settlement. */
const ANSWER_BILLING = { modelId: 'answer-model', providerName: 'p', modality: 'text' } as const;

function registries(): BuildRegistries {
  return { nodes: makeFakeNodeRegistry(), constraints: makeFakeConstraints() };
}

function textInput(text: string): FlowInputs[string] {
  return { kind: 'text', text };
}

function grantWithLimit(limitNanoUsd: bigint, hold?: FlowHoldIdentity): EngineAdmissionDecision {
  return {
    admitted: true,
    holdRef: 'hold-1',
    ...(hold === undefined ? {} : { hold }),
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
  readonly history?: readonly ChatHistoryMessage[];
  readonly customInstructions?: string;
  readonly mapFilePartFor?: FlowStartRequest['mapFilePartFor'];
  readonly decision?: EngineAdmissionDecision | Promise<never>;
  readonly settle?: (request: SettlementRequest) => Promise<void>;
  readonly estimate?: NanoUSD;
  readonly estimateFails?: boolean;
  readonly valueBudgetBytes?: number;
  readonly startAtMs?: number;
}

interface Harness {
  readonly done: Promise<FlowRunOutcome>;
  readonly admitted: Promise<FlowAdmissionOutcome>;
  readonly stop: (reason: 'user-stop' | 'deadline') => void;
  readonly emitted: FlowStreamEvent[];
  readonly settlements: SettlementRequest[];
  readonly admissionRequests: AdmissionRequest[];
  readonly telemetry: Telemetry;
  readonly clockState: { now: number };
}

/** The optional run-scoped context fields (history, custom instructions, file-part mapper resolver) a start request carries only when supplied. */
function optionalRunContext(
  options: HarnessOptions
): Partial<Pick<FlowStartRequest, 'history' | 'customInstructions' | 'mapFilePartFor'>> {
  return {
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.customInstructions === undefined
      ? {}
      : { customInstructions: options.customInstructions }),
    ...(options.mapFilePartFor === undefined ? {} : { mapFilePartFor: options.mapFilePartFor }),
  };
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
    ...optionalRunContext(options),
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
    runId: RUN_ID,
    emit: (event) => {
      emitted.push(event);
    },
  });
  return {
    done: handle.done,
    admitted: handle.admitted,
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

/** A single composite smartModel node over the prompt — the Smart Model turn shape. */
function smartModelNodeDefinition(): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const answer = smartModel({
    id: 'answer',
    classifierModelId: 'answer-model',
    candidates: [{ id: 'answer-model', description: 'cheap' }, { id: 'hard-model' }],
    in: inputs.ports.prompt,
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

/**
 * The multi-model turn shape: N independent sibling `modelCall` nodes (ids
 * `m0`…), each `optional` + `onError: 'skip'`, all reading the one prompt and
 * each its own sink — the fan-out the engine walks as one topological level.
 */
function multiModelDefinition(models: readonly string[]): WorkflowDefinition {
  const inputs = workflowInputs({ prompt: textTag() });
  const siblings = models.map((model, index) =>
    modelCall({
      id: `m${String(index)}`,
      model,
      accepts: textTag(),
      in: inputs.ports.prompt,
      produces: textTag(),
      optional: true,
      onError: 'skip',
    })
  );
  return buildWorkflow({
    deadlineClass: 'text',
    hooks: HOOKS,
    inputs,
    nodes: siblings,
    registries: registries(),
  })._unsafeUnwrap().definition;
}

/** A billing fact tagged with a distinct model id, so charges are told apart. */
function billingFor(modelId: string): FakeBehavior {
  return streamingEcho(0n, { modelId, providerName: 'p', modality: 'text' });
}

/** streamingEcho that resolves only after `delayMs`, to decouple completion order from declaration order. */
function delayedEcho(delayMs: number, costNanoUsd: bigint, modelId: string): FakeBehavior {
  return {
    streaming: true,
    run: async (input, ctx) => {
      const value = `echo:${String(input[0])}`;
      for (let index = 0; index < value.length; index += 1) {
        ctx.emit?.({ kind: 'text-delta', index, content: value.charAt(index) });
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return ok({ value, costNanoUsd, billing: { modelId, providerName: 'p', modality: 'text' } });
    },
  };
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
    expect(run.emitted.map((event) => event.cursor)).toEqual(
      run.emitted.map((_, index) => index + 1)
    );
    expect(run.emitted[0]?.event).toEqual({ kind: 'text-delta', index: 0, content: 'e' });
  });

  // Composition against the real ReplayBuffer: the interpreter is the only
  // cursor allocator, and the buffer enforces the 1-based strictly-increasing
  // contract — a 0-based allocation throws on the very first token and a
  // fresh-client resume (lastEventId 0) would silently drop cursor-0 events.
  it('allocates cursors the real ReplayBuffer accepts and fully replays from a fresh resume', async () => {
    const buffer = new ReplayBuffer({ maxStreamBytes: 64 * 1024 });
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.emitted.length).toBeGreaterThan(1);
    for (const event of run.emitted) {
      expect(buffer.append(event)).toBe('buffered');
    }
    const streamId = run.emitted[0]?.streamId ?? '';
    expect(buffer.resume(streamId, 0)).toEqual({ kind: 'replay', events: run.emitted });
  });

  it('settles the terminal output and its per-generation charge under the producing node id', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho(1234n, ANSWER_BILLING) },
    });
    await run.done;
    expect(run.settlements).toEqual([
      {
        runKey: RUN_KEY,
        outputs: { answer: { kind: 'text', text: 'echo:hi' } },
        charges: [{ key: 'answer', ...ANSWER_BILLING, baseCostNanoUsd: 1234n, isEstimated: false }],
      },
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
      runId: RUN_ID,
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
    expect(run.settlements).toEqual([{ runKey: RUN_KEY, outputs: {}, charges: [] }]);
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

  it('surfaces a failing node reason as the run outcome wire code', async () => {
    const run = startRun({
      definition: smartDefinition(),
      behaviors: {
        'classifier-model': respondWith({ label: 'simple' }),
        'answer-model': failWith(undefined, ERROR_CODES.CONTENT_POLICY),
        'hard-model': respondWith('hard answer'),
      },
      predicates: ROUTE_PREDICATES,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.CONTENT_POLICY,
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

describe('createWorkflowExecutor — the composite smartModel node', () => {
  it('dispatches a smartModel node as a streaming value node keyed by its classifier', async () => {
    const run = startRun({
      definition: smartModelNodeDefinition(),
      behaviors: { 'answer-model': streamingEcho(7n, ANSWER_BILLING) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({ answer: { kind: 'text', text: 'echo:hi' } });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'answer',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        baseCostNanoUsd: 7n,
        isEstimated: false,
      },
    ]);
  });
});

/** A classifier generation's billing facts, distinct from the answer's. */
const AUX_BILLING = { modelId: 'cheap-model', providerName: 'p', modality: 'text' } as const;

describe('createWorkflowExecutor — auxiliary charges and mid-node accrual', () => {
  it("collects an auxiliary generation's charge under the node key plus its suffix", async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: () =>
            Promise.resolve(
              ok({
                value: 'routed answer',
                costNanoUsd: 20n,
                isEstimated: false,
                billing: ANSWER_BILLING,
                auxiliaryCharges: [
                  {
                    keySuffix: 'classifier',
                    billing: { ...AUX_BILLING, generationId: 'gen-cls' },
                    baseCostNanoUsd: 7n,
                    isEstimated: false,
                  },
                ],
              })
            ),
        },
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'answer',
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'text',
        baseCostNanoUsd: 20n,
        isEstimated: false,
      },
      {
        key: 'answer#classifier',
        modelId: 'cheap-model',
        providerName: 'p',
        modality: 'text',
        generationId: 'gen-cls',
        baseCostNanoUsd: 7n,
        isEstimated: false,
      },
    ]);
  });

  it('lifts smartModelRan onto the primary charge only, never the auxiliary classifier charge', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: () =>
            Promise.resolve(
              ok({
                value: 'routed answer',
                costNanoUsd: 20n,
                isEstimated: false,
                smartModelRan: true,
                billing: ANSWER_BILLING,
                auxiliaryCharges: [
                  {
                    keySuffix: 'classifier',
                    billing: { ...AUX_BILLING, generationId: 'gen-cls' },
                    baseCostNanoUsd: 7n,
                    isEstimated: false,
                  },
                ],
              })
            ),
        },
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    const charges = run.settlements[0]?.charges ?? [];
    expect(charges[0]).toMatchObject({ key: 'answer', smartModelRan: true });
    // The classifier's own auxiliary charge never carries the chip signal.
    expect(charges[1]).not.toHaveProperty('smartModelRan');
  });

  it('trips the circuit and aborts the run signal when mid-node accrual crosses the limit', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: (_input, ctx) => {
            ctx.accrue?.(2000n);
            // The over-limit accrual must abort synchronously so the node can
            // refuse its next provider call before spending anything more.
            expect(ctx.signal.aborted).toBe(true);
            return Promise.resolve(err({}));
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(run.settlements).toEqual([]);
  });

  it('counts mid-node accrual toward the boundary check alongside node costs', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: (_input, ctx) => {
            ctx.accrue?.(300n);
            expect(ctx.signal.aborted).toBe(false);
            return Promise.resolve(
              ok({ value: 'done', costNanoUsd: 300n, billing: ANSWER_BILLING })
            );
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(run.settlements).toEqual([]);
  });

  it('captures exactly one Sentry event carrying the runId and absorbed nano-USD when the circuit trips', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          run: (_input, ctx) => {
            ctx.accrue?.(2000n);
            return Promise.resolve(err({}));
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledOnce();
    const [error, fingerprint] = vi.mocked(run.telemetry.captureError).mock.calls[0]!;
    expect(fingerprint).toBe('workflow_cost_circuit_tripped');
    expect(error).toBeInstanceOf(Error);
    // The absorbed loss (accrued provider spend, unbilled) and the DO-minted
    // runId ride the event so a human can see which run overshot and by how much.
    expect(error.message).toContain(RUN_ID);
    expect(error.message).toContain('2000');
    // The scrub drops the message but preserves these two non-PII properties as
    // allowlisted Sentry tags, so the loss survives to the wire. The tagged id
    // is the DO-minted uuidv7 run id — never the client-supplied Idempotency-Key
    // (`runKey`), which is attacker-controllable and would bypass the scrub.
    // absorbedNanoUsd is the nano-USD bigint as a string (money is never
    // Number()-coerced), which is also what a Sentry tag carries.
    expect(error).toMatchObject({ runId: RUN_ID, absorbedNanoUsd: '2000' });
    // The client key must reach NEITHER the tag properties NOR the message.
    expect(error).not.toMatchObject({ runId: RUN_KEY });
    expect(error.message).not.toContain(RUN_KEY);
  });

  it('does not capture a routine node failure to Sentry', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': failWith() },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });
});

describe('createWorkflowExecutor — deadline and stop', () => {
  it('settles the streamed partial and its charge when the deadline stops the run', async () => {
    const behavior = streamThenHang('partial answer', 7n, ANSWER_BILLING);
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': behavior },
    });
    await behavior.hanging;
    run.stop('deadline');
    await expect(run.done).resolves.toEqual({ outcome: 'stopped' });
    // The billable partial rides the stopped-partial settle path with its charge.
    expect(run.settlements).toEqual([
      {
        runKey: RUN_KEY,
        outputs: { answer: { kind: 'text', text: 'partial answer' } },
        charges: [{ key: 'answer', ...ANSWER_BILLING, baseCostNanoUsd: 7n, isEstimated: false }],
      },
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

  it('maps a video download that breaches the remaining budget to a VALIDATION failure without a Sentry capture', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          streaming: true,
          // The video adapter aborts an over-budget download by throwing an
          // error named 'DownloadByteCapExceeded'; the engine maps it to the
          // byte-budget-exceeded failure rather than treating it as a defect.
          run: () => {
            const error = new Error('video download exceeded the byte cap');
            error.name = 'DownloadByteCapExceeded';
            throw error;
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.VALIDATION,
    });
    expect(run.settlements).toEqual([]);
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
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
        'answer-model': streamingEcho(9n, ANSWER_BILLING),
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
      expect(cursors).toEqual(cursors.map((_, index) => index + 1));
    }
    expect(run.settlements[0]?.outputs).toEqual({
      join: { kind: 'text', text: 'echo:one|echo:two|one two' },
    });
    // One charge per branch, keyed by the body node id + the branch element index.
    const charges = run.settlements[0]?.charges ?? [];
    expect(charges.toSorted((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'describe#0', ...ANSWER_BILLING, baseCostNanoUsd: 9n, isEstimated: false },
      { key: 'describe#1', ...ANSWER_BILLING, baseCostNanoUsd: 9n, isEstimated: false },
    ]);
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
      { runKey: RUN_KEY, outputs: { side: { kind: 'text', text: 'echo:hi' } }, charges: [] },
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

describe('createWorkflowExecutor — concurrent multi-model siblings', () => {
  it('streams the sibling modelCalls concurrently, interleaving their token streams', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const behavior: FakeBehavior = {
      streaming: true,
      run: async (input, ctx) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        ctx.emit?.({ kind: 'text-delta', index: 0, content: 'a' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        ctx.emit?.({ kind: 'text-delta', index: 1, content: 'b' });
        inFlight -= 1;
        return ok({ value: String(input[0]), costNanoUsd: 0n, billing: ANSWER_BILLING });
      },
    };
    const run = startRun({
      definition: multiModelDefinition(['answer-model', 'answer-model', 'answer-model']),
      behaviors: { 'answer-model': behavior },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    // All three ran together, not one-after-another.
    expect(maxInFlight).toBe(3);
    // Concurrency proof: every sibling emits its first token before any emits
    // its second — a sequential walk would group each stream's tokens together.
    expect(run.emitted.slice(0, 3).map((event) => event.event)).toEqual([
      { kind: 'text-delta', index: 0, content: 'a' },
      { kind: 'text-delta', index: 0, content: 'a' },
      { kind: 'text-delta', index: 0, content: 'a' },
    ]);
    expect(
      run.emitted
        .slice(3, 6)
        .every((event) => event.event.kind === 'text-delta' && event.event.content === 'b')
    ).toBe(true);
    expect(new Set(run.emitted.slice(0, 3).map((event) => event.streamId)).size).toBe(3);
  });

  it('bounds concurrency at six even with more independent siblings', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const behavior: FakeBehavior = {
      streaming: true,
      run: async (input) => {
        arrived += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return ok({ value: String(input[0]), costNanoUsd: 0n, billing: ANSWER_BILLING });
      },
    };
    const run = startRun({
      definition: multiModelDefinition(Array.from({ length: 8 }, () => 'answer-model')),
      behaviors: { 'answer-model': behavior },
    });
    // Let the bounded pool fill before releasing anything.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(arrived).toBe(6);
    expect(maxInFlight).toBe(6);
    release();
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    // All eight eventually ran, but never more than six at once.
    expect(arrived).toBe(8);
    expect(maxInFlight).toBe(6);
  });

  it('settles one charge per sibling keyed by node id in declaration order, completion order aside', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: {
        // The first-declared sibling finishes LAST — declaration order must win.
        'first-model': delayedEcho(30, 11n, 'first-model'),
        'second-model': delayedEcho(20, 22n, 'second-model'),
        'third-model': delayedEcho(10, 33n, 'third-model'),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements).toHaveLength(1);
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'm0',
        modelId: 'first-model',
        providerName: 'p',
        modality: 'text',
        baseCostNanoUsd: 11n,
        isEstimated: false,
      },
      {
        key: 'm1',
        modelId: 'second-model',
        providerName: 'p',
        modality: 'text',
        baseCostNanoUsd: 22n,
        isEstimated: false,
      },
      {
        key: 'm2',
        modelId: 'third-model',
        providerName: 'p',
        modality: 'text',
        baseCostNanoUsd: 33n,
        isEstimated: false,
      },
    ]);
    expect(run.settlements[0]?.outputs).toEqual({
      m0: { kind: 'text', text: 'echo:hi' },
      m1: { kind: 'text', text: 'echo:hi' },
      m2: { kind: 'text', text: 'echo:hi' },
    });
  });

  it('settles and bills only the successful subset when some siblings fail', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model', 'third-model']),
      behaviors: {
        'first-model': billingFor('first-model'),
        'second-model': failWith(),
        'third-model': billingFor('third-model'),
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(run.settlements[0]?.outputs).toEqual({
      m0: { kind: 'text', text: 'echo:hi' },
      m2: { kind: 'text', text: 'echo:hi' },
    });
    expect(run.settlements[0]?.charges).toEqual([
      {
        key: 'm0',
        modelId: 'first-model',
        providerName: 'p',
        modality: 'text',
        baseCostNanoUsd: 0n,
        isEstimated: false,
      },
      {
        key: 'm2',
        modelId: 'third-model',
        providerName: 'p',
        modality: 'text',
        baseCostNanoUsd: 0n,
        isEstimated: false,
      },
    ]);
  });

  it('aborts the in-flight siblings when one trips the cost circuit mid-node', async () => {
    const observedAbort: boolean[] = [];
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': {
          streaming: true,
          run: (_input, ctx) => {
            ctx.accrue?.(2000n);
            return Promise.resolve(err({}));
          },
        },
        'second-model': {
          streaming: true,
          run: async (_input, ctx) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            observedAbort.push(ctx.signal.aborted);
            return err({});
          },
        },
      },
      decision: grantWithLimit(500n),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    expect(observedAbort).toContain(true);
    expect(run.settlements).toEqual([]);
  });

  it('reroutes an all-branches-failed settlement to UNAVAILABLE without capturing it', async () => {
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: { 'first-model': failWith(), 'second-model': failWith() },
      settle: (request) => {
        if (request.charges.length === 0) {
          // The chat settlement hook throws the real typed sentinel; the engine
          // discriminates it via instanceof, so a rename fails typecheck here.
          return Promise.reject(new AllBranchesFailedError('no model produced content'));
        }
        return Promise.resolve();
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('reroutes a storage-unavailable settlement throw to UNAVAILABLE without capturing it', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The chat media put barrier rejects settlement with the real typed
      // error when a ciphertext put failed; the engine discriminates it via
      // instanceof, so a rename fails typecheck here.
      settle: () => Promise.reject(new StorageUnavailableError('storage put failed')),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('reroutes a storage-unavailable node throw to UNAVAILABLE without capturing it', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: () => {
            throw new StorageUnavailableError('storage put failed');
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.UNAVAILABLE,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('reroutes a fork-tip settlement conflict to FORK_TIP_CONFLICT without capturing it', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The chat settlement hook throws the real typed sentinel when the fork
      // vanished mid-run or its tip moved; the engine discriminates it via
      // instanceof and projects the carried domain error's wire code.
      settle: () =>
        Promise.reject(
          new SettlementConflictError(
            notFoundError('fork gone', undefined, ERROR_CODES.FORK_TIP_CONFLICT),
            'chat settlement: fork-tip advancement failed'
          )
        ),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.FORK_TIP_CONFLICT,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('reroutes an epoch-wrap settlement conflict to CONFLICT without capturing it', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The sender is no longer a member of the wrapped epoch — a forbidden
      // domain error the settlement hook stamps with the CONFLICT wire-code
      // override; the engine's projection honors the override, never surfacing
      // FORBIDDEN, and never captures the race.
      settle: () =>
        Promise.reject(
          new SettlementConflictError(
            forbiddenError('sender no longer a member', undefined, ERROR_CODES.CONFLICT),
            'chat settlement: wrap-epoch assertion failed'
          )
        ),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.CONFLICT,
    });
    expect(run.telemetry.captureError).not.toHaveBeenCalled();
  });

  it('still captures a genuine settlement defect as INTERNAL', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': streamingEcho() },
      // The fork-tip CAS zero-row (unreachable under the fork-row lock) throws a
      // plain Error, not the conflict sentinel — so a genuine settlement defect
      // still routes to INTERNAL + Sentry.
      settle: () => Promise.reject(new Error('db exploded')),
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INTERNAL,
    });
    expect(run.telemetry.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'workflow_settlement_defect'
    );
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
      runId: RUN_ID,
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

describe('createWorkflowExecutor — run-scoped history threading', () => {
  const HISTORY: readonly ChatHistoryMessage[] = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];

  function captureHistories(
    seen: (readonly ChatHistoryMessage[] | undefined)[]
  ): FakeExecutionOptions['behaviors'][string] {
    return {
      run: (input, ctx) => {
        seen.push(ctx.history);
        return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
      },
    };
  }

  it('hands the start request history to every node execution context', async () => {
    const seen: (readonly ChatHistoryMessage[] | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureHistories(seen) },
      history: HISTORY,
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual([HISTORY]);
  });

  it('leaves the context history absent when the start request carries none', async () => {
    const seen: (readonly ChatHistoryMessage[] | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureHistories(seen) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual([undefined]);
  });
});

describe('createWorkflowExecutor — run-scoped custom-instructions threading', () => {
  function captureInstructions(
    seen: (string | undefined)[]
  ): FakeExecutionOptions['behaviors'][string] {
    return {
      run: (input, ctx) => {
        seen.push(ctx.customInstructions);
        return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
      },
    };
  }

  it('hands the start request custom instructions to every node execution context', async () => {
    const seen: (string | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureInstructions(seen) },
      customInstructions: 'answer only in French',
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual(['answer only in French']);
  });

  it('leaves the context custom instructions absent when the start request carries none', async () => {
    const seen: (string | undefined)[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: { 'answer-model': captureInstructions(seen) },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen).toEqual([undefined]);
  });
});

describe('createWorkflowExecutor — per-node file-part mapper threading', () => {
  function neverInvokedMapper(): FilePartMapper {
    return () => {
      throw new Error('the engine carries the mapper opaquely and never invokes it');
    };
  }

  function captureMapper(
    seen: Map<string, FilePartMapper | undefined>,
    behaviorName: string
  ): FakeBehavior {
    return {
      run: (input, ctx) => {
        seen.set(behaviorName, ctx.mapFilePart);
        return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
      },
    };
  }

  it('resolves a distinct mapper per node id and hands each node its own', async () => {
    const mapperForM0 = neverInvokedMapper();
    const mapperForM1 = neverInvokedMapper();
    const byNodeId: Record<string, FilePartMapper> = { m0: mapperForM0, m1: mapperForM1 };
    const seen = new Map<string, FilePartMapper | undefined>();
    const run = startRun({
      definition: multiModelDefinition(['first-model', 'second-model']),
      behaviors: {
        'first-model': captureMapper(seen, 'first-model'),
        'second-model': captureMapper(seen, 'second-model'),
      },
      mapFilePartFor: (nodeKey) => byNodeId[nodeKey],
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seen.get('first-model')).toBe(mapperForM0);
    expect(seen.get('second-model')).toBe(mapperForM1);
  });

  it('omits the context mapper key when the start request carries no resolver', async () => {
    const seenKeys: boolean[] = [];
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': {
          run: (input, ctx) => {
            seenKeys.push('mapFilePart' in ctx);
            return Promise.resolve(ok({ value: `echo:${String(input[0])}`, costNanoUsd: 0n }));
          },
        },
      },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
    expect(seenKeys).toEqual([false]);
  });
});

describe('createWorkflowExecutor — the admitted seam', () => {
  const HOLD: FlowHoldIdentity = { walletId: 'w1', holdId: 'run-1', scopeIds: ['scope-1'] };

  it('resolves admitted with the grant hold identity when admission grants', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {
        'answer-model': { run: () => Promise.resolve(ok({ value: 'a', costNanoUsd: 0n })) },
      },
      decision: grantWithLimit(1_000_000n, HOLD),
    });
    await expect(run.admitted).resolves.toEqual({ admitted: true, hold: HOLD });
    await expect(run.done).resolves.toEqual({ outcome: 'succeeded' });
  });

  it('resolves admitted without a hold when the grant carries none', async () => {
    const run = startRun({ definition: answerDefinition(), behaviors: {} });
    await expect(run.admitted).resolves.toEqual({ admitted: true });
  });

  it('resolves admitted false with the refusal code when admission refuses', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      decision: { admitted: false, code: ERROR_CODES.INSUFFICIENT_ADMISSION },
    });
    await expect(run.admitted).resolves.toEqual({
      admitted: false,
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
    await expect(run.done).resolves.toEqual({
      outcome: 'failed',
      code: ERROR_CODES.INSUFFICIENT_ADMISSION,
    });
  });

  it('resolves admitted false with the failure code when the run fails before admission', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      inputs: { prompt: { kind: 'text', text: 42 } as unknown as FlowInputs[string] },
    });
    await expect(run.done).resolves.toEqual({ outcome: 'failed', code: ERROR_CODES.VALIDATION });
    await expect(run.admitted).resolves.toEqual({
      admitted: false,
      code: ERROR_CODES.VALIDATION,
    });
  });

  it('resolves admitted false INTERNAL when a defect escapes before the decision', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      decision: Promise.reject(new Error('admission boom')),
    });
    await expect(run.done).resolves.toEqual({ outcome: 'failed', code: ERROR_CODES.INTERNAL });
    await expect(run.admitted).resolves.toEqual({
      admitted: false,
      code: ERROR_CODES.INTERNAL,
    });
  });

  it('resolves admitted true before the circuit-readout defect fails the run', async () => {
    const run = startRun({
      definition: answerDefinition(),
      behaviors: {},
      decision: { admitted: true, holdRef: 'hold-1', hold: HOLD } as EngineAdmissionDecision,
    });
    await expect(run.admitted).resolves.toEqual({ admitted: true, hold: HOLD });
    await expect(run.done).resolves.toEqual({ outcome: 'failed', code: ERROR_CODES.INTERNAL });
  });
});
