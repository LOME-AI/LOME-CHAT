import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFIER_EFFORT_DIMENSION_MARKER,
  CLASSIFIER_MODEL_DIMENSION_MARKER,
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  Node as NodeSchema,
  serializeReasoningText,
  textTag,
} from '@hushbox/shared';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import { providerUsdToBillableNanoUsd } from '../../billing/index.js';
import { ok } from '../../../lib/result/index.js';
import { InferenceError } from '../../models/index.js';
import { createSmartModelExecution } from './smart-model-execution.js';
import type {
  InferenceEvent,
  InferenceRequest,
  Modality,
  ModelDescriptor,
  Node,
} from '@hushbox/shared';
import type { ModelProvider } from '../../models/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { NodeRunContext } from '../engine/execution-registry.js';
import type { ModelBinding } from './model-call-execution.js';
import type { SmartModelExecutionDeps } from './smart-model-execution.js';

const CHEAP = 'cheap/model';
const HARD = 'hard/model';

function descriptor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

function binding(id: string): ModelBinding {
  return {
    descriptor: descriptor(id),
    ports: { in: [textTag()], out: textTag() },
    // Same order of magnitude as the fixture inline costs, so the inline path
    // never trips the absurd-cost sanity bound and falls back to the estimate.
    price: () => ok(1_000_000n),
  };
}

function smartNode(overrides: Record<string, unknown> = {}): Extract<Node, { type: 'smartModel' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'smartModel',
    version: 1,
    out: 'out',
    classifierModelId: CHEAP,
    candidates: [
      { id: CHEAP, description: 'cheap and fast' },
      { id: HARD, description: 'strong reasoning' },
    ],
    params: { temperature: 0.5 },
    in: { node: 'input', port: 'prompt' },
    ...overrides,
  }) as Extract<Node, { type: 'smartModel' }>;
}

function finish(providerCostUsd: number, generationId: string): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: { inputTokens: 3, outputTokens: 5 },
      finishReason: 'stop',
      providerCostUsd,
      generationId,
    },
  };
}

function textDelta(content: string): InferenceEvent {
  return { kind: 'text-delta', index: 0, content };
}

/** Streams per-model canned events, capturing each request in arrival order. */
function providerByModel(
  eventsByModel: Readonly<Record<string, readonly InferenceEvent[] | Error>>,
  requests: InferenceRequest[]
): ModelProvider {
  return {
    infer: (request) => {
      requests.push(request);
      const events = eventsByModel[request.model];
      return (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        if (events === undefined) throw new Error(`no canned events for ${request.model}`);
        if (events instanceof Error) throw events;
        for (const event of events) yield event;
      })();
    },
  };
}

/** The text of one request input part ('' for absent/non-text — assertions then fail loudly). */
function textOf(part: InferenceRequest['inputs'][number] | undefined): string {
  return part?.modality === 'text' ? part.text : '';
}

const CLASSIFIER_EVENTS: readonly InferenceEvent[] = [textDelta(HARD), finish(0.001, 'gen-cls')];
const CHEAP_ANSWER: readonly InferenceEvent[] = [
  textDelta('cheap answer'),
  finish(0.002, 'gen-cheap'),
];
const HARD_ANSWER: readonly InferenceEvent[] = [
  textDelta('hard answer'),
  finish(0.004, 'gen-hard'),
];

function makeDeps(
  provider: ModelProvider,
  overrides: Partial<SmartModelExecutionDeps> = {}
): SmartModelExecutionDeps {
  return {
    provider,
    classifier: binding(CHEAP),
    candidates: new Map([
      [CHEAP, binding(CHEAP)],
      [HARD, binding(HARD)],
    ]),
    schemas: { resolveSchema: vi.fn() },
    usdToBillableNanoUsd: providerUsdToBillableNanoUsd,
    ...overrides,
  };
}

/** A Telemetry spy: records warn/captureError so degrade breadcrumbs can be asserted. */
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

interface CtxOptions {
  readonly history?: NodeRunContext['history'];
  readonly signal?: AbortSignal;
  readonly accrue?: (costNanoUsd: bigint) => void;
  readonly customInstructions?: string;
}

function makeCtx(emitted: InferenceEvent[], options: CtxOptions = {}): NodeRunContext {
  return {
    values: {
      store: (value: unknown) => ok(value),
      resolve: (value: unknown) => value,
    } as unknown as NodeRunContext['values'],
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: options.signal ?? new AbortController().signal,
    emit: (event): void => {
      emitted.push(event);
    },
    ...(options.history === undefined ? {} : { history: options.history }),
    ...(options.accrue === undefined ? {} : { accrue: options.accrue }),
    ...(options.customInstructions === undefined
      ? {}
      : { customInstructions: options.customInstructions }),
  };
}

describe('createSmartModelExecution — classify → resolve → answer', () => {
  it('routes to the classified candidate and bills both generations under one node', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const emitted: InferenceEvent[] = [];
    const execution = createSmartModelExecution(makeDeps(provider));
    expect(execution.streaming).toBe(true);

    const result = await execution.run(smartNode(), ['pick a model for me'], makeCtx(emitted));
    const success = result._unsafeUnwrap();
    expect(success.value).toBe('hard answer');
    expect(success.costNanoUsd).toBe(providerUsdToBillableNanoUsd(0.004));
    expect(success.isEstimated).toBe(false);
    const tokens = { inputTokens: 3, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 };
    expect(success.billing).toEqual({
      modelId: HARD,
      providerName: 'p',
      modality: 'text',
      generationId: 'gen-hard',
      tokens,
    });
    expect(success.auxiliaryCharges).toEqual([
      {
        keySuffix: 'classifier',
        billing: {
          modelId: CHEAP,
          providerName: 'p',
          modality: 'text',
          generationId: 'gen-cls',
          tokens,
        },
        billableCostNanoUsd: providerUsdToBillableNanoUsd(0.001),
        isEstimated: false,
      },
    ]);
  });

  it('sends the classifier its own prompt: marker + candidate lines, capped output, no history', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));
    const history = [{ role: 'assistant' as const, content: 'previous reply' }];

    await execution.run(smartNode(), ['what is a monad?'], makeCtx([], { history }));

    const classifierRequest = requests[0];
    expect(classifierRequest?.model).toBe(CHEAP);
    expect(classifierRequest?.parameters).toEqual({ maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP });
    expect(classifierRequest).not.toHaveProperty('history');
    const system = textOf(classifierRequest?.inputs[0]);
    const user = textOf(classifierRequest?.inputs[1]);
    expect(system).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(system).toContain(`- ${CHEAP} — cheap and fast`);
    expect(system).toContain(`- ${HARD} — strong reasoning`);
    // The truncated context is the latest exchange: the prompt input plus the
    // last assistant message from the run history.
    expect(user).toContain('what is a monad?');
    expect(user).toContain('previous reply');
  });

  it('renders an id-only prompt line for a candidate without a description', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));
    const node = smartNode({
      candidates: [{ id: CHEAP }, { id: HARD, description: 'strong reasoning' }],
    });

    await execution.run(node, ['prompt'], makeCtx([]));

    expect(textOf(requests[0]?.inputs[0])).toContain(`- ${CHEAP} —`);
  });

  it('sends the answer call the full run history and the node params, streaming its events', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const emitted: InferenceEvent[] = [];
    const execution = createSmartModelExecution(makeDeps(provider));
    const history = [
      { role: 'user' as const, content: 'earlier question' },
      { role: 'assistant' as const, content: 'earlier answer' },
    ];

    await execution.run(smartNode(), ['follow-up'], makeCtx(emitted, { history }));

    const answerRequest = requests[1];
    expect(answerRequest?.model).toBe(HARD);
    expect(answerRequest?.inputs).toEqual([{ modality: 'text', text: 'follow-up' }]);
    expect(answerRequest?.parameters).toEqual({ temperature: 0.5 });
    expect(answerRequest?.history).toEqual(history);
    // Only the ANSWER generation rides the client stream — classifier tokens
    // are routing internals, never user-visible content. The stream labels
    // itself first with the RESOLVED model.
    expect(emitted).toEqual([{ kind: 'stream-start', modelId: HARD }, ...HARD_ANSWER]);
  });

  it('threads run-scoped custom instructions onto the ANSWER request only, never the classifier', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));

    await execution.run(
      smartNode(),
      ['follow-up'],
      makeCtx([], { customInstructions: 'answer in French' })
    );

    // Classifier (requests[0]) is routing-internal: fixed params, no instructions.
    expect(requests[0]?.parameters).toEqual({ maxOutputTokens: CLASSIFIER_OUTPUT_TOKEN_CAP });
    expect(requests[0]).not.toHaveProperty('customInstructions');
    // Answer (requests[1]) carries the instructions in the dedicated field,
    // sourced from the run-scoped ctx; the node params ride unperturbed.
    const answerRequest = requests[1];
    expect(answerRequest?.customInstructions).toBe('answer in French');
    expect(answerRequest?.parameters).toEqual({ temperature: 0.5 });
  });

  it('omits custom instructions from the answer request when the context carries none', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));

    await execution.run(smartNode(), ['follow-up'], makeCtx([]));

    expect(requests[1]).not.toHaveProperty('customInstructions');
    expect(requests[1]?.parameters).toEqual({ temperature: 0.5 });
  });

  it('labels the answer stream with the classifier-RESOLVED model id, classifier invisible', async () => {
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, []);
    const emitted: InferenceEvent[] = [];
    const execution = createSmartModelExecution(makeDeps(provider));

    await execution.run(smartNode(), ['pick a model for me'], makeCtx(emitted));

    // First event = the resolved model's label — never the classifier's.
    expect(emitted[0]).toEqual({ kind: 'stream-start', modelId: HARD });
    // Exactly one stream label: the classifier generation emitted nothing.
    expect(emitted.filter((event) => event.kind === 'stream-start')).toHaveLength(1);
  });

  it('labels the single-candidate short-circuit stream with the only candidate', async () => {
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, []);
    const emitted: InferenceEvent[] = [];
    const execution = createSmartModelExecution(
      makeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    const node = smartNode({ candidates: [{ id: CHEAP, description: 'cheap and fast' }] });

    await execution.run(node, ['prompt'], makeCtx(emitted));

    expect(emitted[0]).toEqual({ kind: 'stream-start', modelId: CHEAP });
  });

  it('accrues the classifier cost through ctx.accrue before starting the answer call', async () => {
    const order: string[] = [];
    const requests: InferenceRequest[] = [];
    const inner = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        order.push(`call:${request.model}`);
        return inner.infer(request, requestDescriptor, options);
      },
    };
    const accrue = vi.fn((cost: bigint) => {
      order.push(`accrue:${String(cost)}`);
    });
    const execution = createSmartModelExecution(makeDeps(provider));

    await execution.run(smartNode(), ['prompt'], makeCtx([], { accrue }));

    expect(order).toEqual([
      `call:${CHEAP}`,
      `accrue:${String(providerUsdToBillableNanoUsd(0.001))}`,
      `call:${HARD}`,
    ]);
  });

  it('falls back to the cheapest candidate on an unresolvable classifier output, keeping its charge', async () => {
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta('no idea, maybe use a horse?'), finish(0.001, 'gen-cls')],
      },
      []
    );
    // The classifier and the cheapest candidate are the same model; the fake
    // must serve the classifier prompt first, then the fallback answer.
    let calls = 0;
    const twoPhase: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        calls += 1;
        if (calls === 1) return provider.infer(request, requestDescriptor, options);
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          for (const event of CHEAP_ANSWER) yield event;
        })();
      },
    };
    const execution = createSmartModelExecution(makeDeps(twoPhase));

    const result = await execution.run(smartNode(), ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();
    expect(success.value).toBe('cheap answer');
    expect(success.billing?.modelId).toBe(CHEAP);
    // The classifier ran and produced a generation: its charge stands even
    // though its routing output was discarded.
    expect(success.auxiliaryCharges).toHaveLength(1);
    expect(success.auxiliaryCharges?.[0]?.billing.generationId).toBe('gen-cls');
  });

  it('falls back to the cheapest candidate on a classifier error, with no classifier charge', async () => {
    let calls = 0;
    const provider: ModelProvider = {
      infer: () => {
        calls += 1;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          if (calls === 1) throw new InferenceError('upstream_error', 'classifier down');
          for (const event of CHEAP_ANSWER) yield event;
        })();
      },
    };
    const execution = createSmartModelExecution(makeDeps(provider));

    const result = await execution.run(smartNode(), ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();
    expect(success.value).toBe('cheap answer');
    expect(success.billing?.modelId).toBe(CHEAP);
    // No generation, no charge: the failed classifier call billed nothing.
    expect(success.auxiliaryCharges ?? []).toEqual([]);
    // The pipeline still ran, so the answer is badged Smart Model regardless of
    // the classifier having billed nothing (legacy stagesRun parity).
    expect(success.smartModelRan).toBe(true);
  });

  it('badges the fallback answer and degrades gracefully on a THROWN unclassified classifier error', async () => {
    let calls = 0;
    const provider: ModelProvider = {
      infer: () => {
        calls += 1;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          // A plain, unclassified throw from the classifier generation — NOT an
          // InferenceError, NOT an abort. Legacy caught any classifier throw and
          // still ran the stage; the node must degrade to the fallback, not fail.
          if (calls === 1) throw new Error('classifier exploded');
          for (const event of CHEAP_ANSWER) yield event;
        })();
      },
    };
    const telemetry = fakeTelemetry();
    const execution = createSmartModelExecution(makeDeps(provider, { telemetry }));

    const result = await execution.run(smartNode(), ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();
    expect(success.value).toBe('cheap answer');
    expect(success.billing?.modelId).toBe(CHEAP);
    // No generation completed, so no charge — yet the pipeline ran, so badged.
    expect(success.auxiliaryCharges ?? []).toEqual([]);
    expect(success.smartModelRan).toBe(true);
    // The degrade logs a non-Sentry structured breadcrumb — model id only, never
    // the error, prompt, or output — and never fires a Sentry defect.
    expect(telemetry.warn).toHaveBeenCalledWith(expect.any(String), { modelName: CHEAP });
    expect(telemetry.captureError).not.toHaveBeenCalled();
  });

  it('badges the answer with smartModelRan on the happy classify → answer path', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));

    const result = await execution.run(smartNode(), ['prompt'], makeCtx([]));
    expect(result._unsafeUnwrap().smartModelRan).toBe(true);
  });

  it('badges the single-candidate short-circuit — the Smart pipeline still ran (legacy parity)', async () => {
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, []);
    const execution = createSmartModelExecution(
      makeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    const node = smartNode({ candidates: [{ id: CHEAP, description: 'cheap and fast' }] });

    const result = await execution.run(node, ['prompt'], makeCtx([]));
    expect(result._unsafeUnwrap().smartModelRan).toBe(true);
  });

  it('still fails the node (does NOT degrade) on a thrown unclassified error from the ANSWER call', async () => {
    let calls = 0;
    const provider: ModelProvider = {
      infer: () => {
        calls += 1;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          if (calls === 1) {
            for (const event of CLASSIFIER_EVENTS) yield event;
            return;
          }
          // The widened catch is scoped to the classifier ONLY: an unclassified
          // throw from the ANSWER call is still a genuine defect that propagates.
          throw new Error('answer exploded');
        })();
      },
    };
    const execution = createSmartModelExecution(makeDeps(provider));

    await expect(execution.run(smartNode(), ['prompt'], makeCtx([]))).rejects.toThrow(
      /answer exploded/
    );
  });

  it('still propagates a defect thrown AFTER the classifier stream (routing logic), not swallowed', async () => {
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, []);
    const execution = createSmartModelExecution(makeDeps(provider));
    // ctx.accrue runs after the classifier stream resolves, OUTSIDE the widened
    // catch: a defect there is genuine and must still surface, proving the catch
    // was not over-widened to swallow the classifier stage's post-call routing.
    const accrue = (): void => {
      throw new Error('accrue exploded');
    };

    await expect(execution.run(smartNode(), ['prompt'], makeCtx([], { accrue }))).rejects.toThrow(
      /accrue exploded/
    );
  });

  it('labels the classifier-error fallback stream with the resolved fallback model id', async () => {
    let calls = 0;
    const provider: ModelProvider = {
      infer: () => {
        calls += 1;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          if (calls === 1) throw new InferenceError('upstream_error', 'classifier down');
          for (const event of CHEAP_ANSWER) yield event;
        })();
      },
    };
    const emitted: InferenceEvent[] = [];
    const execution = createSmartModelExecution(makeDeps(provider));

    const result = await execution.run(smartNode(), ['prompt'], makeCtx(emitted));
    const success = result._unsafeUnwrap();
    expect(success.value).toBe('cheap answer');
    // Branch-invariant label: the fallback path must emit the resolved-model
    // stream-start exactly like the happy path (RC-3 pin).
    expect(emitted[0]).toEqual({ kind: 'stream-start', modelId: CHEAP });
    expect(emitted.filter((event) => event.kind === 'stream-start')).toHaveLength(1);
  });

  it('skips the classifier entirely for a single candidate — one call, zero classifier charge', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CHEAP_ANSWER }, requests);
    const execution = createSmartModelExecution(
      makeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    const node = smartNode({ candidates: [{ id: CHEAP, description: 'cheap and fast' }] });

    const result = await execution.run(node, ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(CHEAP);
    expect(success.billing?.modelId).toBe(CHEAP);
    expect(success.auxiliaryCharges ?? []).toEqual([]);
  });

  it('refuses the answer call when the classifier accrual tripped the circuit (aborted signal)', async () => {
    const controller = new AbortController();
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));
    // Mirrors the interpreter's accrue: crossing the limit aborts synchronously.
    const accrue = (): void => {
      controller.abort();
    };

    const result = await execution.run(
      smartNode(),
      ['prompt'],
      makeCtx([], { signal: controller.signal, accrue })
    );
    expect(result.isErr()).toBe(true);
    // The classifier call happened; the answer call must not.
    expect(requests).toHaveLength(1);
  });

  it('truncates a user-only history to an empty assistant side', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));
    const history = [{ role: 'user' as const, content: 'only questions so far' }];

    await execution.run(smartNode(), ['prompt'], makeCtx([], { history }));

    // No assistant turn exists yet, so the AI sections are omitted entirely.
    expect(textOf(requests[0]?.inputs[1])).not.toContain('[AI START]');
  });

  it('normalizes an empty run history to a history-free answer request', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));

    await execution.run(smartNode(), ['prompt'], makeCtx([], { history: [] }));

    expect(requests[1]).not.toHaveProperty('history');
  });

  it('treats a non-text classifier value as unresolvable and falls back', async () => {
    const mediaDone: InferenceEvent = {
      kind: 'media-done',
      index: 0,
      value: {
        ref: 'media/c/m/u',
        mimeType: 'image/png',
        modality: 'image',
        byteLength: 3,
        metadata: {},
      },
    };
    let calls = 0;
    const provider: ModelProvider = {
      infer: () => {
        calls += 1;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          if (calls === 1) {
            yield mediaDone;
            yield finish(0.001, 'gen-cls');
            return;
          }
          for (const event of CHEAP_ANSWER) yield event;
        })();
      },
    };
    const execution = createSmartModelExecution(makeDeps(provider));

    const result = await execution.run(smartNode(), ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();
    expect(success.billing?.modelId).toBe(CHEAP);
    // The classifier generation still ran, so its charge stands.
    expect(success.auxiliaryCharges).toHaveLength(1);
  });

  it('throws a defect when the resolved candidate has no binding (broken wiring)', async () => {
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, []);
    const execution = createSmartModelExecution(
      makeDeps(provider, { candidates: new Map([[CHEAP, binding(CHEAP)]]) })
    );
    await expect(execution.run(smartNode(), ['prompt'], makeCtx([]))).rejects.toThrow(
      /no binding for resolved candidate/
    );
  });

  it('fails as an ordinary node failure on a non-text input', async () => {
    const provider = providerByModel({}, []);
    const execution = createSmartModelExecution(makeDeps(provider));
    const result = await execution.run(smartNode(), [42], makeCtx([]));
    expect(result.isErr()).toBe(true);
  });
});

/** A reasoning-capable descriptor: effort-native (null = full ladder). */
function reasoningBinding(id: string): ModelBinding {
  const base = binding(id);
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      reasoning: { supportedEfforts: null },
      limits: { contextLength: 200_000 },
    },
  };
}

const ANSWER_CAP = REASONING_BUDGET_TOKENS_BY_EFFORT.high + 10_000;

/** A single-candidate pinned+auto node: effort dimension only. */
function pinnedAutoNode(
  overrides: Record<string, unknown> = {}
): Extract<Node, { type: 'smartModel' }> {
  return smartNode({
    candidates: [{ id: HARD, description: 'strong reasoning' }],
    classify: { model: false, effort: true },
    params: { maxOutputTokens: ANSWER_CAP },
    ...overrides,
  });
}

function pinnedAutoDeps(
  provider: ModelProvider,
  overrides: Partial<SmartModelExecutionDeps> = {}
): SmartModelExecutionDeps {
  return makeDeps(provider, {
    candidates: new Map([[HARD, reasoningBinding(HARD)]]),
    ...overrides,
  });
}

describe('createSmartModelExecution — effort dimension (generalized classifier stage)', () => {
  it('pinned + auto: one effort-only classifier generation, wire applied, charge rides, NOT badged', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta('high'), finish(0.001, 'gen-cls')],
        [HARD]: HARD_ANSWER,
      },
      requests
    );
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));

    const result = await execution.run(pinnedAutoNode(), ['prove a theorem'], makeCtx([]));
    const success = result._unsafeUnwrap();

    // Exactly one classifier generation + one answer generation.
    expect(requests).toHaveLength(2);
    const system = textOf(requests[0]?.inputs[0]);
    expect(system).toContain(CLASSIFIER_SYSTEM_PROMPT_MARKER);
    expect(system).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(system).not.toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(system).not.toContain('Available models:');
    // The classified level rides the answer call as the plan's wire; the
    // completion cap stays the built (already-reserved) cap.
    expect(requests[1]?.model).toBe(HARD);
    expect(requests[1]?.parameters['reasoning']).toEqual({ effort: 'high' });
    expect(requests[1]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
    // The classifier charge settles with the answer; the turn is NOT badged
    // Smart Model — the user pinned the model.
    expect(success.auxiliaryCharges).toHaveLength(1);
    expect(success.smartModelRan).toBeUndefined();
  });

  it('parses a reasoning-streaming classifier value via the shared parser (.answer, never the raw value)', async () => {
    const requests: InferenceRequest[] = [];
    // The classifier model itself streams reasoning: streamModelCall yields a
    // canonical-inline-prefixed value. Resolution must read the parsed
    // answer — the raw value starts with '<think>' and would resolve nowhere.
    const classifierValue: readonly InferenceEvent[] = [
      { kind: 'reasoning-delta', index: 0, content: 'the user wants deep analysis' },
      textDelta('low'),
      finish(0.001, 'gen-cls'),
    ];
    const provider = providerByModel({ [CHEAP]: classifierValue, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));

    await execution.run(pinnedAutoNode(), ['prompt'], makeCtx([]));

    expect(requests[1]?.parameters['reasoning']).toEqual({ effort: 'low' });
  });

  it('resolves both dimensions from one two-line generation (Smart Model + auto), badged', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta(`${HARD}\nmedium`), finish(0.001, 'gen-cls')],
        [HARD]: HARD_ANSWER,
      },
      requests
    );
    const execution = createSmartModelExecution(
      makeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );
    const node = smartNode({
      classify: { model: true, effort: true },
      params: { maxOutputTokens: ANSWER_CAP },
    });

    const result = await execution.run(node, ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();

    expect(requests).toHaveLength(2);
    const system = textOf(requests[0]?.inputs[0]);
    expect(system).toContain(CLASSIFIER_MODEL_DIMENSION_MARKER);
    expect(system).toContain(CLASSIFIER_EFFORT_DIMENSION_MARKER);
    expect(requests[1]?.model).toBe(HARD);
    expect(requests[1]?.parameters['reasoning']).toEqual({ effort: 'medium' });
    expect(success.smartModelRan).toBe(true);
    expect(success.auxiliaryCharges).toHaveLength(1);
  });

  it('falls back to medium on an unresolvable effort output — the charge stands', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta('turbo-max-overdrive'), finish(0.001, 'gen-cls')],
        [HARD]: HARD_ANSWER,
      },
      requests
    );
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));

    const result = await execution.run(pinnedAutoNode(), ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();

    expect(requests[1]?.parameters['reasoning']).toEqual({ effort: 'medium' });
    expect(success.auxiliaryCharges).toHaveLength(1);
  });

  it('still applies the medium fallback when the classifier call ERRORS (no charge)', async () => {
    let calls = 0;
    const requests: InferenceRequest[] = [];
    const provider: ModelProvider = {
      infer: (request) => {
        requests.push(request);
        calls += 1;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          if (calls === 1) throw new InferenceError('upstream_error', 'classifier down');
          for (const event of HARD_ANSWER) yield event;
        })();
      },
    };
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));

    const result = await execution.run(pinnedAutoNode(), ['prompt'], makeCtx([]));
    const success = result._unsafeUnwrap();

    expect(requests[1]?.parameters['reasoning']).toEqual({ effort: 'medium' });
    expect(success.auxiliaryCharges ?? []).toEqual([]);
    expect(success.smartModelRan).toBeUndefined();
  });

  it('leaves the answer params untouched when the resolved candidate is not reasoning-capable', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta(`${CHEAP}\nhigh`), finish(0.001, 'gen-cls')],
      },
      requests
    );
    let calls = 0;
    const twoPhase: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        calls += 1;
        if (calls === 1) return provider.infer(request, requestDescriptor, options);
        requests.push(request);
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          for (const event of CHEAP_ANSWER) yield event;
        })();
      },
    };
    const execution = createSmartModelExecution(
      makeDeps(twoPhase, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );
    const node = smartNode({
      classify: { model: true, effort: true },
      params: { maxOutputTokens: ANSWER_CAP },
    });

    await execution.run(node, ['prompt'], makeCtx([]));

    const answer = requests.at(-1);
    expect(answer?.model).toBe(CHEAP);
    expect(answer?.parameters['reasoning']).toBeUndefined();
    expect(answer?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
  });

  it('runs reasoning-free when the node carries no completion cap (G2: no cap, no budget wire)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta('high'), finish(0.001, 'gen-cls')],
        [HARD]: HARD_ANSWER,
      },
      requests
    );
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));
    const node = pinnedAutoNode({ params: {} });

    await execution.run(node, ['prompt'], makeCtx([]));

    expect(requests[1]?.parameters['reasoning']).toBeUndefined();
  });

  it('steps the classified level down when its budget cannot fit the built completion cap', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta('high'), finish(0.001, 'gen-cls')],
        [HARD]: HARD_ANSWER,
      },
      requests
    );
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));
    // A cap with no headroom above the high budget: the nearest feasible
    // offered level below (medium) wins; the cap itself never grows.
    const node = pinnedAutoNode({
      params: { maxOutputTokens: REASONING_BUDGET_TOKENS_BY_EFFORT.high },
    });

    await execution.run(node, ['prompt'], makeCtx([]));

    expect(requests[1]?.parameters['reasoning']).toEqual({ effort: 'medium' });
    expect(requests[1]?.parameters['maxOutputTokens']).toBe(REASONING_BUDGET_TOKENS_BY_EFFORT.high);
  });

  it('short-circuits with NO classifier call when only the model dimension is declared on a single candidate', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));
    const node = smartNode({
      candidates: [{ id: HARD }],
      classify: { model: true, effort: false },
    });

    const result = await execution.run(node, ['prompt'], makeCtx([]));

    expect(requests).toHaveLength(1);
    expect(result._unsafeUnwrap().smartModelRan).toBe(true);
  });

  it('serializes the answer value with streamed reasoning intact (same-field doctrine untouched)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel(
      {
        [CHEAP]: [textDelta('low'), finish(0.001, 'gen-cls')],
        [HARD]: [
          { kind: 'reasoning-delta', index: 0, content: 'thinking…' },
          textDelta('the answer'),
          finish(0.004, 'gen-hard'),
        ],
      },
      requests
    );
    const execution = createSmartModelExecution(pinnedAutoDeps(provider));

    const result = await execution.run(pinnedAutoNode(), ['prompt'], makeCtx([]));
    expect(result._unsafeUnwrap().value).toBe(serializeReasoningText('thinking…', 'the answer'));
  });
});

describe('createSmartModelExecution — hard-off wire ("none" composite turn)', () => {
  /** A hard-off node: the 'none' build stamps the off wire into the params. */
  function hardOffNode(): Extract<Node, { type: 'smartModel' }> {
    return smartNode({
      params: { maxOutputTokens: ANSWER_CAP, reasoning: { enabled: false } },
    });
  }

  it('sends the explicit off wire to a reasoning-capable non-mandatory resolved candidate', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(
      makeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, reasoningBinding(HARD)],
        ]),
      })
    );

    await execution.run(hardOffNode(), ['prompt'], makeCtx([]));

    // Hard off, never parameter omission — and the cap stays plain-turn sized.
    expect(requests[1]?.model).toBe(HARD);
    expect(requests[1]?.parameters['reasoning']).toEqual({ enabled: false });
    expect(requests[1]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
  });

  it('strips the off wire when the resolved candidate has MANDATORY reasoning (cannot disable)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const mandatory: ModelBinding = {
      ...reasoningBinding(HARD),
      descriptor: {
        ...reasoningBinding(HARD).descriptor,
        reasoning: { supportedEfforts: null, mandatory: true },
      },
    };
    const execution = createSmartModelExecution(
      makeDeps(provider, {
        candidates: new Map([
          [CHEAP, binding(CHEAP)],
          [HARD, mandatory],
        ]),
      })
    );

    await execution.run(hardOffNode(), ['prompt'], makeCtx([]));

    expect(requests[1]?.model).toBe(HARD);
    expect(requests[1]?.parameters['reasoning']).toBeUndefined();
    expect(requests[1]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
  });

  it('passes a non-off reasoning param through untouched (only the off wire is per-candidate)', async () => {
    const requests: InferenceRequest[] = [];
    const provider = providerByModel({ [CHEAP]: CLASSIFIER_EVENTS, [HARD]: HARD_ANSWER }, requests);
    const execution = createSmartModelExecution(makeDeps(provider));
    const node = smartNode({
      params: { maxOutputTokens: ANSWER_CAP, reasoning: { effort: 'low' } },
    });

    await execution.run(node, ['prompt'], makeCtx([]));

    expect(requests[1]?.parameters['reasoning']).toEqual({ effort: 'low' });
  });

  it('strips the off wire when the resolved candidate is not reasoning-capable', async () => {
    const requests: InferenceRequest[] = [];
    let calls = 0;
    // The classifier resolves CHEAP (non-reasoning), so both calls hit the
    // same model id — dispatch canned events by call order, not model.
    const twoPhase: ModelProvider = {
      infer: (request) => {
        requests.push(request);
        calls += 1;
        const events = calls === 1 ? [textDelta(CHEAP), finish(0.001, 'gen-cls')] : CHEAP_ANSWER;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          for (const event of events) yield event;
        })();
      },
    };
    const execution = createSmartModelExecution(makeDeps(twoPhase));

    await execution.run(hardOffNode(), ['prompt'], makeCtx([]));

    expect(requests[1]?.model).toBe(CHEAP);
    expect(requests[1]?.parameters['reasoning']).toBeUndefined();
    expect(requests[1]?.parameters['maxOutputTokens']).toBe(ANSWER_CAP);
  });
});

describe('createSmartModelExecution — remaining failure edges', () => {
  it('fails the node when the answer call itself fails', async () => {
    let calls = 0;
    const provider: ModelProvider = {
      infer: (request) => {
        calls += 1;
        return (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          if (calls === 1) {
            for (const event of CLASSIFIER_EVENTS) yield event;
            return;
          }
          throw new InferenceError('upstream_error', `${request.model} down`);
        })();
      },
    };
    const execution = createSmartModelExecution(makeDeps(provider));
    const result = await execution.run(smartNode(), ['prompt'], makeCtx([]));
    expect(result.isErr()).toBe(true);
  });
});
