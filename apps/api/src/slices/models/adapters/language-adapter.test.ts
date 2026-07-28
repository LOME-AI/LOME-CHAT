import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildToolset, createLanguageAdapter, extractStepCost } from './language-adapter.js';
import { createOpenRouterProvider } from './openrouter-provider.js';
import { createCassetteStore, type CassetteStore } from './cassette/cassette-store.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createFixtureFetch, FAILURE_FIXTURES } from './cassette/failure-fixtures.js';
import { descriptorHash, requestToDescriptor } from './cassette/canonical-request.js';
import {
  buildTurnSystemPrompt,
  historyCharacterCount,
  promptCharacterCount,
} from '@hushbox/shared';
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
    releasedAt: 1_700_000_000,
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
 * SYNTHETIC wire stream: OpenRouter's OpenAI-compatible chat SSE chunks
 * authored from the provider schema, not recorded from the live provider (no
 * credentials here). The provider's `doStream` normalizes these into the SDK's
 * stream parts.
 */
function sseBody(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function sseResponse(chunks: unknown[]): Response {
  return new Response(sseBody(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface FinishOptions {
  finishReason?: string;
  usage?: Record<string, number> | undefined;
}

function textDelta(id: string, content: string, first = false): unknown {
  return {
    id,
    ...(first ? { provider: 'openai' } : {}),
    choices: [{ index: 0, delta: { ...(first ? { role: 'assistant' } : {}), content } }],
  };
}

function finishChunk(id: string, options: FinishOptions = {}): unknown {
  const usage =
    'usage' in options
      ? options.usage
      : { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.12 };
  return {
    id,
    choices: [{ index: 0, delta: {}, finish_reason: options.finishReason ?? 'stop' }],
    ...(usage === undefined ? {} : { usage }),
  };
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

function simpleTextChunks(): unknown[] {
  return [
    textDelta('gen_single', 'Hello', true),
    textDelta('gen_single', ' world'),
    finishChunk('gen_single'),
  ];
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Step 1: the model calls the `search` tool; step 2: it answers with text. */
function toolCallChunk(id: string): unknown {
  return {
    id,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"hushbox"}' },
            },
          ],
        },
      },
    ],
  };
}

function toolLoopResponses(): (() => Response)[] {
  return [
    () =>
      sseResponse([
        toolCallChunk('gen_step1'),
        finishChunk('gen_step1', {
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.001 },
        }),
      ]),
    () =>
      sseResponse([
        textDelta('gen_step2', 'Found it', true),
        finishChunk('gen_step2', {
          usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27, cost: 0.002 },
        }),
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

describe('buildToolset provider-tool emission', () => {
  const provider = createOpenRouterProvider({ apiKey: 'test-key' });

  it('emits a providerTool definition as the OpenRouter web-search server tool carrying the perplexity engine', () => {
    const toolset = buildToolset(
      {
        registry: {
          web_search: {
            description: 'Search the web',
            inputSchema: z.object({}),
            execute: () => Promise.resolve(),
            providerTool: { kind: 'web-search', args: { engine: 'perplexity' } },
          },
        },
        maxSteps: 2,
      },
      provider
    );

    expect(toolset['web_search']).toMatchObject({
      type: 'provider',
      id: 'openrouter.web_search',
      args: { engine: 'perplexity' },
    });
  });

  it('still emits a plain client-function definition as a client tool with its execute wired', async () => {
    const execute = vi.fn((input: unknown) => Promise.resolve(input));
    const toolset = buildToolset(
      {
        registry: {
          search: { description: 'Search', inputSchema: z.object({ q: z.string() }), execute },
        },
        maxSteps: 1,
      },
      provider
    );

    const clientTool = toolset['search'];
    expect(clientTool?.type).toBeUndefined();
    expect(typeof clientTool?.execute).toBe('function');
    await (clientTool?.execute as (input: unknown) => Promise<unknown>)({ q: 'x' });
    expect(execute).toHaveBeenCalledWith({ q: 'x' });
  });
});

describe('extractStepCost', () => {
  it('reads the inline openrouter.usage.cost', () => {
    expect(extractStepCost({ openrouter: { usage: { cost: 0.005 } } })).toBe(0.005);
  });

  it('returns undefined for undefined metadata', () => {
    expect(extractStepCost()).toBeUndefined();
  });

  it('returns undefined for null metadata', () => {
    expect(extractStepCost(null)).toBeUndefined();
  });

  it('returns undefined for non-object (unparseable) metadata', () => {
    expect(extractStepCost('nope')).toBeUndefined();
  });

  it('returns undefined when usage carries no cost', () => {
    expect(extractStepCost({ openrouter: { usage: { promptTokens: 1 } } })).toBeUndefined();
  });

  it('returns undefined when the openrouter namespace is absent', () => {
    expect(extractStepCost({ other: {} })).toBeUndefined();
  });
});

describe('createLanguageAdapter reasoning', () => {
  it('maps reasoning deltas to their own indexed event stream', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            {
              id: 'gen_r',
              provider: 'openai',
              choices: [{ index: 0, delta: { reasoning: 'thinking…' } }],
            },
            textDelta('gen_r', 'Answer'),
            finishChunk('gen_r'),
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('Think'), testDescriptor()));

    expect(events).toContainEqual({ kind: 'reasoning-delta', index: 0, content: 'thinking…' });
    expect(events).toContainEqual({ kind: 'text-delta', index: 0, content: 'Answer' });
  });
});

describe('createLanguageAdapter ZDR', () => {
  it('sends the ZDR routing block in the request body on every recorded request', async () => {
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
      expect(request?.pathAndQuery).toBe('/api/v1/chat/completions');
      const body = z
        .looseObject({
          provider: z.looseObject({
            zdr: z.boolean(),
            data_collection: z.string(),
            allow_fallbacks: z.boolean(),
          }),
          usage: z.looseObject({ include: z.boolean() }),
          transforms: z.array(z.unknown()),
        })
        .parse(JSON.parse(request?.body ?? '{}'));
      expect(body.provider.zdr).toBe(true);
      expect(body.provider.data_collection).toBe('deny');
      expect(body.provider.allow_fallbacks).toBe(false);
      expect(body.usage.include).toBe(true);
      expect(body.transforms).toEqual([]);
    }
  });
});

describe('createLanguageAdapter parameters', () => {
  it('wires maxOutputTokens onto the request body as max_tokens', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
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
    expect(body).toMatchObject({ max_tokens: 64 });
  });

  it('wires temperature and topP onto the request body', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
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
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.9 });
  });

  it('wires an effort reasoning config onto the request body via providerOptions', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { effort: 'low' } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('wires a token-budget reasoning config onto the request body via providerOptions', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { max_tokens: 2048 } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { max_tokens: 2048 } });
  });

  it('sets provider.require_parameters iff the request carries reasoning', async () => {
    const bodyOf = async (parameters: Record<string, unknown>): Promise<unknown> => {
      const localRoot = mkdtempSync(path.join(tmpdir(), 'rp-'));
      try {
        const localStore = createCassetteStore({ rootDir: localRoot });
        const adapter = createLanguageAdapter({
          apiKey: 'test-key',
          fetch: createCassetteFetch({
            store: localStore,
            mode: 'record',
            realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
          }),
        });
        await collect(adapter.infer({ ...textRequest('Say hi'), parameters }, testDescriptor()));
        await vi.waitFor(() => {
          expect(localStore.list()).toHaveLength(1);
        });
        const hash = localStore.list()[0];
        return JSON.parse(localStore.read(hash ?? '')?.request?.body ?? '{}');
      } finally {
        rmSync(localRoot, { recursive: true, force: true });
      }
    };

    const withReasoning = z
      .looseObject({ provider: z.looseObject({ require_parameters: z.boolean().optional() }) })
      .parse(await bodyOf({ reasoning: { effort: 'high' } }));
    expect(withReasoning.provider.require_parameters).toBe(true);

    const withoutReasoning = z
      .looseObject({ provider: z.looseObject({ require_parameters: z.boolean().optional() }) })
      .parse(await bodyOf({}));
    expect(withoutReasoning.provider.require_parameters).toBeUndefined();

    // G4: the hard-off shape IS a reasoning-carrying body — the routing
    // guard must fire for it too, so an endpoint that would silently ignore
    // `{ enabled: false }` (and reason anyway) is excluded.
    const withHardOff = z
      .looseObject({ provider: z.looseObject({ require_parameters: z.boolean().optional() }) })
      .parse(await bodyOf({ reasoning: { enabled: false } }));
    expect(withHardOff.provider.require_parameters).toBe(true);
  });

  it('rejects a reasoning config carrying both effort and max_tokens', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('Say hi'), parameters: { reasoning: { effort: 'low', max_tokens: 8 } } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('passes a native effort word outside the canonical labels through to the body', async () => {
    // The positional ladder wires the model's NATIVE vocabulary (`xhigh`,
    // `minimal`, …) — the adapter must carry those words verbatim.
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { effort: 'xhigh' } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { effort: 'xhigh' } });
  });

  it('wires the hard-off reasoning config onto the request body via providerOptions', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { enabled: false } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { enabled: false } });
  });

  it('rejects an enabled-true reasoning config (only the off literal is a wire)', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('Say hi'), parameters: { reasoning: { enabled: true } } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
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
            { id: 'gen_s', provider: 'openai', choices: [{ index: 0, delta: { reasoning: '' } }] },
            { id: 'gen_s', choices: [{ index: 0, delta: { content: '' } }] },
            textDelta('gen_s', 'real'),
            finishChunk('gen_s'),
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
          sseResponse([textDelta('gen_u', 'hi', true), finishChunk('gen_u', { usage: undefined })]),
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

  it('carries the authoritative inline cost on a single-step finish', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    const finish = events.at(-1);
    expect(finish?.kind).toBe('finish');
    expect(finish).toMatchObject({ metadata: { providerCostUsd: 0.12 } });
  });

  it('omits the cost when the provider returns none', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            textDelta('gen_nc', 'hi', true),
            finishChunk('gen_nc', {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    const finish = events.at(-1);
    expect(finish?.kind).toBe('finish');
    expect(finish && 'metadata' in finish && 'providerCostUsd' in finish.metadata).toBe(false);
  });
});

describe('createLanguageAdapter tool loop', () => {
  it('runs the agentic loop with per-step generation ids and per-step costs', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch(toolLoopResponses()),
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
      { kind: 'tool-result', id: 'call-1', name: 'search', result: { hits: 2 } },
      { kind: 'step-finish', step: 0, generationId: 'gen_step1', providerCostUsd: 0.001 },
      { kind: 'step-start', step: 1 },
      { kind: 'text-delta', index: 0, content: 'Found it' },
      { kind: 'step-finish', step: 1, generationId: 'gen_step2', providerCostUsd: 0.002 },
      {
        kind: 'finish',
        metadata: {
          providerCostUsd: 0.003,
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

  it('types the no-endpoints refusal distinctly when the request carries reasoning', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('hi'), parameters: { reasoning: { effort: 'low' } } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'no_reasoning_endpoints' });
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

  it('classifies the mid-stream error fixture as a typed upstream error', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.midStreamError),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'upstream_error' }
    );
  });
});

describe('createLanguageAdapter keep-alive comments', () => {
  it('skips OpenRouter keep-alive comment lines and emits the surrounding real events', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.keepAliveComments),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    expect(events).toEqual([
      { kind: 'step-start', step: 0 },
      { kind: 'text-delta', index: 0, content: 'Hello' },
      { kind: 'text-delta', index: 0, content: ' world' },
      { kind: 'step-finish', step: 0, generationId: 'gen_ka', providerCostUsd: 0.12 },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen_ka',
          providerCostUsd: 0.12,
          usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

describe('createLanguageAdapter abort', () => {
  it('aborts the underlying provider fetch when the signal fires', async () => {
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
  it('treats an empty length-finish as a billable truncation terminal event', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            finishChunk('gen_len', {
              finishReason: 'length',
              usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.12 },
            }),
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_len',
        providerCostUsd: 0.12,
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
        finishReason: 'length',
      },
    });
  });

  it('treats an empty stop-finish as an empty completion error', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse([finishChunk('gen_e')])]),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'empty_completion' }
    );
  });
});

describe('createLanguageAdapter multi-output', () => {
  /** SYNTHETIC: a text+image model streaming an image part through the language shape. */
  function filePartChunks(): unknown[] {
    return [
      {
        id: 'gen_img',
        provider: 'google',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              images: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`,
                  },
                },
              ],
            },
          },
        ],
      },
      finishChunk('gen_img'),
    ];
  }

  it('maps a file part to media events through the injected mapper', async () => {
    const mapped: { part: FilePart; index: number }[] = [];
    const mediaValue: MediaValue = {
      ref: 'media/conv/msg/uuid-1',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 8,
      metadata: {},
    };
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(filePartChunks())]),
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

    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.part.mediaType).toBe('image/png');
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
      fetch: scriptedFetch([() => sseResponse(filePartChunks())]),
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
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
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
      { kind: 'step-finish', step: 0, generationId: 'gen_single', providerCostUsd: 0.12 },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen_single',
          providerCostUsd: 0.12,
          usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

describe('wire message assembly (system + history)', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'first answer' },
  ];

  // A fixed clock so the base system prompt (which renders the current date)
  // is deterministic — the assembled request, and therefore its cassette hash,
  // never drifts by day under test.
  const FIXED_NOW = new Date('2026-07-08T00:00:00.000Z');
  const fixedClock = (): Date => FIXED_NOW;
  const BASE_SYSTEM = buildTurnSystemPrompt({ now: FIXED_NOW });

  // The SDK serializes the top-level `system` prompt as a text-part array,
  // while string message content stays a bare string.
  const systemMessage = (content: string): unknown => ({
    role: 'system',
    content: [{ type: 'text', text: content }],
  });

  interface CapturedCall {
    readonly request: () => Request;
    readonly fetch: typeof globalThis.fetch;
  }

  /** Captures the SDK's outgoing Request while serving one scripted response. */
  function captureFetch(response: () => Response): CapturedCall {
    let captured: Request | undefined;
    return {
      request: () => {
        if (captured === undefined) throw new Error('no request captured');
        return captured;
      },
      fetch: (input, init) => {
        captured = new Request(input, init);
        return Promise.resolve(response());
      },
    };
  }

  async function wireMessages(request: InferenceRequest): Promise<unknown> {
    const call = captureFetch(() => sseResponse(simpleTextChunks()));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: call.fetch,
      now: fixedClock,
    });
    await collect(adapter.infer(request, testDescriptor()));
    const body: { messages: unknown } = await call.request().clone().json();
    return body.messages;
  }

  it('leads every turn with the base system prompt as a system message', async () => {
    const messages = await wireMessages(textRequest('and now?'));
    expect(messages).toEqual([systemMessage(BASE_SYSTEM), { role: 'user', content: 'and now?' }]);
  });

  it('sends no system message at all on a routing-only call', async () => {
    // The classifier's reserve prices its truncated context and the classifier
    // template — the base preamble is neither, so a call that carried it would
    // bill input no reservation covered. Measured at 1,739 characters against a
    // 4,708-character reserve basis whose worst-case emitted input already uses
    // all but 317 of it, so the preamble alone would overrun the headroom.
    const messages = await wireMessages({ ...textRequest('and now?'), routingOnly: true });
    expect(messages).toEqual([{ role: 'user', content: 'and now?' }]);
  });

  it('orders messages system → history → current user', async () => {
    const messages = await wireMessages({ ...textRequest('and now?'), history: HISTORY });
    expect(messages).toEqual([
      systemMessage(BASE_SYSTEM),
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'and now?' },
    ]);
  });

  it('folds client custom instructions into the leading system message', async () => {
    const messages = await wireMessages({
      ...textRequest('and now?'),
      customInstructions: 'Answer only in French.',
    });
    expect(messages).toEqual([
      systemMessage(
        buildTurnSystemPrompt({ now: FIXED_NOW, customInstructions: 'Answer only in French.' })
      ),
      { role: 'user', content: 'and now?' },
    ]);
  });

  it('is byte-identical to the pre-system wire EXCEPT the added base system message', async () => {
    // With no custom instructions, the ONLY delta versus the history-era
    // adapter is the prepended base system message: history + current turn are
    // untouched, so stripping the leading system entry recovers the old shape.
    const withHistory = (await wireMessages({
      ...textRequest('and now?'),
      history: HISTORY,
    })) as unknown[];
    expect(withHistory[0]).toEqual(systemMessage(BASE_SYSTEM));
    expect(withHistory.slice(1)).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'and now?' },
    ]);
  });

  it('preview measurement equals the length of the prompt the adapter sends (system + instructions + history + input)', async () => {
    // The parity the client composer relies on: the shared counter over the
    // shared builder's output measures EXACTLY the text the wire request
    // carries — system prompt (base + custom instructions), resent history,
    // and the current input, with no separators or extra framing. All-ASCII
    // fixtures so the UTF-16 code-unit count the counter uses is also the
    // UTF-8 byte length of the user-controlled text.
    const instructions = 'Answer only in French.';
    const prompt = 'and now?';
    const call = captureFetch(() => sseResponse(simpleTextChunks()));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: call.fetch,
      now: fixedClock,
    });
    await collect(
      adapter.infer(
        { ...textRequest(prompt), history: HISTORY, customInstructions: instructions },
        testDescriptor()
      )
    );
    const body: { messages: { content: string | { text: string }[] }[] } = await call
      .request()
      .clone()
      .json();
    const sentText = body.messages
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.text).join('')
      )
      .join('');

    const measured = promptCharacterCount({
      systemPrompt: buildTurnSystemPrompt({ now: FIXED_NOW, customInstructions: instructions }),
      historyCharacters: historyCharacterCount(HISTORY),
      prompt,
    });
    expect(measured).toBe(sentText.length);
  });

  it('hashes an empty history identically to an absent one (no spurious cassette miss)', async () => {
    const fixture = 'What is the capital of France?';
    const absent = captureFetch(() => sseResponse(simpleTextChunks()));
    await collect(
      createLanguageAdapter({ apiKey: 'test-key', fetch: absent.fetch, now: fixedClock }).infer(
        textRequest(fixture),
        testDescriptor()
      )
    );
    const empty = captureFetch(() => sseResponse(simpleTextChunks()));
    await collect(
      createLanguageAdapter({ apiKey: 'test-key', fetch: empty.fetch, now: fixedClock }).infer(
        { ...textRequest(fixture), history: [] },
        testDescriptor()
      )
    );
    expect(descriptorHash(await requestToDescriptor(empty.request()))).toBe(
      descriptorHash(await requestToDescriptor(absent.request()))
    );
  });

  it('pins the canonical request shape with the base system prompt (cassette baseline)', async () => {
    // This hash is the cassette lookup key derived from the canonical outbound
    // request (fixed clock). Pinning it makes a change in what we send a deliberate
    // edit: the literal moves whenever the request shape does, most often the system
    // prompt text. Cassettes re-record themselves on the next CI run.
    const call = captureFetch(() => sseResponse(simpleTextChunks()));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: call.fetch,
      now: fixedClock,
    });
    await collect(adapter.infer(textRequest('What is the capital of France?'), testDescriptor()));
    expect(descriptorHash(await requestToDescriptor(call.request()))).toBe('4a56488739e04a99');
  });
});
