import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createLanguageAdapter } from './language-adapter.js';
import { createCassetteStore, type CassetteStore } from './cassette/cassette-store.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createFixtureFetch, FAILURE_FIXTURES } from './cassette/failure-fixtures.js';
import type {
  FilePart,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
} from '@hushbox/shared';

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'language-adapter-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function testDescriptor(): ModelDescriptor {
  return {
    id: 'openai/gpt-4o',
    provider: 'openai',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {},
    pricing: {},
    zdrReachable: true,
    fetchedAt: 0,
  };
}

function textRequest(text: string): InferenceRequest {
  return {
    model: 'openai/gpt-4o',
    inputs: [{ modality: 'text', text }],
    parameters: {},
    outputs: ['text'],
  };
}

/**
 * SYNTHETIC wire stream: LanguageModelV3 SSE parts authored from the
 * provider spec, not recorded from the live gateway (no credentials here).
 */
function sseBody(parts: unknown[]): string {
  return parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('');
}

function sseResponse(parts: unknown[]): Response {
  return new Response(sseBody(parts), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Serves each scripted response once, in order; throws when exhausted. */
function scriptedFetch(responses: (() => Response)[]): typeof globalThis.fetch {
  let next = 0;
  return function scripted(): Promise<Response> {
    const make = responses[next];
    next += 1;
    if (make === undefined) throw new Error(`scriptedFetch exhausted after ${String(next - 1)}`);
    return Promise.resolve(make());
  };
}

const WIRE_USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function simpleTextParts(): unknown[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
    { type: 'text-start', id: 'txt-1' },
    { type: 'text-delta', id: 'txt-1', delta: 'Hello' },
    { type: 'text-delta', id: 'txt-1', delta: ' world' },
    { type: 'text-end', id: 'txt-1' },
    {
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: WIRE_USAGE,
      providerMetadata: { gateway: { generationId: 'gen_single' } },
    },
  ];
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const STEP_TWO_USAGE = {
  inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

/** Step 1: the model calls the `search` tool; step 2: it answers with text. */
function toolLoopResponses(): (() => Response)[] {
  return [
    () =>
      sseResponse([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'search',
          input: '{"query":"hushbox"}',
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
          usage: WIRE_USAGE,
          providerMetadata: { gateway: { generationId: 'gen_step1' } },
        },
      ]),
    () =>
      sseResponse([
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: 'resp-2', modelId: 'openai/gpt-4o' },
        { type: 'text-start', id: 'txt-1' },
        { type: 'text-delta', id: 'txt-1', delta: 'Found it' },
        { type: 'text-end', id: 'txt-1' },
        {
          type: 'finish',
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: STEP_TWO_USAGE,
          providerMetadata: { gateway: { generationId: 'gen_step2' } },
        },
      ]),
  ];
}

function searchToolRegistry(execute: (input: unknown) => Promise<unknown>) {
  return {
    search: {
      description: 'Search the web',
      inputSchema: z.object({ query: z.string() }),
      execute,
    },
  };
}

describe('createLanguageAdapter reasoning', () => {
  it('maps reasoning deltas to their own indexed event stream', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            { type: 'reasoning-start', id: 'rsn-1' },
            { type: 'reasoning-delta', id: 'rsn-1', delta: 'thinking…' },
            { type: 'reasoning-end', id: 'rsn-1' },
            { type: 'text-start', id: 'txt-1' },
            { type: 'text-delta', id: 'txt-1', delta: 'Answer' },
            { type: 'text-end', id: 'txt-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: WIRE_USAGE,
              providerMetadata: { gateway: { generationId: 'gen_r' } },
            },
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('Think'), testDescriptor()));

    expect(events).toContainEqual({ kind: 'reasoning-delta', index: 0, content: 'thinking…' });
    expect(events).toContainEqual({ kind: 'text-delta', index: 0, content: 'Answer' });
  });
});

describe('createLanguageAdapter ZDR', () => {
  it('sends the gateway zero-data-retention flag on every recorded request', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch(toolLoopResponses()),
      }),
    });

    await collect(
      adapter.infer(textRequest('Find hushbox'), testDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.resolve({ hits: 2 })),
          maxSteps: 2,
        },
      })
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(2);
    });

    for (const hash of store.list()) {
      const request = store.read(hash)?.request;
      expect(request?.pathAndQuery).toBe('/v3/ai/language-model');
      const body = z
        .looseObject({
          providerOptions: z.looseObject({
            gateway: z.looseObject({ zeroDataRetention: z.boolean() }),
          }),
        })
        .parse(JSON.parse(request?.body ?? '{}'));
      expect(body.providerOptions.gateway.zeroDataRetention).toBe(true);
    }
  });
});

describe('createLanguageAdapter parameters', () => {
  it('wires maxOutputTokens onto the gateway request body', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextParts())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { maxOutputTokens: 64 } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ maxOutputTokens: 64 });
  });

  it('wires temperature and topP onto the gateway request body', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextParts())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { temperature: 0.2, topP: 0.9 } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ temperature: 0.2, topP: 0.9 });
  });

  it('rejects a parameter key the adapter cannot wire', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('Say hi'), parameters: { frobnicate: true } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });
});

describe('createLanguageAdapter input validation', () => {
  it('rejects a media input part until the resolver seam exists', async () => {
    const request: InferenceRequest = {
      ...textRequest('Describe'),
      inputs: [
        { modality: 'image', ref: { ref: 'inputs/x/y', mimeType: 'image/png', byteLength: 3 } },
      ],
    };
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(collect(adapter.infer(request, testDescriptor()))).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'invalid_request',
    });
  });

  it('rejects a request whose model differs from the descriptor', () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer({ ...textRequest('hi'), model: 'openai/other' }, testDescriptor())
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});

describe('createLanguageAdapter construction', () => {
  it('constructs a production adapter without a custom fetch', () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key' });

    expect(typeof adapter.infer).toBe('function');
  });
});

describe('createLanguageAdapter stream edge cases', () => {
  it('skips empty text and reasoning deltas', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            { type: 'reasoning-start', id: 'rsn-1' },
            { type: 'reasoning-delta', id: 'rsn-1', delta: '' },
            { type: 'reasoning-end', id: 'rsn-1' },
            { type: 'text-start', id: 'txt-1' },
            { type: 'text-delta', id: 'txt-1', delta: '' },
            { type: 'text-delta', id: 'txt-1', delta: 'real' },
            { type: 'text-end', id: 'txt-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: WIRE_USAGE,
              providerMetadata: { gateway: { generationId: 'gen_s' } },
            },
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    const deltas = events.filter(
      (event) => event.kind === 'text-delta' || event.kind === 'reasoning-delta'
    );
    expect(deltas).toEqual([{ kind: 'text-delta', index: 0, content: 'real' }]);
  });

  it('defaults missing usage totals to zero', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            { type: 'text-start', id: 'txt-1' },
            { type: 'text-delta', id: 'txt-1', delta: 'hi' },
            { type: 'text-end', id: 'txt-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: { inputTokens: {}, outputTokens: {} },
              providerMetadata: { gateway: { generationId: 'gen_u' } },
            },
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_u',
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('treats a finish without the gateway metadata namespace as a truncated stream', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            { type: 'text-start', id: 'txt-1' },
            { type: 'text-delta', id: 'txt-1', delta: 'hi' },
            { type: 'text-end', id: 'txt-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: WIRE_USAGE,
              providerMetadata: { openai: {} },
            },
          ]),
      ]),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'truncated_stream' }
    );
  });

  it('treats non-object provider metadata as missing generation metadata', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            { type: 'text-start', id: 'txt-1' },
            { type: 'text-delta', id: 'txt-1', delta: 'hi' },
            { type: 'text-end', id: 'txt-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: WIRE_USAGE,
              providerMetadata: 'unparseable',
            },
          ]),
      ]),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'truncated_stream' }
    );
  });

  it('propagates gateway metadata schema drift as a defect outside the typed channel', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            { type: 'text-start', id: 'txt-1' },
            { type: 'text-delta', id: 'txt-1', delta: 'hi' },
            { type: 'text-end', id: 'txt-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: WIRE_USAGE,
              providerMetadata: { gateway: { generationId: 123 } },
            },
          ]),
      ]),
    });

    const consumed = collect(adapter.infer(textRequest('hi'), testDescriptor()));

    await expect(consumed).rejects.toThrow(/schema drift/);
    await expect(consumed).rejects.toMatchObject({ name: 'AdapterDefect' });
  });
});

describe('createLanguageAdapter tool loop', () => {
  it('runs the agentic loop inside the adapter with per-step generation ids', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch(toolLoopResponses()),
      }),
    });

    const events = await collect(
      adapter.infer(textRequest('Find hushbox'), testDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.resolve({ hits: 2 })),
          maxSteps: 2,
        },
      })
    );

    expect(events).toEqual([
      { kind: 'step-start', step: 0 },
      { kind: 'tool-call', id: 'call-1', name: 'search', args: { query: 'hushbox' } },
      // the SDK executes the tool within its step: the result lands before
      // the step's finish, under the same generation umbrella
      { kind: 'tool-result', id: 'call-1', name: 'search', result: { hits: 2 } },
      { kind: 'step-finish', step: 0, generationId: 'gen_step1' },
      { kind: 'step-start', step: 1 },
      { kind: 'text-delta', index: 0, content: 'Found it' },
      { kind: 'step-finish', step: 1, generationId: 'gen_step2' },
      {
        kind: 'finish',
        metadata: {
          usage: { inputTokens: 32, outputTokens: 12, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });

  it('recovers from a failed tool call when a later step produces text', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch(toolLoopResponses()),
    });

    const events = await collect(
      adapter.infer(textRequest('Find hushbox'), testDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.reject(new Error('search exploded'))),
          maxSteps: 2,
        },
      })
    );

    expect(events).toContainEqual({ kind: 'text-delta', index: 0, content: 'Found it' });
    expect(events.filter((event) => event.kind === 'tool-result')).toEqual([]);
  });

  /**
   * SYNTHETIC: a provider-executed tool call followed by the provider's
   * `tool-approval-request` wire part (MCP-style approval flow). The SDK
   * forwards it to fullStream; the adapter must ignore it — ToolDefinition
   * exposes no approval contract. `tool-output-denied`, the flow's other
   * part, is orchestrator-generated from an approval-response message the
   * adapter never sends, so it cannot be synthesized at this seam.
   */
  it('ignores a provider tool-approval-request part', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            {
              type: 'tool-call',
              toolCallId: 'call-appr',
              toolName: 'search',
              input: '{"query":"hushbox"}',
              providerExecuted: true,
            },
            { type: 'tool-approval-request', approvalId: 'appr-1', toolCallId: 'call-appr' },
            { type: 'text-start', id: 'txt-1' },
            { type: 'text-delta', id: 'txt-1', delta: 'Approved output' },
            { type: 'text-end', id: 'txt-1' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: WIRE_USAGE,
              providerMetadata: { gateway: { generationId: 'gen_appr' } },
            },
          ]),
      ]),
    });

    const events = await collect(
      adapter.infer(textRequest('Find hushbox'), testDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.resolve({ hits: 2 })),
          maxSteps: 1,
        },
      })
    );

    expect(events).toEqual([
      { kind: 'step-start', step: 0 },
      { kind: 'tool-call', id: 'call-appr', name: 'search', args: { query: 'hushbox' } },
      { kind: 'text-delta', index: 0, content: 'Approved output' },
      { kind: 'step-finish', step: 0, generationId: 'gen_appr' },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen_appr',
          usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });

  it('attributes an empty failed turn to the held tool error', async () => {
    const [firstResponse] = toolLoopResponses();
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch(firstResponse === undefined ? [] : [firstResponse]),
    });

    await expect(
      collect(
        adapter.infer(textRequest('Find hushbox'), testDescriptor(), {
          tools: {
            registry: searchToolRegistry(() => Promise.reject(new Error('search exploded'))),
            maxSteps: 1,
          },
        })
      )
    ).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'upstream_error',
      message: expect.stringContaining('search exploded') as string,
    });
  });
});

describe('createLanguageAdapter failure shapes', () => {
  it('classifies the no_providers_available fixture as the typed ZDR fail-closed error', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'no_providers_available' }
    );
  });

  it('classifies the 429 fixture as rate_limited', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.rateLimited),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'rate_limited' }
    );
  });

  it('classifies the truncated mid-stream fixture as truncated_stream', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.truncatedStream),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'truncated_stream' }
    );
  });
});

describe('createLanguageAdapter abort', () => {
  it('aborts the underlying gateway fetch when the signal fires', async () => {
    let fetchedSignal: AbortSignal | undefined;
    const hangingFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      fetchedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: hangingFetch });
    const controller = new AbortController();

    const consumed = collect(
      adapter.infer(textRequest('Say hi'), testDescriptor(), { signal: controller.signal })
    );
    await vi.waitFor(() => {
      expect(fetchedSignal).toBeDefined();
    });
    controller.abort();

    await expect(consumed).rejects.toMatchObject({ name: 'InferenceError', code: 'aborted' });
    expect(fetchedSignal?.aborted).toBe(true);
  });
});

describe('createLanguageAdapter empty turns', () => {
  /** SYNTHETIC: empty `length` finish — output-token budget hit before any text. */
  function emptyLengthFinishParts(): unknown[] {
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
      {
        type: 'finish',
        finishReason: { unified: 'length', raw: 'length' },
        usage: WIRE_USAGE,
        providerMetadata: { gateway: { generationId: 'gen_len' } },
      },
    ];
  }

  it('treats an empty length-finish as a billable truncation terminal event', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(emptyLengthFinishParts())]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_len',
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
        finishReason: 'length',
      },
    });
  });

  it('treats an empty stop-finish as an empty completion error', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { type: 'stream-start', warnings: [] },
            { type: 'response-metadata', id: 'resp-1', modelId: 'openai/gpt-4o' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: WIRE_USAGE,
              providerMetadata: { gateway: { generationId: 'gen_e' } },
            },
          ]),
      ]),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'empty_completion' }
    );
  });
});

describe('createLanguageAdapter multi-output', () => {
  /** SYNTHETIC: a text+image model streaming a file part through the language shape. */
  function filePartParts(): unknown[] {
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'resp-1', modelId: 'google/gemini-image' },
      { type: 'file', mediaType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: WIRE_USAGE,
        providerMetadata: { gateway: { generationId: 'gen_img' } },
      },
    ];
  }

  it('maps a file part to media events through the injected mapper', async () => {
    const mapped: { part: FilePart; index: number }[] = [];
    const mediaValue: MediaValue = {
      ref: 'media/conv/msg/uuid-1',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 3,
      metadata: {},
    };
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(filePartParts())]),
    });

    const events = await collect(
      adapter.infer(textRequest('Draw'), testDescriptor(), {
        mapFilePart: (part, index) => {
          mapped.push({ part, index });
          return [
            { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
            { kind: 'media-done', index, value: mediaValue },
          ];
        },
      })
    );

    expect(mapped).toEqual([
      { part: { mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }, index: 0 },
    ]);
    expect(events).toContainEqual({
      kind: 'media-start',
      index: 0,
      modality: 'image',
      mimeType: 'image/png',
    });
    expect(events).toContainEqual({ kind: 'media-done', index: 0, value: mediaValue });
    expect(events.at(-1)?.kind).toBe('finish');
  });

  it('propagates a file part without a mapper contract as a defect outside the typed channel', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(filePartParts())]),
    });

    const consumed = collect(adapter.infer(textRequest('Draw'), testDescriptor()));

    await expect(consumed).rejects.toThrow(/mapFilePart/);
    await expect(consumed).rejects.toMatchObject({ name: 'AdapterDefect' });
  });
});

describe('createLanguageAdapter stream mapping', () => {
  it('maps a replayed single-step text stream to the exact typed event sequence', async () => {
    const recorder = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextParts())]),
      }),
    });
    await collect(recorder.infer(textRequest('Say hi'), testDescriptor()));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayer = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({ store, mode: 'replay-only' }),
    });
    const events = await collect(replayer.infer(textRequest('Say hi'), testDescriptor()));

    expect(events).toEqual([
      { kind: 'step-start', step: 0 },
      { kind: 'text-delta', index: 0, content: 'Hello' },
      { kind: 'text-delta', index: 0, content: ' world' },
      { kind: 'step-finish', step: 0, generationId: 'gen_single' },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen_single',
          usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});
