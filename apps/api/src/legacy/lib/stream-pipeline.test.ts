import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./broadcast.js', () => ({
  broadcastFireAndForget: vi.fn(),
}));

vi.mock('@hushbox/realtime/events', () => ({
  createEvent: vi.fn((type: string, payload: unknown) => ({ type, payload })),
}));

import { createEvent } from '@hushbox/realtime/events';
import { applyFees, computeImageWorstCaseCents } from '@hushbox/shared';
import { broadcastFireAndForget } from './broadcast.js';
import {
  BATCH_INTERVAL_MS,
  lookupModelPricing,
  computeWorstCaseCents,
  derivedIsSmartModel,
  resolveWebSearchCost,
  handleBillingResult,
  withBroadcast,
  broadcastAndFinish,
  resolveAndReserveImageBilling,
  resolveAndReserveVideoBilling,
  resolveAndReserveAudioBilling,
  type BroadcastContext,
} from './stream-pipeline.js';
import type { RawModel as ModelInfo } from '@hushbox/shared/models';
import type { InferenceEvent, InferenceStream } from '../services/ai/index.js';
import type { BuildBillingResult } from '../services/billing/index.js';
import type { AppEnv } from '../types.js';
import type { Context } from 'hono';

const stubUserEnvelope = {
  messageId: 'user-msg-stub',
  wrappedContentKey: new Uint8Array([0, 1, 2, 3]),
  contentItem: {
    id: 'ci-stub',
    contentType: 'text' as const,
    position: 0,
    encryptedBlob: new Uint8Array([9, 9, 9]),
    modelName: null,
    cost: null,
    isSmartModel: false,
  },
};

function makeModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    description: 'A model',
    modality: 'text',
    context_length: 128_000,
    pricing: { prompt: '0.000005', completion: '0.000015' },
    supported_parameters: [],
    created: Date.now(),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    ...overrides,
  };
}

function createMockContext(): {
  c: Parameters<typeof handleBillingResult>[0]['c'];
} {
  return {
    c: {
      executionCtx: {
        waitUntil: vi.fn(),
      },
    } as unknown as Parameters<typeof handleBillingResult>[0]['c'],
  };
}

describe('BATCH_INTERVAL_MS', () => {
  it('equals 100', () => {
    expect(BATCH_INTERVAL_MS).toBe(100);
  });
});

describe('lookupModelPricing', () => {
  it('finds a model by id and returns fee-inclusive per-token prices', () => {
    const models = [makeModelInfo({ id: 'openai/gpt-4o' })];

    const result = lookupModelPricing(models, 'openai/gpt-4o');

    expect(result.inputPricePerToken).toBeCloseTo(applyFees(0.000_005), 15);
    expect(result.outputPricePerToken).toBeCloseTo(applyFees(0.000_015), 15);
    expect(result.contextLength).toBe(128_000);
  });

  it('returns 0 prices and default context when model is not found', () => {
    const models = [makeModelInfo({ id: 'openai/gpt-4o' })];

    const result = lookupModelPricing(models, 'nonexistent/model');

    expect(result.inputPricePerToken).toBe(0);
    expect(result.outputPricePerToken).toBe(0);
    expect(result.contextLength).toBe(128_000);
  });

  it('uses model context_length when found', () => {
    const models = [makeModelInfo({ id: 'anthropic/claude', context_length: 200_000 })];

    const result = lookupModelPricing(models, 'anthropic/claude');

    expect(result.contextLength).toBe(200_000);
  });

  it('falls back to 128_000 context length when model is not found', () => {
    const result = lookupModelPricing([], 'missing/model');

    expect(result.inputPricePerToken).toBe(0);
    expect(result.outputPricePerToken).toBe(0);
    expect(result.contextLength).toBe(128_000);
  });

  it('correctly parses string pricing to fee-inclusive numbers', () => {
    const models = [
      makeModelInfo({
        id: 'test/model',
        pricing: { prompt: '0.00001', completion: '0.00003' },
      }),
    ];

    const result = lookupModelPricing(models, 'test/model');

    expect(result.inputPricePerToken).toBeCloseTo(applyFees(0.000_01), 15);
    expect(result.outputPricePerToken).toBeCloseTo(applyFees(0.000_03), 15);
    expect(result.contextLength).toBe(128_000);
  });

  it('selects the correct model from multiple entries', () => {
    const models = [
      makeModelInfo({ id: 'model/a', pricing: { prompt: '0.001', completion: '0.002' } }),
      makeModelInfo({ id: 'model/b', pricing: { prompt: '0.003', completion: '0.004' } }),
    ];

    const result = lookupModelPricing(models, 'model/b');

    expect(result.inputPricePerToken).toBeCloseTo(applyFees(0.003), 15);
    expect(result.outputPricePerToken).toBeCloseTo(applyFees(0.004), 15);
  });
});

describe('computeWorstCaseCents', () => {
  it('computes (estimatedInputCost + maxOutput * outputCost) * 100', () => {
    // (0.50 + 1000 * 0.001) * 100 = (0.50 + 1.0) * 100 = 150
    const result = computeWorstCaseCents(0.5, 1000, 0.001);
    expect(result).toBe(150);
  });

  it('returns 0 when all inputs are 0', () => {
    expect(computeWorstCaseCents(0, 0, 0)).toBe(0);
  });

  it('handles fractional cents without rounding', () => {
    // (0.001 + 10 * 0.0001) * 100 = (0.001 + 0.001) * 100 = 0.2
    const result = computeWorstCaseCents(0.001, 10, 0.0001);
    expect(result).toBeCloseTo(0.2, 10);
  });

  it('handles large token counts', () => {
    // (1.0 + 1_000_000 * 0.00001) * 100 = (1.0 + 10) * 100 = 1100
    const result = computeWorstCaseCents(1, 1_000_000, 0.000_01);
    expect(result).toBeCloseTo(1100, 5);
  });

  it('handles zero output tokens', () => {
    // (0.25 + 0 * 0.001) * 100 = 25
    const result = computeWorstCaseCents(0.25, 0, 0.001);
    expect(result).toBe(25);
  });

  it('handles zero input cost', () => {
    // (0 + 500 * 0.002) * 100 = 100
    const result = computeWorstCaseCents(0, 500, 0.002);
    expect(result).toBe(100);
  });
});

describe('derivedIsSmartModel', () => {
  it('returns false when no stages ran', () => {
    expect(derivedIsSmartModel([])).toBe(false);
  });

  // Bound to "did the routing stage execute," NOT "did it produce a billable
  // LLM call." The classifier-failure → fallback path runs the stage without
  // producing a billing breadcrumb; the chip must still render. Reading from
  // the stages-run list rather than billings is what gives us this contract.
  it('returns true when the smart-model stage ran (even with no billing)', () => {
    expect(derivedIsSmartModel(['smart-model'])).toBe(true);
  });

  it('does NOT return true for a hypothetical non-Smart-Model stage', () => {
    expect(derivedIsSmartModel(['prompt-enhancer'])).toBe(false);
  });

  it('returns true when smart-model ran alongside other stages', () => {
    expect(derivedIsSmartModel(['prompt-enhancer', 'smart-model'])).toBe(true);
  });
});

describe('computeImageWorstCaseCents', () => {
  it('computes worst-case cents for a single image model', () => {
    const result = computeImageWorstCaseCents(0.04, 1);
    // 0.04 perImage × 1 model × (1 + 0.15 fee) + 8MB × storage_cost
    // applyFees(0.04) = 0.046
    // storage = 8_000_000 * MEDIA_STORAGE_COST_PER_BYTE ≈ 0.192
    // total ≈ 0.238 → cents ≈ 23.8
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(100); // under $1
  });

  it('scales linearly with number of models', () => {
    const single = computeImageWorstCaseCents(0.04, 1);
    const triple = computeImageWorstCaseCents(0.04, 3);
    expect(triple).toBeCloseTo(single * 3, 5);
  });

  it('returns 0 for zero perImage price', () => {
    const result = computeImageWorstCaseCents(0, 1);
    // Still has storage cost
    expect(result).toBeGreaterThan(0);
  });
});

describe('resolveWebSearchCost', () => {
  it('returns 0 when webSearchEnabled is false', () => {
    expect(resolveWebSearchCost(false)).toBe(0);
  });

  it('returns the worst-case search cost (10 calls, fees included) when enabled', async () => {
    const { worstCaseSearchCost } = await import('@hushbox/shared');
    expect(resolveWebSearchCost(true)).toBeCloseTo(worstCaseSearchCost(), 9);
  });

  it('reserves MAX_SEARCH_TOOL_CALLS × SEARCH_COST_PER_CALL × (1 + fee) per request', async () => {
    const { applyFees, MAX_SEARCH_TOOL_CALLS, SEARCH_COST_PER_CALL } =
      await import('@hushbox/shared');
    expect(resolveWebSearchCost(true)).toBeCloseTo(
      applyFees(MAX_SEARCH_TOOL_CALLS * SEARCH_COST_PER_CALL),
      9
    );
  });

  it('reserves the locked worst-case dollar amount (~$0.0575) per request', () => {
    // Pinning the math: MAX=10, per_call=$0.005, fee_rate=0.15
    // Total = applyFees(10 × 0.005) = 0.05 × 1.15 = 0.0575
    expect(resolveWebSearchCost(true)).toBeCloseTo(0.0575, 9);
  });

  it('is strictly greater than the legacy 1× per-call estimate (the bug we fixed)', async () => {
    const { applyFees, SEARCH_COST_PER_CALL } = await import('@hushbox/shared');
    // The previous bug reserved only 1× SEARCH_COST_PER_CALL (with fees).
    expect(resolveWebSearchCost(true)).toBeGreaterThan(applyFees(SEARCH_COST_PER_CALL));
  });
});

describe('handleBillingResult', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns billing result on success', async () => {
    const { c } = createMockContext();
    const billingResult = {
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.0042',
      usageRecordId: 'usage-123',
      userEnvelope: stubUserEnvelope,
      assistantResults: [],
    };

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.resolve(billingResult),
      assistantMessageId: 'asst-123',
      userId: 'user-1',
      senderId: 'user-1',
      model: 'openai/gpt-4o',
      generationId: 'gen-abc',
    });

    expect(result).toEqual(billingResult);
  });

  it('returns null and logs error when billing promise rejects', async () => {
    const { c } = createMockContext();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.reject(new Error('DB connection failed')),
      assistantMessageId: 'asst-456',
      userId: 'user-2',
      senderId: 'user-2',
      model: 'anthropic/claude',
      generationId: 'gen-xyz',
    });

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledOnce();

    const loggedJson = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(loggedJson).toMatchObject({
      event: 'billing_failed',
      messageId: 'asst-456',
      userId: 'user-2',
      model: 'anthropic/claude',
      generationId: 'gen-xyz',
      error: 'DB connection failed',
    });
    expect(loggedJson.timestamp).toBeDefined();
  });

  it('logs stringified non-Error rejection values', async () => {
    const { c } = createMockContext();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.reject(new Error('string error')),
      assistantMessageId: 'asst-789',
      userId: 'user-3',
      senderId: 'user-3',
      model: 'model/x',
      generationId: undefined,
    });

    expect(result).toBeNull();
    const loggedJson = JSON.parse(consoleSpy.mock.calls[0]![0] as string);
    expect(loggedJson.error).toBe('string error');
    expect(loggedJson.generationId).toBeUndefined();
  });

  it('calls waitUntil with the billing promise', async () => {
    const { c } = createMockContext();
    const billingPromise = Promise.resolve({
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.001',
      usageRecordId: 'u-1',
      userEnvelope: stubUserEnvelope,
      assistantResults: [],
    });

    await handleBillingResult({
      c,
      billingPromise,
      assistantMessageId: 'asst-1',
      userId: 'user-1',
      senderId: 'user-1',
      model: 'model/a',
      generationId: undefined,
    });

    expect(c.executionCtx.waitUntil).toHaveBeenCalledOnce();
  });

  it('handles missing executionCtx gracefully', async () => {
    const c = {} as Parameters<typeof handleBillingResult>[0]['c'];
    const billingResult = {
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.001',
      usageRecordId: 'u-1',
      userEnvelope: stubUserEnvelope,
      assistantResults: [],
    };

    const result = await handleBillingResult({
      c,
      billingPromise: Promise.resolve(billingResult),
      assistantMessageId: 'asst-1',
      userId: 'user-1',
      senderId: 'user-1',
      model: 'model/a',
      generationId: undefined,
    });

    expect(result).toEqual(billingResult);
  });
});

describe('withBroadcast', () => {
  beforeEach(() => {
    vi.mocked(broadcastFireAndForget).mockClear();
    vi.mocked(createEvent).mockClear();
  });

  const broadcast: BroadcastContext = {
    env: {} as BroadcastContext['env'],
    conversationId: 'conv-1',
    assistantMessageId: 'asst-1',
    modelName: 'openai/gpt-4o',
  };

  async function collectAll(stream: InferenceStream): Promise<InferenceEvent[]> {
    const items: InferenceEvent[] = [];
    for await (const item of stream) {
      items.push(item);
    }
    return items;
  }

  function textDeltaStream(tokens: string[]): InferenceStream {
    return {
      [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
        let index = 0;
        return {
          next(): Promise<IteratorResult<InferenceEvent>> {
            if (index >= tokens.length) return Promise.resolve({ done: true, value: undefined });
            const content = tokens[index++]!;
            return Promise.resolve({
              done: false,
              value: { kind: 'text-delta' as const, content },
            });
          },
        };
      },
    };
  }

  it('passes through all events unchanged', async () => {
    const stream = textDeltaStream(['Hello', ' World']);
    const wrapped = withBroadcast(stream, broadcast);

    const items = await collectAll(wrapped);

    expect(items).toEqual([
      { kind: 'text-delta', content: 'Hello' },
      { kind: 'text-delta', content: ' World' },
    ]);
  });

  it('flushes remaining buffer on stream completion', async () => {
    const stream = textDeltaStream(['token']);
    const wrapped = withBroadcast(stream, broadcast);

    await collectAll(wrapped);

    expect(broadcastFireAndForget).toHaveBeenCalled();
    const lastCallEvent = vi.mocked(createEvent).mock.calls.at(-1);
    expect(lastCallEvent).toBeDefined();
    expect(lastCallEvent![0]).toBe('message:stream');
    expect(lastCallEvent![1]).toMatchObject({
      messageId: 'asst-1',
      token: 'token',
      modelName: 'openai/gpt-4o',
    });
  });

  it('includes modelName in broadcast events when provided', async () => {
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcast);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload['modelName']).toBe('openai/gpt-4o');
  });

  it('omits modelName from broadcast events when undefined', async () => {
    const broadcastNoModel: BroadcastContext = {
      env: {} as BroadcastContext['env'],
      conversationId: 'conv-1',
      assistantMessageId: 'asst-1',
    };
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcastNoModel);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('modelName');
  });

  it('includes senderId in broadcast events when provided', async () => {
    const broadcastWithSender: BroadcastContext = {
      env: {} as BroadcastContext['env'],
      conversationId: 'conv-1',
      assistantMessageId: 'asst-1',
      modelName: 'openai/gpt-4o',
      senderId: 'user-42',
    };
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcastWithSender);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload['senderId']).toBe('user-42');
  });

  it('omits senderId from broadcast events when undefined', async () => {
    const stream = textDeltaStream(['hi']);
    const wrapped = withBroadcast(stream, broadcast);

    await collectAll(wrapped);

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('senderId');
  });

  it('handles empty stream without error', async () => {
    const emptyStream: InferenceStream = {
      [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
        return {
          next(): Promise<IteratorResult<InferenceEvent>> {
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    const wrapped = withBroadcast(emptyStream, broadcast);
    const items = await collectAll(wrapped);

    expect(items).toEqual([]);
    expect(broadcastFireAndForget).not.toHaveBeenCalled();
  });
});

describe('broadcastAndFinish', () => {
  const stubTextContentItem = (overrides: {
    id: string;
    encryptedBlob: Uint8Array;
    modelName?: string | null;
    cost?: string | null;
  }) => ({
    id: overrides.id,
    contentType: 'text' as const,
    position: 0,
    encryptedBlob: overrides.encryptedBlob,
    storageKey: null,
    mimeType: null,
    sizeBytes: null,
    width: null,
    height: null,
    durationMs: null,
    modelName: overrides.modelName ?? null,
    cost: overrides.cost ?? null,
    isSmartModel: false,
    createdAt: new Date(),
  });

  beforeEach(() => {
    vi.mocked(broadcastFireAndForget).mockClear();
    vi.mocked(createEvent).mockClear();
  });

  it('broadcasts message:complete and writes done event', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const writeDone = vi.fn().mockResolvedValue(undefined);
    const writer = { writeDone } as unknown as ReturnType<
      typeof import('./stream-handler.js').createSSEEventWriter
    >;

    const c = {
      env: {} as BroadcastContext['env'],
      executionCtx: { waitUntil: vi.fn() },
    } as unknown as Parameters<typeof broadcastAndFinish>[0]['c'];

    await broadcastAndFinish({
      c,
      conversationId: 'conv-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      billingResult: {
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 3,
        cost: '0.005',
        usageRecordId: 'u-1',
        userEnvelope: {
          messageId: 'user-1',
          wrappedContentKey: new Uint8Array([1, 2, 3]),
          contentItem: stubTextContentItem({
            id: 'ci-user',
            encryptedBlob: new Uint8Array([9, 9, 9]),
          }),
        },
        assistantResults: [],
      },
      writer,
      modelName: 'openai/gpt-4o',
    });

    expect(createEvent).toHaveBeenCalledWith('message:complete', {
      messageId: 'asst-1',
      conversationId: 'conv-1',
      sequenceNumber: 2,
      epochNumber: 3,
      modelName: 'openai/gpt-4o',
    });
    expect(broadcastFireAndForget).toHaveBeenCalledOnce();

    expect(writeDone).toHaveBeenCalledOnce();
  });

  it('omits modelName from broadcast when undefined', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const writeDone = vi.fn().mockResolvedValue(undefined);
    const writer = { writeDone } as unknown as ReturnType<
      typeof import('./stream-handler.js').createSSEEventWriter
    >;

    const c = {
      env: {} as BroadcastContext['env'],
      executionCtx: { waitUntil: vi.fn() },
    } as unknown as Parameters<typeof broadcastAndFinish>[0]['c'];

    await broadcastAndFinish({
      c,
      conversationId: 'conv-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      billingResult: {
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 3,
        cost: '0.005',
        usageRecordId: 'u-1',
        userEnvelope: {
          messageId: 'user-1',
          wrappedContentKey: new Uint8Array([1, 2, 3]),
          contentItem: stubTextContentItem({
            id: 'ci-user',
            encryptedBlob: new Uint8Array([9, 9, 9]),
          }),
        },
        assistantResults: [],
      },
      writer,
    });

    const eventPayload = vi.mocked(createEvent).mock.calls[0]![1] as Record<string, unknown>;
    expect(eventPayload).not.toHaveProperty('modelName');
  });

  it('forwards user and per-model envelope data to writeDone', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const writeDone = vi.fn().mockResolvedValue(undefined);
    const writer = { writeDone } as unknown as ReturnType<
      typeof import('./stream-handler.js').createSSEEventWriter
    >;

    const c = {
      env: {} as BroadcastContext['env'],
      executionCtx: { waitUntil: vi.fn() },
    } as unknown as Parameters<typeof broadcastAndFinish>[0]['c'];

    const userWrapped = new Uint8Array([1, 1, 1]);
    const aiWrapped = new Uint8Array([2, 2, 2]);
    const userBlob = new Uint8Array([3, 3, 3]);
    const aiBlob = new Uint8Array([4, 4, 4]);

    await broadcastAndFinish({
      c,
      conversationId: 'conv-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-1',
      billingResult: {
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 3,
        cost: '0.005',
        usageRecordId: 'u-1',
        userEnvelope: {
          messageId: 'user-1',
          wrappedContentKey: userWrapped,
          contentItem: stubTextContentItem({ id: 'ci-user', encryptedBlob: userBlob }),
        },
        assistantResults: [
          {
            assistantMessageId: 'asst-1',
            model: 'openai/gpt-4o',
            aiSequence: 2,
            cost: '0.005',
            usageRecordId: 'u-1',
            envelope: {
              messageId: 'asst-1',
              wrappedContentKey: aiWrapped,
              contentItem: stubTextContentItem({
                id: 'ci-ai',
                encryptedBlob: aiBlob,
                modelName: 'openai/gpt-4o',
                cost: '0.005',
              }),
            },
          },
        ],
      },
      writer,
      modelName: 'openai/gpt-4o',
    });

    expect(writeDone).toHaveBeenCalledOnce();
    const args = writeDone.mock.calls[0]![0] as Record<string, unknown>;
    expect(args['userMessageId']).toBe('user-1');
    expect(args['assistantMessageId']).toBe('asst-1');
    expect(args['userSequence']).toBe(1);
    expect(args['aiSequence']).toBe(2);
    expect(args['epochNumber']).toBe(3);
    expect(args['cost']).toBe('0.005');

    const userEnvelope = args['userEnvelope'] as
      | { wrappedContentKey: string; contentItems: Record<string, unknown>[] }
      | undefined;
    expect(userEnvelope).toBeDefined();
    expect(userEnvelope!.wrappedContentKey).toBe(Buffer.from(userWrapped).toString('base64'));
    expect(userEnvelope!.contentItems).toHaveLength(1);
    expect(userEnvelope!.contentItems[0]!['id']).toBe('ci-user');
    expect(userEnvelope!.contentItems[0]!['encryptedBlob']).toBe(
      Buffer.from(userBlob).toString('base64')
    );

    const models = args['models'] as Record<string, unknown>[];
    expect(models).toHaveLength(1);
    const first = models[0]!;
    expect(first['modelId']).toBe('openai/gpt-4o');
    expect(first['assistantMessageId']).toBe('asst-1');
    expect(first['aiSequence']).toBe(2);
    expect(first['cost']).toBe('0.005');
    expect(first['wrappedContentKey']).toBe(Buffer.from(aiWrapped).toString('base64'));
    const items = first['contentItems'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]!['id']).toBe('ci-ai');
    expect(items[0]!['encryptedBlob']).toBe(Buffer.from(aiBlob).toString('base64'));
    expect(items[0]!['modelName']).toBe('openai/gpt-4o');
  });

  it('serializes media envelope with storageKey and media metadata', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const writeDone = vi.fn().mockResolvedValue(undefined);
    const writer = { writeDone } as unknown as ReturnType<
      typeof import('./stream-handler.js').createSSEEventWriter
    >;

    const c = {
      env: {} as BroadcastContext['env'],
      executionCtx: { waitUntil: vi.fn() },
    } as unknown as Parameters<typeof broadcastAndFinish>[0]['c'];

    const userWrapped = new Uint8Array([1, 1, 1]);
    const aiWrapped = new Uint8Array([5, 5, 5]);

    await broadcastAndFinish({
      c,
      conversationId: 'conv-1',
      userMessageId: 'user-1',
      assistantMessageId: 'asst-media',
      billingResult: {
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 3,
        cost: '0.046',
        usageRecordId: 'u-media',
        userEnvelope: {
          messageId: 'user-1',
          wrappedContentKey: userWrapped,
          contentItem: stubTextContentItem({
            id: 'ci-user',
            encryptedBlob: new Uint8Array([9]),
          }),
        },
        assistantResults: [
          {
            assistantMessageId: 'asst-media',
            model: 'google/imagen-4',
            aiSequence: 2,
            cost: '0.046',
            usageRecordId: 'u-media',
            envelope: {
              messageId: 'asst-media',
              wrappedContentKey: aiWrapped,
              contentItems: [
                {
                  id: 'ci-img',
                  contentType: 'image' as const,
                  position: 0,
                  storageKey: 'media/conv/msg/item.enc',
                  mimeType: 'image/png',
                  sizeBytes: 1_000_000,
                  width: 1024,
                  height: 1024,
                  durationMs: null,
                  modelName: 'google/imagen-4',
                  cost: '0.046',
                  isSmartModel: false,
                },
              ],
            },
          },
        ],
      },
      writer,
      modelName: 'google/imagen-4',
    });

    expect(writeDone).toHaveBeenCalledOnce();
    const args = writeDone.mock.calls[0]![0] as Record<string, unknown>;
    const models = args['models'] as Record<string, unknown>[];
    expect(models).toHaveLength(1);

    const mediaModel = models[0]!;
    expect(mediaModel['wrappedContentKey']).toBe(Buffer.from(aiWrapped).toString('base64'));

    const items = mediaModel['contentItems'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item['id']).toBe('ci-img');
    expect(item['contentType']).toBe('image');
    // downloadUrl is omitted (not nulled) when not yet populated by the strategy.
    expect(item['downloadUrl']).toBeUndefined();
    expect(item['mimeType']).toBe('image/png');
    expect(item['sizeBytes']).toBe(1_000_000);
    expect(item['width']).toBe(1024);
    expect(item['height']).toBe(1024);
    expect(item['modelName']).toBe('google/imagen-4');
    expect(item['encryptedBlob']).toBeUndefined();
    expect(item['storageKey']).toBeUndefined();
  });
});

interface MockRedisForBilling {
  get: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
}

/**
 * Default paid-tier media billing result used by image/video/audio resolvers.
 * Centralized so tests across modalities share one fixture (and the linter
 * doesn't flag identical local helpers).
 */
function buildPaidMediaBillingResult(
  overrides: Partial<BuildBillingResult['input']> = {}
): BuildBillingResult {
  return {
    input: {
      tier: 'paid',
      balanceCents: 100_000,
      freeAllowanceCents: 0,
      isPremiumModel: false,
      estimatedMinimumCostCents: 0,
      ...overrides,
    },
    rawUserBalanceCents: overrides.balanceCents ?? 100_000,
    rawFreeAllowanceCents: overrides.freeAllowanceCents ?? 0,
  };
}

/** Build a minimal Hono Context mock sufficient for the media-billing resolvers. */
function createMockBillingContext(redis: MockRedisForBilling): {
  c: Context<AppEnv>;
  jsonSpy: ReturnType<typeof vi.fn>;
} {
  const jsonSpy = vi.fn((body: unknown, status?: number) => {
    return Response.json(body, {
      status: typeof status === 'number' ? status : 200,
    });
  });
  const c = {
    get: vi.fn((key: string) => {
      if (key === 'redis') return redis;
      return null;
    }),
    env: {
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    } as AppEnv['Bindings'],
    json: jsonSpy,
  } as unknown as Context<AppEnv>;
  return { c, jsonSpy };
}

describe('resolveAndReserveImageBilling', () => {
  type MockRedis = MockRedisForBilling;
  const createMockImageBillingContext = createMockBillingContext;

  /**
   * Build a BuildBillingResult from scratch per test.
   * resolveAndReserveImageBilling mutates `input.estimatedMinimumCostCents`,
   * so sharing a single fixture across tests would leak state.
   */
  function makeBillingResult(
    overrides: Partial<BuildBillingResult['input']> = {}
  ): BuildBillingResult {
    return {
      input: {
        tier: 'paid',
        balanceCents: 10_000, // $100
        freeAllowanceCents: 0,
        isPremiumModel: false,
        estimatedMinimumCostCents: 0,
        ...overrides,
      },
      rawUserBalanceCents: overrides.balanceCents ?? 10_000,
      rawFreeAllowanceCents: overrides.freeAllowanceCents ?? 0,
    };
  }

  it('happy path: paid tier reserves worst-case cents and returns success', async () => {
    // eval returns the new reserved total (cents). Must be ≤ balance for success.
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('10'), // 10 cents reserved total, well under 10_000
    };
    const { c } = createMockImageBillingContext(redis);

    const result = await resolveAndReserveImageBilling(c, {
      billingResult: makeBillingResult({ tier: 'paid', balanceCents: 10_000 }),
      userId: 'user-1',
      models: ['google/imagen-4'],
      perImageByModel: new Map([['google/imagen-4', 0.04]]),
      clientFundingSource: 'personal_balance',
    });

    expect(result.success).toBe(true);
    if (!result.success) return; // type narrowing
    expect(result.billingUserId).toBe('user-1');
    expect(result.perImageByModel.get('google/imagen-4')).toBe(0.04);
    expect(result.worstCaseCents).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('denial path: trial tier with tiny balance returns 402 Response', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('0'),
    };
    const { c, jsonSpy } = createMockImageBillingContext(redis);

    // Trial tier: only affordable if estimatedMinimumCostCents ≤ 1 cent.
    // Image worst-case at 0.04/image is ≈ 23.8 cents, which exceeds trial limit.
    const result = await resolveAndReserveImageBilling(c, {
      billingResult: makeBillingResult({
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
      }),
      userId: 'user-trial',
      models: ['google/imagen-4'],
      perImageByModel: new Map([['google/imagen-4', 0.04]]),
      clientFundingSource: 'trial_fixed',
    });

    expect(result.success).toBe(false);
    if (result.success) return; // type narrowing
    expect(result.response.status).toBe(402);
    // json() was called exactly once with 402 for the denial (no reserve attempt)
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    const [, status] = jsonSpy.mock.calls[0]!;
    expect(status).toBe(402);
    // Redis eval was NOT called because denial happens before reservation
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

describe('resolveAndReserveVideoBilling', () => {
  type MockRedis = MockRedisForBilling;
  const createMockVideoBillingContext = createMockBillingContext;

  const makeBillingResult = buildPaidMediaBillingResult;

  it('happy path: paid tier reserves worst-case cents and returns success', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('10'),
    };
    const { c } = createMockVideoBillingContext(redis);

    const result = await resolveAndReserveVideoBilling(c, {
      billingResult: makeBillingResult({ tier: 'paid', balanceCents: 100_000 }),
      userId: 'user-1',
      models: ['google/veo-3.1'],
      perSecondByModel: new Map([['google/veo-3.1', 0.1]]),
      durationSeconds: 4,
      resolution: '720p',
      clientFundingSource: 'personal_balance',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.billingUserId).toBe('user-1');
    expect(result.perSecondByModel.get('google/veo-3.1')).toBe(0.1);
    expect(result.durationSeconds).toBe(4);
    expect(result.resolution).toBe('720p');
    expect(result.worstCaseCents).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('scales worst-case cents with duration', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('10'),
    };
    const { c } = createMockVideoBillingContext(redis);

    const short = await resolveAndReserveVideoBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['google/veo-3.1'],
      perSecondByModel: new Map([['google/veo-3.1', 0.1]]),
      durationSeconds: 2,
      resolution: '720p',
      clientFundingSource: 'personal_balance',
    });
    const long = await resolveAndReserveVideoBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['google/veo-3.1'],
      perSecondByModel: new Map([['google/veo-3.1', 0.1]]),
      durationSeconds: 8,
      resolution: '720p',
      clientFundingSource: 'personal_balance',
    });
    if (!short.success || !long.success) throw new Error('expected success');
    expect(long.worstCaseCents).toBeCloseTo(short.worstCaseCents * 4, 5);
  });

  it('denial path: trial tier returns 402 without reservation', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('0'),
    };
    const { c, jsonSpy } = createMockVideoBillingContext(redis);

    const result = await resolveAndReserveVideoBilling(c, {
      billingResult: makeBillingResult({
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
      }),
      userId: 'user-trial',
      models: ['google/veo-3.1'],
      perSecondByModel: new Map([['google/veo-3.1', 0.1]]),
      durationSeconds: 4,
      resolution: '720p',
      clientFundingSource: 'trial_fixed',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(402);
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('mismatch path: returns 409 when client funding source disagrees', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('0'),
    };
    const { c, jsonSpy } = createMockVideoBillingContext(redis);

    const result = await resolveAndReserveVideoBilling(c, {
      billingResult: makeBillingResult({ tier: 'paid', balanceCents: 100_000 }),
      userId: 'user-1',
      models: ['google/veo-3.1'],
      perSecondByModel: new Map([['google/veo-3.1', 0.1]]),
      durationSeconds: 4,
      resolution: '720p',
      clientFundingSource: 'free_allowance', // server says 'personal_balance'
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(409);
    const [, status] = jsonSpy.mock.calls[0]!;
    expect(status).toBe(409);
  });

  it('scales worst-case cents with model count', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('10'),
    };
    const { c } = createMockVideoBillingContext(redis);

    const one = await resolveAndReserveVideoBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['google/veo-3.1'],
      perSecondByModel: new Map([['google/veo-3.1', 0.1]]),
      durationSeconds: 4,
      resolution: '720p',
      clientFundingSource: 'personal_balance',
    });
    const two = await resolveAndReserveVideoBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['google/veo-3.1', 'google/veo-3.0'],
      perSecondByModel: new Map([
        ['google/veo-3.1', 0.1],
        ['google/veo-3.0', 0.1],
      ]),
      durationSeconds: 4,
      resolution: '720p',
      clientFundingSource: 'personal_balance',
    });
    if (!one.success || !two.success) throw new Error('expected success');
    expect(two.worstCaseCents).toBeCloseTo(one.worstCaseCents * 2, 5);
  });
});

describe('resolveAndReserveAudioBilling', () => {
  type MockRedis = MockRedisForBilling;
  const createMockAudioBillingContext = createMockBillingContext;

  const makeBillingResult = buildPaidMediaBillingResult;

  it('happy path: paid tier reserves worst-case cents and returns success', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('10'),
    };
    const { c } = createMockAudioBillingContext(redis);

    const result = await resolveAndReserveAudioBilling(c, {
      billingResult: makeBillingResult({ tier: 'paid', balanceCents: 100_000 }),
      userId: 'user-1',
      models: ['openai/tts-1'],
      perSecondByModel: new Map([['openai/tts-1', 0.015]]),
      maxDurationSeconds: 60,
      clientFundingSource: 'personal_balance',
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.billingUserId).toBe('user-1');
    expect(result.perSecondByModel.get('openai/tts-1')).toBe(0.015);
    expect(result.maxDurationSeconds).toBe(60);
    expect(result.worstCaseCents).toBeGreaterThan(0);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('scales worst-case cents with maxDurationSeconds', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('10'),
    };
    const { c } = createMockAudioBillingContext(redis);

    const short = await resolveAndReserveAudioBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['openai/tts-1'],
      perSecondByModel: new Map([['openai/tts-1', 0.015]]),
      maxDurationSeconds: 30,
      clientFundingSource: 'personal_balance',
    });
    const long = await resolveAndReserveAudioBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['openai/tts-1'],
      perSecondByModel: new Map([['openai/tts-1', 0.015]]),
      maxDurationSeconds: 120,
      clientFundingSource: 'personal_balance',
    });
    if (!short.success || !long.success) throw new Error('expected success');
    expect(long.worstCaseCents).toBeCloseTo(short.worstCaseCents * 4, 5);
  });

  it('denial path: trial tier returns 402 without reservation', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('0'),
    };
    const { c, jsonSpy } = createMockAudioBillingContext(redis);

    const result = await resolveAndReserveAudioBilling(c, {
      billingResult: makeBillingResult({
        tier: 'trial',
        balanceCents: 0,
        freeAllowanceCents: 0,
      }),
      userId: 'user-trial',
      models: ['openai/tts-1'],
      perSecondByModel: new Map([['openai/tts-1', 0.015]]),
      maxDurationSeconds: 60,
      clientFundingSource: 'trial_fixed',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(402);
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('mismatch path: returns 409 when client funding source disagrees', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('0'),
    };
    const { c, jsonSpy } = createMockAudioBillingContext(redis);

    const result = await resolveAndReserveAudioBilling(c, {
      billingResult: makeBillingResult({ tier: 'paid', balanceCents: 100_000 }),
      userId: 'user-1',
      models: ['openai/tts-1'],
      perSecondByModel: new Map([['openai/tts-1', 0.015]]),
      maxDurationSeconds: 60,
      clientFundingSource: 'free_allowance',
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.response.status).toBe(409);
    const [, status] = jsonSpy.mock.calls[0]!;
    expect(status).toBe(409);
  });

  it('scales worst-case cents with model count', async () => {
    const redis: MockRedis = {
      get: vi.fn().mockResolvedValue(null),
      eval: vi.fn().mockResolvedValue('10'),
    };
    const { c } = createMockAudioBillingContext(redis);

    const one = await resolveAndReserveAudioBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['openai/tts-1'],
      perSecondByModel: new Map([['openai/tts-1', 0.015]]),
      maxDurationSeconds: 60,
      clientFundingSource: 'personal_balance',
    });
    const two = await resolveAndReserveAudioBilling(c, {
      billingResult: makeBillingResult(),
      userId: 'u',
      models: ['openai/tts-1', 'openai/tts-1-hd'],
      perSecondByModel: new Map([
        ['openai/tts-1', 0.015],
        ['openai/tts-1-hd', 0.03],
      ]),
      maxDurationSeconds: 60,
      clientFundingSource: 'personal_balance',
    });
    if (!one.success || !two.success) throw new Error('expected success');
    expect(two.worstCaseCents).toBeGreaterThan(one.worstCaseCents);
  });
});
