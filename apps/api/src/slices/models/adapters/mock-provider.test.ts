import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLASSIFIER_SYSTEM_PROMPT_MARKER, SMART_MODEL_ID } from '@hushbox/shared';
import {
  MOCK_ECHO_PREFIX,
  createMockModelProvider,
  mockDirectivesFor,
  mockProviderEnabled,
  parseMockDirectives,
} from './mock-provider.js';
import type { InferenceEvent, InferenceRequest, ModelDescriptor } from '@hushbox/shared';

/** A minimal language-family descriptor for the given model id. */
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

/** A classifier request: the system prompt (marker-prefixed) rides as the first input part. */
function classifierRequest(model: string): InferenceRequest {
  return {
    model,
    inputs: [
      { modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose a model` },
      { modality: 'text', text: 'the latest exchange' },
    ],
    parameters: { maxOutputTokens: 32 },
    outputs: ['text'],
  };
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textOf(events: readonly InferenceEvent[]): string {
  return events
    .filter(
      (event): event is Extract<InferenceEvent, { kind: 'text-delta' }> =>
        event.kind === 'text-delta'
    )
    .map((event) => event.content)
    .join('');
}

function finishOf(events: readonly InferenceEvent[]): Extract<InferenceEvent, { kind: 'finish' }> {
  const finish = events.find(
    (event): event is Extract<InferenceEvent, { kind: 'finish' }> => event.kind === 'finish'
  );
  if (finish === undefined) throw new Error('expected a finish event');
  return finish;
}

describe('parseMockDirectives', () => {
  function getterFor(headers: Record<string, string>): (name: string) => string | undefined {
    return (name) => headers[name];
  }

  it('reads x-mock-classifier-resolution into classifierResolution', () => {
    const directives = parseMockDirectives(
      getterFor({ 'x-mock-classifier-resolution': 'a/model' })
    );
    expect(directives).toEqual({ classifierResolution: 'a/model' });
  });

  it('reads x-mock-classifier-failure=true into classifierFailure', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-failure': 'true' }));
    expect(directives).toEqual({ classifierFailure: true });
  });

  it('ignores x-mock-classifier-failure when not exactly "true"', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-failure': '1' }));
    expect(directives).toEqual({});
  });

  it('splits x-mock-failing-models CSV into a trimmed non-empty list', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-failing-models': ' a/x , , b/y ' }));
    expect(directives).toEqual({ failingModels: ['a/x', 'b/y'] });
  });

  it('drops x-mock-failing-models when the CSV yields no ids', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-failing-models': ' , ' }));
    expect(directives).toEqual({});
  });

  it('reads a positive x-mock-classifier-delay-ms into classifierDelayMs', () => {
    const directives = parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': '250' }));
    expect(directives).toEqual({ classifierDelayMs: 250 });
  });

  it('ignores a non-positive or non-numeric classifier delay', () => {
    expect(parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': '0' }))).toEqual({});
    expect(parseMockDirectives(getterFor({ 'x-mock-classifier-delay-ms': 'nope' }))).toEqual({});
  });

  it('combines all four knobs from one request', () => {
    const directives = parseMockDirectives(
      getterFor({
        'x-mock-classifier-resolution': 'a/model',
        'x-mock-classifier-failure': 'true',
        'x-mock-failing-models': 'c/z',
        'x-mock-classifier-delay-ms': '10',
      })
    );
    expect(directives).toEqual({
      classifierResolution: 'a/model',
      classifierFailure: true,
      failingModels: ['c/z'],
      classifierDelayMs: 10,
    });
  });

  it('returns an empty directive set when no headers are present', () => {
    expect(parseMockDirectives(getterFor({}))).toEqual({});
  });
});

describe('mockProviderEnabled / mockDirectivesFor', () => {
  const headers = { 'x-mock-classifier-resolution': 'a/model' };
  const get = (name: string): string | undefined => (headers as Record<string, string>)[name];

  it('is enabled in local dev and E2E, disabled otherwise', () => {
    expect(mockProviderEnabled({ isLocalDev: true, isE2E: false, isProduction: false })).toBe(true);
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: true, isProduction: false })).toBe(true);
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: false, isProduction: false })).toBe(
      false
    );
  });

  it('stays false in production even if a spurious E2E flag leaks in', () => {
    expect(mockProviderEnabled({ isLocalDev: false, isE2E: true, isProduction: true })).toBe(false);
    expect(mockProviderEnabled({ isLocalDev: true, isE2E: false, isProduction: true })).toBe(false);
  });

  it('parses directives when the mock is enabled (dev/E2E)', () => {
    expect(mockDirectivesFor({ isLocalDev: true, isE2E: false, isProduction: false }, get)).toEqual(
      {
        classifierResolution: 'a/model',
      }
    );
  });

  it('is inert when the mock is disabled — headers are never read (production/CI)', () => {
    expect(
      mockDirectivesFor({ isLocalDev: false, isE2E: false, isProduction: false }, get)
    ).toEqual({});
  });
});

describe('createMockModelProvider — language echo', () => {
  it('echoes the prompt as streamed text with a billable finish', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(`${MOCK_ECHO_PREFIX} hello`);
    const finish = finishOf(events);
    expect(finish.metadata.finishReason).toBe('stop');
    // The inline provider cost makes settlement bill authoritative (not estimated).
    expect(finish.metadata.providerCostUsd).toBeGreaterThan(0);
    expect(finish.metadata.generationId).toBeDefined();
  });

  it('mints a distinct generation id per call', async () => {
    const provider = createMockModelProvider();
    const first = finishOf(
      await collect(provider.infer(textRequest('a/model', 'one'), languageDescriptor('a/model')))
    );
    const second = finishOf(
      await collect(provider.infer(textRequest('a/model', 'two'), languageDescriptor('a/model')))
    );
    expect(first.metadata.generationId).not.toBe(second.metadata.generationId);
  });
});

describe('createMockModelProvider — failing-models knob', () => {
  it('throws a typed InferenceError for a listed failing model', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/model'] });
    await expect(
      collect(provider.infer(textRequest('bad/model', 'hi'), languageDescriptor('bad/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });

  it('lets an unlisted model succeed while a listed one fails', async () => {
    const provider = createMockModelProvider({ failingModels: ['bad/model'] });
    const ok = await collect(
      provider.infer(textRequest('good/model', 'hi'), languageDescriptor('good/model'))
    );
    expect(textOf(ok)).toBe(`${MOCK_ECHO_PREFIX} hi`);
    await expect(
      collect(provider.infer(textRequest('bad/model', 'hi'), languageDescriptor('bad/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });
});

describe('createMockModelProvider — classifier knobs', () => {
  it('emits the directed resolution as the classifier output', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const events = await collect(
      provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
    );
    expect(textOf(events)).toBe('picked/model');
    expect(finishOf(events).metadata.providerCostUsd).toBeGreaterThan(0);
  });

  it('defaults the resolution to the classifier model id (cheapest candidate)', async () => {
    const provider = createMockModelProvider();
    const events = await collect(
      provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
    );
    expect(textOf(events)).toBe('cheap/model');
  });

  it('throws a typed InferenceError when classifier-failure is set', async () => {
    const provider = createMockModelProvider({ classifierFailure: true });
    await expect(
      collect(provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model')))
    ).rejects.toMatchObject({ name: 'InferenceError' });
  });

  it('does not treat a plain (non-marker) request as a classifier call', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const events = await collect(
      provider.infer(textRequest('a/model', 'hello'), languageDescriptor('a/model'))
    );
    // A plain turn echoes; the classifier resolution never leaks into it.
    expect(textOf(events)).toBe(`${MOCK_ECHO_PREFIX} hello`);
  });

  it('resolves a classifier request whose only input is the marker system prompt', async () => {
    const provider = createMockModelProvider({ classifierResolution: 'picked/model' });
    const markerOnly: InferenceRequest = {
      model: 'cheap/model',
      inputs: [{ modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose` }],
      parameters: {},
      outputs: ['text'],
    };
    const events = await collect(provider.infer(markerOnly, languageDescriptor('cheap/model')));
    expect(textOf(events)).toBe('picked/model');
  });
});

describe('createMockModelProvider — classifier delay knob', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gates the classifier stream by classifier-delay-ms', async () => {
    vi.useFakeTimers();
    const provider = createMockModelProvider({
      classifierResolution: 'picked/model',
      classifierDelayMs: 1000,
    });
    let settled = false;
    const pending = (async (): Promise<InferenceEvent[]> => {
      const events = await collect(
        provider.infer(classifierRequest('cheap/model'), languageDescriptor('cheap/model'))
      );
      settled = true;
      return events;
    })();
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const events = await pending;
    expect(settled).toBe(true);
    expect(textOf(events)).toBe('picked/model');
  });

  it('does not delay a plain (non-classifier) turn', async () => {
    const provider = createMockModelProvider({ classifierDelayMs: 100_000 });
    const events = await collect(
      provider.infer(textRequest('a/model', 'hi'), languageDescriptor('a/model'))
    );
    expect(textOf(events)).toBe(`${MOCK_ECHO_PREFIX} hi`);
  });
});

describe('createMockModelProvider — refusals', () => {
  it('refuses a media-family descriptor with a typed unsupported-modality error', async () => {
    const provider = createMockModelProvider();
    const imageDescriptor: ModelDescriptor = {
      ...languageDescriptor('img/model'),
      outputs: ['image'],
    };
    await expect(
      collect(provider.infer(textRequest('img/model', 'hi'), imageDescriptor))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'unsupported_modality' });
  });

  it('refuses the virtual smart-model sentinel (it must be resolved before inference)', async () => {
    const provider = createMockModelProvider();
    await expect(
      collect(provider.infer(textRequest(SMART_MODEL_ID, 'hi'), languageDescriptor(SMART_MODEL_ID)))
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });
});
