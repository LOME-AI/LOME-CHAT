import { describe, expect, it, vi } from 'vitest';
import { Node as NodeSchema, mediaTag, optionalTag, textTag } from '@hushbox/shared';
import { usdToNanoUsd } from '../../billing/index.js';
import { err, ok } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { createValueStore } from '../engine/value-store.js';
import { InferenceError } from '../../models/index.js';
import { createModelCallExecution } from './model-call-execution.js';
import type {
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  Modality,
  ModelDescriptor,
  Node,
} from '@hushbox/shared';
import type { ModelProvider } from '../../models/index.js';
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
    fetchedAt: 0,
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

/** Terminal finish, optionally carrying the authoritative inline provider cost. */
function finish(providerCostUsd?: number): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: { inputTokens: 3, outputTokens: 5 },
      finishReason: 'stop',
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
    },
  };
}

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
    });
    expect(emitted).toEqual(events);
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
    });
  });

  it('bills an image generation at the estimate with isEstimated true and never alerts', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: IMAGE },
        finish(), // image carries no inline cost by design
      ]),
      binding: binding({ descriptor: descriptor(['image']) }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({ value: IMAGE, costNanoUsd: 50n, isEstimated: true });
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
    expect(result._unsafeUnwrap()).toEqual({ value: 'x', costNanoUsd: 50n, isEstimated: true });
    expect(telemetry.captureError).toHaveBeenCalledWith(
      expect.any(Error),
      'inference_provider_cost_unavailable'
    );
    expect(telemetry.warn).toHaveBeenCalled();
  });

  it('alerts on a missing cost for a video generation too', async () => {
    const telemetry = fakeTelemetry();
    const exec = runExec({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'v' }, finish()]),
      binding: binding({ descriptor: descriptor(['video']) }),
      schemas,
      telemetry,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().isEstimated).toBe(true);
    expect(telemetry.captureError).toHaveBeenCalledOnce();
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
    expect(result._unsafeUnwrap()).toEqual({
      value: '',
      costNanoUsd: usdToNanoUsd(0.000_003),
      isEstimated: false,
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
    expect(result._unsafeUnwrap()).toEqual({ value: 'x', costNanoUsd: 0n, isEstimated: true });
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
    expect(result._unsafeUnwrap()).toEqual({ value: 'x', costNanoUsd: 50n, isEstimated: true });
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
    expect(result._unsafeUnwrap()).toEqual({ value: 'x', costNanoUsd: 50n, isEstimated: true });
    expect(telemetry.captureError).toHaveBeenCalledOnce();
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
});
