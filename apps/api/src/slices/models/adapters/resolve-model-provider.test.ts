import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_SYSTEM_PROMPT_MARKER } from '@hushbox/shared';
import { resolveModelProvider } from './resolve-model-provider.js';
import type { CreateModelProviderOptions } from './dispatch.js';
import type { ModelProvider } from '../ports/index.js';
import type { Database } from '@hushbox/db';
import type { InferenceEvent, InferenceRequest, ModelDescriptor } from '@hushbox/shared';

function languageDescriptor(id: string): ModelDescriptor {
  return {
    id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: {},
    zdrReachable: true,
    releasedAt: 1_700_000_000,
    fetchedAt: 0,
  };
}

function textRequest(model: string, text: string): InferenceRequest {
  return { model, inputs: [{ modality: 'text', text }], parameters: {}, outputs: ['text'] };
}

function classifierRequest(model: string): InferenceRequest {
  return textRequest(model, `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose`);
}

async function drainText(provider: ModelProvider, request: InferenceRequest): Promise<string> {
  const model = request.model;
  let text = '';
  for await (const event of provider.infer(request, languageDescriptor(model))) {
    if (event.kind === 'text-delta') text += event.content;
  }
  return text;
}

/** A db whose `insert(...).values(...)` resolves; the insert spy counts evidence writes. */
function spyingDb(): { db: Database; insert: ReturnType<typeof vi.fn> } {
  const values = vi.fn(() => Promise.resolve());
  const insert = vi.fn(() => ({ values }));
  return { db: { insert } as unknown as Database, insert };
}

const EVENT_A: InferenceEvent = { kind: 'text-delta', index: 0, content: 'a' };
const EVENT_B: InferenceEvent = { kind: 'text-delta', index: 1, content: 'b' };

/** A fake provider whose stream yields the given events (built without an async generator). */
function fakeProvider(events: readonly InferenceEvent[]): ModelProvider {
  return {
    infer(): AsyncIterable<InferenceEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
          let index = 0;
          return {
            next(): Promise<IteratorResult<InferenceEvent>> {
              const event = events[index];
              index += 1;
              return Promise.resolve(
                event === undefined
                  ? { value: undefined, done: true }
                  : { value: event, done: false }
              );
            },
          };
        },
      };
    },
  };
}

/** A fake provider whose stream rejects before yielding any event. */
function throwingProvider(): ModelProvider {
  return {
    infer(): AsyncIterable<InferenceEvent> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
          return {
            next(): Promise<IteratorResult<InferenceEvent>> {
              return Promise.reject(new Error('stream failed'));
            },
          };
        },
      };
    },
  };
}

/** Consume a stream, returning every event seen. */
async function drainAll(iterable: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const seen: InferenceEvent[] = [];
  for await (const event of iterable) seen.push(event);
  return seen;
}

const REAL_REQUEST = textRequest('base/model', 'hi');
const DESCRIPTOR = languageDescriptor('base/model');

describe('resolveModelProvider — mock path', () => {
  it('returns the deterministic mock and records no evidence', async () => {
    const { db, insert } = spyingDb();
    const provider = resolveModelProvider({
      useMock: true,
      apiKey: '',
      isCI: false,
      db,
      mockDirectives: { classifierResolution: 'model-A' },
    });
    expect(await drainText(provider, classifierRequest('base/model'))).toBe('model: model-A');
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('resolveModelProvider — dev-server delay defaults (R22.a, composition seam)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the default text delay (no directive) ONLY when isDevServer is true', async () => {
    vi.useFakeTimers();
    const { db } = spyingDb();
    // isDevServer true, empty directives → the 60ms inter-chunk default applies,
    // so a multi-chunk echo cannot settle until the timers advance.
    const provider = resolveModelProvider({
      useMock: true,
      apiKey: '',
      isCI: false,
      db,
      mockDirectives: {},
      isDevServer: true,
    });
    let settled = false;
    const pending = (async (): Promise<string> => {
      const text = await drainText(
        provider,
        textRequest('base/model', 'a prompt long enough to force several echo chunks')
      );
      settled = true;
      return text;
    })();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(60 * 50);
    expect(await pending).toContain('Echo:');
    expect(settled).toBe(true);
  });

  it('streams instantly under the E2E/vitest branch (isDevServer false, no advance)', async () => {
    const { db } = spyingDb();
    // Real timers, never advanced: the echo must resolve without any delay,
    // proving E2E/vitest/CI never inherit the dev-server default.
    const provider = resolveModelProvider({
      useMock: true,
      apiKey: '',
      isCI: false,
      db,
      mockDirectives: {},
      isDevServer: false,
    });
    const text = await drainText(provider, textRequest('base/model', 'no delay here'));
    expect(text).toContain('Echo:');
  });
});

describe('resolveModelProvider — production path', () => {
  it('constructs the real provider with plain fetch (no cassette) and records no evidence', async () => {
    const { db, insert } = spyingDb();
    let captured: CreateModelProviderOptions | undefined;
    const provider = resolveModelProvider(
      { useMock: false, apiKey: 'real-key', isCI: false, db },
      {
        createProvider: (options) => {
          captured = options;
          return fakeProvider([EVENT_A]);
        },
      }
    );
    expect(captured?.fetch).toBeUndefined();
    await drainAll(provider.infer(REAL_REQUEST, DESCRIPTOR));
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('resolveModelProvider — CI-vitest path', () => {
  it('wires a cassette fetch and records OPENROUTER evidence once on first success', async () => {
    const { db, insert } = spyingDb();
    let captured: CreateModelProviderOptions | undefined;
    const provider = resolveModelProvider(
      { useMock: false, apiKey: 'real-key', isCI: true, db },
      {
        createProvider: (options) => {
          captured = options;
          return fakeProvider([EVENT_A, EVENT_B]);
        },
      }
    );
    expect(captured?.fetch).toBeDefined();
    const seen = await drainAll(provider.infer(REAL_REQUEST, DESCRIPTOR));
    expect(seen).toHaveLength(2);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('records no evidence when the stream errors before any event', async () => {
    const { db, insert } = spyingDb();
    const provider = resolveModelProvider(
      { useMock: false, apiKey: 'real-key', isCI: true, db },
      { createProvider: () => throwingProvider() }
    );
    await expect(drainAll(provider.infer(REAL_REQUEST, DESCRIPTOR))).rejects.toThrow(
      /stream failed/
    );
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('resolveModelProvider — fail-fast', () => {
  it('throws on the real path when the API key is empty', () => {
    const { db } = spyingDb();
    expect(() => resolveModelProvider({ useMock: false, apiKey: '', isCI: false, db })).toThrow(
      /OPENROUTER_API_KEY/
    );
  });

  it('throws on the CI-vitest path when the key is the dev mock literal', () => {
    const { db } = spyingDb();
    expect(() =>
      resolveModelProvider({ useMock: false, apiKey: 'mock-openrouter-key', isCI: true, db })
    ).toThrow(/mock/i);
  });

  it('throws on the CI-vitest path when no db is supplied for evidence', () => {
    expect(() =>
      resolveModelProvider({ useMock: false, apiKey: 'real-key', isCI: true, db: undefined })
    ).toThrow(/db/i);
  });
});
