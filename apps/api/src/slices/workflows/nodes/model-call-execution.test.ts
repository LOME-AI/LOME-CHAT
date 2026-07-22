import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ERROR_CODES,
  Node as NodeSchema,
  mediaTag,
  optionalTag,
  serializeReasoningText,
  textTag,
} from '@hushbox/shared';
import { usdToNanoUsd } from '../../billing/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { createValueStore } from '../engine/value-store.js';
import { InferenceError } from '../../models/index.js';
import { createModelCallExecution } from './model-call-execution.js';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  Modality,
  ModelDescriptor,
  Node,
} from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../../models/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { NodeRunContext } from '../engine/execution-registry.js';
import type { ModelBinding } from './model-call-execution.js';

function descriptor(outputs: readonly Modality[] = ['text']): ModelDescriptor {
  return {
    id: 'answer-model',
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: [...outputs],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

/** A video descriptor declaring a discrete supported-duration set (the per-model
 * `durationSeconds` enum ParamSpec the duration pre-flight enforces). */
function videoDescriptorWithDurations(values: readonly number[]): ModelDescriptor {
  return {
    ...descriptor(['video']),
    parameters: { durationSeconds: { type: 'enum', values: [...values], wire: 'providerOptions' } },
  };
}

function binding(overrides: Partial<ModelBinding> = {}): ModelBinding {
  return {
    descriptor: descriptor(),
    ports: { in: [textTag()], out: textTag() },
    price: () => ok(50n),
    ...overrides,
  };
}

function modelCallNode(): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params: {},
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

/** A modelCall node carrying the given request parameters (the media/token
 * extractor reads these off the resolved InferenceRequest). */
function modelCallNodeWithParams(
  params: Record<string, unknown>
): Extract<Node, { type: 'modelCall' }> {
  return NodeSchema.parse({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params,
    in: { node: 'input', port: 'prompt' },
  }) as Extract<Node, { type: 'modelCall' }>;
}

/**
 * Terminal finish, optionally carrying the authoritative inline provider cost
 * and the terminal gateway generation id.
 */
function finish(providerCostUsd?: number, generationId?: string): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: { inputTokens: 3, outputTokens: 5 },
      finishReason: 'stop',
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
      ...(generationId === undefined ? {} : { generationId }),
    },
  };
}

/**
 * The billing facts a text `answer-model` generation carries up for settlement,
 * including the token dimension the finish's usage reports (3 in, 5 out; no
 * reasoning/cached).
 */
const TEXT_BILLING = {
  modelId: 'answer-model',
  providerName: 'p',
  modality: 'text',
  tokens: { inputTokens: 3, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
} as const;

/**
 * The billing facts when no terminal usage was observed (a finish-less stream or
 * an aborted partial): no token dimension is invented, so the charge carries no
 * `tokens`.
 */
const TEXT_BILLING_NO_TOKENS = {
  modelId: 'answer-model',
  providerName: 'p',
  modality: 'text',
} as const;

function stepFinish(step: number, providerCostUsd?: number): InferenceEvent {
  return {
    kind: 'step-finish',
    step,
    generationId: `gen-${String(step)}`,
    ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
  };
}

function streamOf(events: readonly InferenceEvent[]): ModelProvider {
  return {
    infer: () =>
      (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        for (const event of events) yield event;
      })(),
  };
}

/** Streams the given events while capturing each InferenceRequest it receives. */
function capturingProvider(
  events: readonly InferenceEvent[],
  requests: InferenceRequest[]
): ModelProvider {
  const inner = streamOf(events);
  return {
    infer: (request, requestDescriptor, options) => {
      requests.push(request);
      return inner.infer(request, requestDescriptor, options);
    },
  };
}

/** Streams the given events, then throws — the shape of a mid-stream failure. */
function throwingAfterProvider(events: readonly InferenceEvent[], thrown: Error): ModelProvider {
  return {
    infer: () =>
      (async function* stream(): AsyncGenerator<InferenceEvent> {
        await Promise.resolve();
        for (const event of events) yield event;
        throw thrown;
      })(),
  };
}

/** A stop/deadline abort surfaces as the adapters' InferenceError code 'aborted'. */
function abortError(): InferenceError {
  return new InferenceError('aborted', 'Inference aborted: user stop');
}

function throwingProvider(thrown: Error): ModelProvider {
  return {
    infer: (): AsyncIterable<InferenceEvent> => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<InferenceEvent>> => Promise.reject(thrown),
      }),
    }),
  };
}

function makeCtx(emit?: (event: InferenceEvent) => void): NodeRunContext {
  return {
    values: createValueStore(1_000_000),
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
    ...(emit === undefined ? {} : { emit }),
  };
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

const schemas = { resolveSchema: vi.fn() };
const IMAGE: MediaValue = {
  ref: 'media/x/y/z',
  mimeType: 'image/png',
  modality: 'image',
  byteLength: 4,
  metadata: {},
};
const VIDEO: MediaValue = {
  ref: 'media/v',
  mimeType: 'video/mp4',
  modality: 'video',
  byteLength: 4,
  metadata: {},
};

/** Wires the real (injected) money conversion so tests read like production. */
function runExec(
  deps: Omit<Parameters<typeof createModelCallExecution>[0], 'usdToNanoUsd'>
): ReturnType<typeof createModelCallExecution> {
  return createModelCallExecution({ usdToNanoUsd, ...deps });
}

describe('createModelCallExecution', () => {
  it('is a streaming execution', () => {
    const exec = runExec({ provider: streamOf([]), binding: binding(), schemas });
    expect(exec.streaming).toBe(true);
  });

  it('charges the authoritative inline provider cost for text with isEstimated false', async () => {
    const emitted: InferenceEvent[] = [];
    const events: InferenceEvent[] = [
      { kind: 'text-delta', index: 0, content: 'he' },
      { kind: 'text-delta', index: 1, content: 'llo' },
      finish(0.000_001),
    ];
    const exec = runExec({
      provider: streamOf(events),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    // 0.000001 USD → 1000 nano base; the fake estimate (50n) is not consulted.
    expect(result._unsafeUnwrap()).toEqual({
      value: 'hello',
      costNanoUsd: usdToNanoUsd(0.000_001),
      isEstimated: false,
      billing: TEXT_BILLING,
    });
    expect(emitted).toEqual([{ kind: 'stream-start', modelId: 'answer-model' }, ...events]);
  });

  it('emits stream-start with the request model as the FIRST event of a streaming call', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'hello' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted[0]).toEqual({ kind: 'stream-start', modelId: 'answer-model' });
    // The label is stream metadata only: the accumulated value, cost, and
    // billing facts are identical to an unlabeled stream.
    expect(result._unsafeUnwrap()).toEqual({
      value: 'hello',
      costNanoUsd: usdToNanoUsd(0.000_001),
      isEstimated: false,
      billing: TEXT_BILLING,
    });
  });

  it('labels a media stream too — stream-start precedes media-start', async () => {
    const emitted: InferenceEvent[] = [];
    const events: InferenceEvent[] = [
      { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
      { kind: 'media-done', index: 0, value: IMAGE },
      finish(),
    ];
    const exec = runExec({
      provider: streamOf(events),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted).toEqual([
      { kind: 'stream-start', modelId: 'answer-model', outputModality: 'image' },
      ...events,
    ]);
  });

  it('labels a media stream-start with its output modality (the early tile signal)', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: IMAGE }, finish()]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
    });
    await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted[0]).toEqual({
      kind: 'stream-start',
      modelId: 'answer-model',
      outputModality: 'video',
    });
  });

  it('omits outputModality on a text stream-start (only media families carry it)', async () => {
    const emitted: InferenceEvent[] = [];
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'hello' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(emitted[0]).toEqual({ kind: 'stream-start', modelId: 'answer-model' });
  });

  it('never accumulates a provider-yielded stream-start into the resolved text', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'stream-start', modelId: 'answer-model' },
        { kind: 'text-delta', index: 0, content: 'clean' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('clean');
  });

  it('resolves the concatenated value without a client stream when emit is absent', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'quiet' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('quiet');
    expect(result._unsafeUnwrap().isEstimated).toBe(false);
  });

  it('charges the inline provider cost for a video generation with isEstimated false', async () => {
    const video: MediaValue = {
      ...IMAGE,
      ref: 'media/v',
      mimeType: 'video/mp4',
      modality: 'video',
    };
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'video', mimeType: 'video/mp4' },
        { kind: 'media-done', index: 0, value: video },
        finish(0.000_002),
      ]),
      binding: binding({ descriptor: descriptor(['video']) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: video,
      costNanoUsd: usdToNanoUsd(0.000_002),
      isEstimated: false,
      billing: { modelId: 'answer-model', providerName: 'p', modality: 'video' },
    });
  });

  it('bills an image generation at the deterministic media estimate with isEstimated true and never alerts', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(), // image carries no inline cost by design
      ]),
      binding: binding({
        descriptor: descriptor(['image']),
        // The token pricer must never be consulted for media: the finish's
        // token-only usage is unpriceable for an image model.
        price: () => err(validationError('image pricing is not token-priced')),
        priceMedia: () => ok(50n),
      }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: IMAGE,
      costNanoUsd: 50n,
      isEstimated: true,
      // Image always records a count dimension (defaults to 1) for media_generations.
      billing: {
        modelId: 'answer-model',
        providerName: 'p',
        modality: 'image',
        media: { imageCount: 1 },
      },
    });
    expect(telemetry.captureError).not.toHaveBeenCalled();
    expect(telemetry.warn).not.toHaveBeenCalled();
  });

  it('falls back to the estimate and alerts when a text finish carries no inline cost', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish()]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 50n,
      isEstimated: true,
      billing: TEXT_BILLING,
    });
    expect(telemetry.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'inference_provider_cost_unavailable'
    );
    expect(telemetry.warn).toHaveBeenCalled();
  });

  it('alerts and falls back to the deterministic media estimate on a missing video cost', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'v' }, finish()]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().costNanoUsd).toBe(70n);
    expect(result._unsafeUnwrap().isEstimated).toBe(true);
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('bounds a video inline cost against the deterministic media estimate, not the token estimate', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      // 1000 USD is far beyond 1000× the 70n media estimate — clearly corrupt.
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'v' }, finish(1000)]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 70n, isEstimated: true });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('fails the node closed when a media-family binding carries no media pricer', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('threads the node params into the media pricer', async () => {
    const priceMedia = vi.fn(() => ok(50n));
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia }),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(priceMedia).toHaveBeenCalledWith({});
  });

  it('uses the terminal summed cost for an agentic multi-step run', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'step-start', step: 0 },
        stepFinish(0, 0.000_001),
        { kind: 'step-start', step: 1 },
        stepFinish(1, 0.000_002),
        finish(0.000_003), // adapter already sums per-step costs onto the terminal finish
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    // The terminal generation id is the final step's (the finish carries none).
    expect(result._unsafeUnwrap()).toEqual({
      value: '',
      costNanoUsd: usdToNanoUsd(0.000_003),
      isEstimated: false,
      billing: { ...TEXT_BILLING, generationId: 'gen-1' },
    });
  });

  it('sums the per-step costs, skipping steps that carry none, when the terminal omits it', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'a' },
        stepFinish(0, 0.000_001),
        stepFinish(1), // a step with no cost is skipped in the sum
        stepFinish(2, 0.000_002),
        finish(), // no terminal cost — fall back to the per-step sum
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'a',
      costNanoUsd: usdToNanoUsd(0.000_003),
      isEstimated: false,
      billing: { ...TEXT_BILLING, generationId: 'gen-2' },
    });
  });

  it('bills the estimate and alerts when the stream carries no terminal finish at all', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      // No finish → no observed usage → the estimate is 0n (a legal no-charge).
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 0n,
      isEstimated: true,
      billing: TEXT_BILLING_NO_TOKENS,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('rejects a negative provider cost to the estimate and alerts', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish(-5)]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 50n,
      isEstimated: true,
      billing: TEXT_BILLING,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('rejects an absurd provider cost to the estimate and alerts', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      // 1000 USD is far more than 1000× the 50n base estimate — clearly corrupt.
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish(1000)]),
      binding: binding(),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'x',
      costNanoUsd: 50n,
      isEstimated: true,
      billing: TEXT_BILLING,
    });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
  });

  it('captures the terminal generationId from the finish metadata', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'x' },
        finish(0.000_001, 'gen-final'),
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().billing).toEqual({ ...TEXT_BILLING, generationId: 'gen-final' });
  });

  it('prefers the finish generationId over the last step-finish id', async () => {
    const exec = runExec({
      provider: streamOf([stepFinish(0, 0.000_001), finish(0.000_001, 'gen-terminal')]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().billing?.generationId).toBe('gen-terminal');
  });

  it('re-validates the resolved input against the declared ports', async () => {
    const exec = runExec({
      provider: streamOf([finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), [42], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('returns a node failure on a thrown InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('rate_limited', 'slow down')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('carries no wire reason for a generic InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('rate_limited', 'slow down')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr().reason).toBeUndefined();
  });

  it('carries the CONTENT_POLICY wire reason for a content-policy InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('content_policy', 'refused')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr().reason).toBe(ERROR_CODES.CONTENT_POLICY);
  });

  it('carries the NO_REASONING_ENDPOINTS wire reason for a no-reasoning-endpoints InferenceError', async () => {
    const exec = runExec({
      provider: throwingProvider(new InferenceError('no_reasoning_endpoints', 'no endpoints')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrapErr().reason).toBe(ERROR_CODES.NO_REASONING_ENDPOINTS);
  });

  it('rethrows an unexpected error so the interpreter contains it as a defect', async () => {
    const exec = runExec({
      provider: throwingProvider(new Error('boom')),
      binding: binding(),
      schemas,
    });
    await expect(exec.run(modelCallNode(), ['hi'], makeCtx())).rejects.toThrow('boom');
  });

  it('builds a media input part when the model accepts media', async () => {
    const media: MediaValue = {
      ref: 'inputs/r/x',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 3,
      metadata: {},
    };
    const captured: InferenceRequest[] = [];
    const provider = {
      infer: (request: InferenceRequest) => {
        captured.push(request);
        return streamOf([
          { kind: 'text-delta', index: 0, content: 'seen' },
          finish(0.000_001),
        ]).infer(request, descriptor());
      },
    };
    const mediaBinding: ModelBinding = {
      descriptor: { ...descriptor(), inputs: ['image' as const] },
      ports: { in: [mediaTag('image', ['image/png'])], out: textTag() },
      price: () => ok(0n),
    };
    const exec = runExec({ provider, binding: mediaBinding, schemas });
    const result = await exec.run(modelCallNode(), [media], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('seen');
    expect(captured[0]?.inputs[0]).toEqual({
      modality: 'image',
      ref: { ref: 'inputs/r/x', mimeType: 'image/png', byteLength: 3 },
    });
  });

  it('fails when the resolved input cannot map to an inference input part', async () => {
    const optionalBinding = {
      ...binding(),
      ports: { in: [optionalTag(textTag())], out: textTag() },
    };
    const exec = runExec({
      provider: streamOf([finish(0.000_001)]),
      binding: optionalBinding,
      schemas,
    });
    const result = await exec.run(modelCallNode(), [undefined], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('returns a node failure when pricing the observed usage fails on the estimate path', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, finish()]),
      binding: binding({ price: () => err(validationError('no rate')) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('rejects an out-of-set video duration at pre-flight with UNSUPPORTED_DURATION, before the provider call', async () => {
    const exec = runExec({
      provider: throwingProvider(
        new Error('provider must not be called for an out-of-set duration')
      ),
      binding: binding({
        descriptor: videoDescriptorWithDurations([4, 8]),
        priceMedia: () => ok(70n),
      }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 5, resolution: '720p' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrapErr()).toEqual({ reason: ERROR_CODES.UNSUPPORTED_DURATION });
  });

  it('accepts an in-set numeric video duration and runs the generation', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: VIDEO }, finish(0.000_002)]),
      binding: binding({
        descriptor: videoDescriptorWithDurations([4, 8]),
        priceMedia: () => ok(70n),
      }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 8, resolution: '720p' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrap().value).toEqual(VIDEO);
  });

  it('accepts any duration for a video model that declares no discrete duration set (escape hatch)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: VIDEO }, finish(0.000_002)]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 5 }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });

  it('accepts any duration for a video model whose durationSeconds enum declares no values (degenerate spec)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: VIDEO }, finish(0.000_002)]),
      binding: binding({
        descriptor: {
          ...descriptor(['video']),
          parameters: { durationSeconds: { type: 'enum', wire: 'providerOptions' } },
        },
        priceMedia: () => ok(70n),
      }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 5 }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });

  it('does not gate a language call carrying generation params (the duration pre-flight is video-only)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'hi' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ maxOutputTokens: 100 }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });

  it('does not gate an image call carrying generation params (the duration pre-flight is video-only)', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'media-done', index: 0, value: IMAGE }, finish()]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ aspectRatio: '1:1' }),
      ['hi'],
      makeCtx()
    );
    expect(result.isOk()).toBe(true);
  });
});

describe('createModelCallExecution — run-scoped history', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'first answer' },
  ];

  it('threads the context history onto the inference request', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), history: HISTORY });
    expect(requests[0]?.history).toEqual(HISTORY);
  });

  it('omits history from the request when the context carries none', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(requests[0]).not.toHaveProperty('history');
  });

  it('omits history from the request when the context history is empty', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), history: [] });
    expect(requests[0]).not.toHaveProperty('history');
  });
});

describe('createModelCallExecution — run-scoped custom instructions', () => {
  it('threads the context custom instructions onto the inference request', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNodeWithParams({ maxOutputTokens: 100 }), ['hi'], {
      ...makeCtx(),
      customInstructions: 'answer in haiku',
    });
    // Reaches the dedicated request field the language adapter folds into the
    // system prompt, sourced from the run-scoped ctx (never the node params)...
    expect(requests[0]?.customInstructions).toBe('answer in haiku');
    // ...and the node params pass through as the provider call parameters,
    // never carrying the instructions.
    expect(requests[0]?.parameters).toEqual({ maxOutputTokens: 100 });
  });

  it('omits custom instructions from the request when the context carries none', async () => {
    const requests: InferenceRequest[] = [];
    const exec = runExec({
      provider: capturingProvider([finish(0.000_001)], requests),
      binding: binding(),
      schemas,
    });
    await exec.run(modelCallNodeWithParams({ maxOutputTokens: 100 }), ['hi'], makeCtx());
    expect(requests[0]).not.toHaveProperty('customInstructions');
    // The parameters pass through unchanged — no behavior change when absent.
    expect(requests[0]?.parameters).toEqual({ maxOutputTokens: 100 });
  });
});

describe('createModelCallExecution — tool loop', () => {
  const toolLoop = {
    registry: {
      webSearch: {
        description: 'search',
        inputSchema: z.object({}),
        execute: () => Promise.resolve(),
        providerTool: { kind: 'web-search' as const, args: { engine: 'perplexity' } },
      },
    },
    maxSteps: 10,
  };

  it('passes the injected tool loop to the provider on the infer call', async () => {
    const seen: unknown[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        seen.push(options?.tools);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas, tools: toolLoop });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(seen[0]).toBe(toolLoop);
  });

  it('omits tools from the infer options when no tool loop is injected', async () => {
    const seen: unknown[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        seen.push(options?.tools);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(seen[0]).toBeUndefined();
  });
});

describe('createModelCallExecution — file-part mapper forwarding', () => {
  it('forwards the injected mapFilePart to the provider on the infer call', async () => {
    const mapper: FilePartMapper = () => {
      throw new Error('opaque: the node must never invoke the mapper');
    };
    const seen: unknown[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        seen.push(options?.mapFilePart);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas });
    await exec.run(modelCallNode(), ['hi'], { ...makeCtx(), mapFilePart: mapper });
    expect(seen[0]).toBe(mapper);
  });

  it('omits mapFilePart from the infer options when the context carries none', async () => {
    const seen: object[] = [];
    const provider: ModelProvider = {
      infer: (request, requestDescriptor, options) => {
        if (options !== undefined) seen.push(options);
        return streamOf([finish(0.000_001)]).infer(request, requestDescriptor, options);
      },
    };
    const exec = runExec({ provider, binding: binding(), schemas });
    await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect('mapFilePart' in (seen[0] ?? {})).toBe(false);
  });
});

describe('createModelCallExecution — stop/deadline abort settles the streamed partial', () => {
  it('resolves the accumulated text on abort, zero-cost estimated when no cost was observed', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'text-delta', index: 0, content: 'par' },
          { kind: 'text-delta', index: 1, content: 'tial' },
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'partial',
      costNanoUsd: 0n,
      isEstimated: true,
      billing: TEXT_BILLING_NO_TOKENS,
    });
  });

  it('prefers accumulated media over text on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'text-delta', index: 0, content: 'caption' },
          { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
          { kind: 'media-done', index: 0, value: IMAGE },
        ],
        abortError()
      ),
      binding: binding({ descriptor: descriptor(['image']) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toEqual(IMAGE);
  });

  it('fails the node on abort when nothing accumulated (empty stop bills nothing)', async () => {
    const exec = runExec({
      provider: throwingAfterProvider([], abortError()),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('bills the completed-step inline cost exactly on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'text-delta', index: 0, content: 'a' }, stepFinish(0, 0.000_001)],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({
      value: 'a',
      costNanoUsd: usdToNanoUsd(0.000_001),
      isEstimated: false,
      billing: { ...TEXT_BILLING_NO_TOKENS, generationId: 'gen-0' },
    });
  });

  it('bills the deterministic media estimate when a completed artifact aborts with no inline cost', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
          { kind: 'media-done', index: 0, value: IMAGE },
        ],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => ok(40_000_000n),
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      value: IMAGE,
      costNanoUsd: 40_000_000n,
      isEstimated: true,
    });
  });

  it('prefers the inline step cost over the media estimate on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'media-done', index: 0, value: IMAGE }, stepFinish(0, 0.000_001)],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => ok(40_000_000n),
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({
      costNanoUsd: usdToNanoUsd(0.000_001),
      isEstimated: false,
    });
  });

  it('falls back to zero estimated when the media estimate itself fails on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'media-done', index: 0, value: IMAGE }],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
        priceMedia: () => err(validationError('unpriced')),
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 0n, isEstimated: true });
  });

  it('keeps zero estimated for a media abort when the binding carries no media pricer', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'media-done', index: 0, value: IMAGE }],
        abortError()
      ),
      binding: binding({
        descriptor: descriptor(['image']),
        ports: { in: [textTag()], out: mediaTag('image', ['image/png']) },
      }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 0n, isEstimated: true });
  });

  it('treats an invalid (negative) accumulated cost as unobserved on abort', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'text-delta', index: 0, content: 'a' }, stepFinish(0, -1)],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toMatchObject({ costNanoUsd: 0n, isEstimated: true });
  });

  it('still fails the node on a non-abort InferenceError even with accumulated text', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'text-delta', index: 0, content: 'a' }],
        new InferenceError('rate_limited', 'slow down')
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });
});

describe('createModelCallExecution — billing dimension extraction', () => {
  it('extracts image media facts (n → imageCount, size → resolution) from the request params', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(), // image carries no inline cost by design
      ]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ n: 2, size: '1024x1024' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrap().billing).toEqual({
      modelId: 'answer-model',
      providerName: 'p',
      modality: 'image',
      media: { imageCount: 2, resolution: '1024x1024' },
    });
  });

  it('extracts video media facts, converting durationSeconds → durationMs exactly (×1000)', async () => {
    const video: MediaValue = {
      ...IMAGE,
      ref: 'media/v',
      mimeType: 'video/mp4',
      modality: 'video',
    };
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'video', mimeType: 'video/mp4' },
        { kind: 'media-done', index: 0, value: video },
        finish(0.000_002),
      ]),
      binding: binding({ descriptor: descriptor(['video']), priceMedia: () => ok(70n) }),
      schemas,
    });
    const result = await exec.run(
      modelCallNodeWithParams({ durationSeconds: 8, resolution: '720p' }),
      ['hi'],
      makeCtx()
    );
    expect(result._unsafeUnwrap().billing).toEqual({
      modelId: 'answer-model',
      providerName: 'p',
      modality: 'video',
      media: { durationMs: 8000, resolution: '720p' },
    });
  });

  it('populates the language token facts from the terminal usage (reasoning/cached counts carried through)', async () => {
    const richFinish: InferenceEvent = {
      kind: 'finish',
      metadata: {
        usage: { inputTokens: 7, outputTokens: 11, reasoningTokens: 4, cachedInputTokens: 2 },
        finishReason: 'stop',
        providerCostUsd: 0.000_001,
      },
    };
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, richFinish]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().billing?.tokens).toEqual({
      inputTokens: 7,
      outputTokens: 11,
      reasoningTokens: 4,
      cachedInputTokens: 2,
    });
  });
});

/** Streams the events while capturing the InferOptions each `infer` receives. */
function optionsCapturingProvider(
  events: readonly InferenceEvent[],
  sink: { options?: InferOptions | undefined }
): ModelProvider {
  return {
    infer: (request, requestDescriptor, options) => {
      sink.options = options;
      return streamOf(events).infer(request, requestDescriptor, options);
    },
  };
}

function ctxWithStore(store: ReturnType<typeof createValueStore>): NodeRunContext {
  return {
    values: store,
    clock: { now: () => 0 },
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
  };
}

describe('createModelCallExecution — download byte cap threading', () => {
  it('threads the full remaining ValueStore budget to the provider as the download byte cap', async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding(),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], ctxWithStore(createValueStore(1000)));

    expect(sink.options?.downloadByteCap).toBe(1000);
  });

  it('lowers the download byte cap by the bytes the ValueStore has already consumed', async () => {
    const sink: { options?: InferOptions | undefined } = {};
    const store = createValueStore(1000);
    // A stored 100-char string meters at length×2 = 200 bytes.
    const seeded = store.store('x'.repeat(100));
    expect(seeded.isOk()).toBe(true);
    const exec = runExec({
      provider: optionsCapturingProvider([finish(0.000_001)], sink),
      binding: binding(),
      schemas,
    });

    await exec.run(modelCallNode(), ['hi'], ctxWithStore(store));

    expect(sink.options?.downloadByteCap).toBe(800);
  });
});

describe('createModelCallExecution — streamed reasoning persists in the resolved value', () => {
  it('embeds accumulated reasoning ahead of the answer in the canonical inline format', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'reasoning-delta', index: 0, content: 'step one, ' },
        { kind: 'reasoning-delta', index: 0, content: 'step two' },
        { kind: 'text-delta', index: 0, content: 'the ' },
        { kind: 'text-delta', index: 1, content: 'answer' },
        finish(0.000_001),
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe(
      serializeReasoningText('step one, step two', 'the answer')
    );
  });

  it('resolves the answer verbatim when no reasoning text streamed', async () => {
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'plain' }, finish(0.000_001)]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('plain');
  });

  it('resolves the answer verbatim when reasoning arrives as token counts only (o-series)', async () => {
    // Hidden-reasoning models report reasoningTokens on the terminal usage but
    // stream no reasoning text: the persisted value is the answer alone.
    const exec = runExec({
      provider: streamOf([
        { kind: 'text-delta', index: 0, content: 'the answer' },
        {
          kind: 'finish',
          metadata: {
            usage: { inputTokens: 3, outputTokens: 5, reasoningTokens: 7 },
            finishReason: 'stop',
            providerCostUsd: 0.000_001,
          },
        },
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('the answer');
    expect(result._unsafeUnwrap().billing?.tokens?.reasoningTokens).toBe(7);
  });

  it('settles a reasoning-only aborted partial as billable content', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [{ kind: 'reasoning-delta', index: 0, content: 'thoughts so far' }],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe(serializeReasoningText('thoughts so far', ''));
  });

  it('embeds reasoning into an aborted partial that streamed both reasoning and text', async () => {
    const exec = runExec({
      provider: throwingAfterProvider(
        [
          { kind: 'reasoning-delta', index: 0, content: 'thoughts' },
          { kind: 'text-delta', index: 0, content: 'par' },
          { kind: 'text-delta', index: 1, content: 'tial' },
        ],
        abortError()
      ),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe(serializeReasoningText('thoughts', 'partial'));
  });

  it('prefers accumulated media over reasoning-bearing text on a media call', async () => {
    const exec = runExec({
      provider: streamOf([
        { kind: 'reasoning-delta', index: 0, content: 'thoughts' },
        { kind: 'text-delta', index: 0, content: 'caption' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(),
      ]),
      binding: binding({ descriptor: descriptor(['image']), priceMedia: () => ok(50n) }),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toEqual(IMAGE);
  });
});
