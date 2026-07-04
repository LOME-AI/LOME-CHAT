import { describe, expect, it, vi } from 'vitest';
import { Node as NodeSchema, mediaTag, optionalTag, textTag } from '@hushbox/shared';
import { err, ok } from '../../../lib/result/index.js';
import { validationError } from '../../../lib/errors/index.js';
import { createValueStore } from '../engine/value-store.js';
import { InferenceError } from '../../models/index.js';
import { createModelCallExecution } from './model-call-execution.js';
import type {
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
  Node,
} from '@hushbox/shared';
import type { ModelProvider } from '../../models/index.js';
import type { NodeRunContext } from '../engine/execution-registry.js';
import type { ModelBinding } from './model-call-execution.js';

function descriptor(): ModelDescriptor {
  return {
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
    fetchedAt: 0,
  };
}

function binding(): ModelBinding {
  return {
    descriptor: descriptor(),
    ports: { in: [textTag()], out: textTag() },
    price: () => ok(50n),
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

const FINISH: InferenceEvent = {
  kind: 'finish',
  metadata: { usage: { inputTokens: 3, outputTokens: 5 }, finishReason: 'stop' },
};

describe('createModelCallExecution', () => {
  it('is a streaming execution', () => {
    const exec = createModelCallExecution({ provider: streamOf([]), binding: binding(), schemas });
    expect(exec.streaming).toBe(true);
  });

  it('streams text deltas through emit and resolves the concatenated priced value', async () => {
    const emitted: InferenceEvent[] = [];
    const events: InferenceEvent[] = [
      { kind: 'text-delta', index: 0, content: 'he' },
      { kind: 'text-delta', index: 1, content: 'llo' },
      FINISH,
    ];
    const exec = createModelCallExecution({
      provider: streamOf(events),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(
      modelCallNode(),
      ['hi'],
      makeCtx((event) => emitted.push(event))
    );
    expect(result._unsafeUnwrap()).toEqual({ value: 'hello', costNanoUsd: 50n });
    expect(emitted).toEqual(events);
  });

  it('resolves the concatenated value without a client stream when emit is absent', async () => {
    const exec = createModelCallExecution({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'quiet' }, FINISH]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toBe('quiet');
  });

  it('prices zero when the stream carries no terminal usage', async () => {
    const exec = createModelCallExecution({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap()).toEqual({ value: 'x', costNanoUsd: 0n });
  });

  it('resolves a media value when the model emits a media-done part', async () => {
    const media: MediaValue = {
      ref: 'media/x/y/z',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 4,
      metadata: {},
    };
    const exec = createModelCallExecution({
      provider: streamOf([
        { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
        { kind: 'media-done', index: 0, value: media },
        FINISH,
      ]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result._unsafeUnwrap().value).toEqual(media);
  });

  it('re-validates the resolved input against the declared ports', async () => {
    const exec = createModelCallExecution({
      provider: streamOf([FINISH]),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), [42], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('returns a node failure on a thrown InferenceError', async () => {
    const exec = createModelCallExecution({
      provider: throwingProvider(new InferenceError('rate_limited', 'slow down')),
      binding: binding(),
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('rethrows an unexpected error so the interpreter contains it as a defect', async () => {
    const exec = createModelCallExecution({
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
        return streamOf([{ kind: 'text-delta', index: 0, content: 'seen' }, FINISH]).infer(
          request,
          descriptor()
        );
      },
    };
    const mediaBinding = {
      descriptor: { ...descriptor(), inputs: ['image' as const] },
      ports: { in: [mediaTag('image', ['image/png'])], out: textTag() },
      price: () => ok(0n),
    };
    const exec = createModelCallExecution({ provider, binding: mediaBinding, schemas });
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
    const exec = createModelCallExecution({
      provider: streamOf([FINISH]),
      binding: optionalBinding,
      schemas,
    });
    const result = await exec.run(modelCallNode(), [undefined], makeCtx());
    expect(result.isErr()).toBe(true);
  });

  it('returns a node failure when pricing the observed usage fails', async () => {
    const exec = createModelCallExecution({
      provider: streamOf([{ kind: 'text-delta', index: 0, content: 'x' }, FINISH]),
      binding: { ...binding(), price: () => err(validationError('no rate')) },
      schemas,
    });
    const result = await exec.run(modelCallNode(), ['hi'], makeCtx());
    expect(result.isErr()).toBe(true);
  });
});

const schemas = { resolveSchema: vi.fn() };
