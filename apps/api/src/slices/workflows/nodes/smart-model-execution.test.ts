import { describe, expect, it, vi } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  Node as NodeSchema,
  textTag,
} from '@hushbox/shared';
import { usdToNanoUsd } from '../../billing/index.js';
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
    usdToNanoUsd,
    ...overrides,
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
    expect(success.costNanoUsd).toBe(usdToNanoUsd(0.004));
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
        baseCostNanoUsd: usdToNanoUsd(0.001),
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
      `accrue:${String(usdToNanoUsd(0.001))}`,
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
