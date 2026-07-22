import { describe, expect, it } from 'vitest';
import { fetchGatewayCatalog } from './gateway-metadata.js';
import {
  TEST_GATEWAY_BASE_URL,
  catalogFetch,
  imageEndpointsFixture,
  imageModelFixture,
  jsonResponse,
  modelEntryFixture,
  routedFetch,
  videoModelFixture,
  zdrBody,
} from './gateway-fixtures.js';
import type {
  GatewayCatalog,
  ImageMetadata,
  LanguageMetadata,
  VideoMetadata,
} from './gateway-metadata.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

const BASE_URL = TEST_GATEWAY_BASE_URL;

async function unwrap(result: ResultAsync<GatewayCatalog, DomainError>): Promise<GatewayCatalog> {
  const settled = await result;
  return settled._unsafeUnwrap();
}

function byId<T extends { readonly id: string }>(models: readonly T[], id: string): T {
  const found = models.find((model) => model.id === id);
  if (found === undefined) throw new Error(`no model ${id}`);
  return found;
}

describe('fetchGatewayCatalog', () => {
  it('fetches and merges the four catalog endpoints', async () => {
    const fetch = catalogFetch({
      models: [modelEntryFixture()],
      images: [imageModelFixture()],
      videos: [videoModelFixture()],
      zdrModelIds: ['openai/gpt-test'],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect(catalog.models.map((m) => m.source).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'image',
      'language',
      'video',
    ]);
    const language = byId(catalog.models, 'openai/gpt-test') as LanguageMetadata;
    expect(language).toMatchObject({
      source: 'language',
      provider: 'openai',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['temperature', 'top_p', 'max_output_tokens'],
      contextLength: 128_000,
      deprecated: false,
    });
    expect(language.pricing).toEqual({
      prompt: '0.0000025',
      completion: '0.00001',
      cacheRead: undefined,
    });
  });

  it('captures each source description for the classifier prompt', async () => {
    const fetch = catalogFetch({
      models: [modelEntryFixture({ description: 'A test model' })],
      images: [imageModelFixture({ description: 'Draws pictures' })],
      videos: [videoModelFixture({ description: 'Makes movies' })],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect(byId(catalog.models, 'openai/gpt-test').description).toBe('A test model');
    expect(byId(catalog.models, 'google/test-image').description).toBe('Draws pictures');
    expect(byId(catalog.models, 'google/test-video').description).toBe('Makes movies');
  });

  it('leaves description undefined when a source entry carries none', async () => {
    const fetch = catalogFetch({
      models: [modelEntryFixture({ description: null })],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect(byId(catalog.models, 'openai/gpt-test').description).toBeUndefined();
  });

  it('derives ZDR membership as a set of model ids', async () => {
    const fetch = catalogFetch({
      models: [modelEntryFixture()],
      zdrModelIds: ['openai/gpt-test', 'google/other'],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect(catalog.zdrModelIds.has('openai/gpt-test')).toBe(true);
    expect(catalog.zdrModelIds.has('google/other')).toBe(true);
    expect(catalog.zdrModelIds.has('missing/model')).toBe(false);
  });

  it('fetches per-image-model pricing from the N+1 endpoints call', async () => {
    const fetch = catalogFetch({
      images: [imageModelFixture()],
      imageEndpoints: () =>
        imageEndpointsFixture([{ billable: 'output_image', unit: 'image', cost_usd: '0.05' }]),
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.source).toBe('image');
    expect(image.endpointPricing).toEqual([
      { billable: 'output_image', unit: 'image', costUsd: '0.05' },
    ]);
    expect(image.supportedParameters).toEqual({
      resolution: [],
      aspectRatio: ['1:1', '16:9'],
      maxN: 4,
    });
  });

  it('extracts enum values, a range max, and tolerates other parameter types', async () => {
    const fetch = catalogFetch({
      images: [
        imageModelFixture({
          supported_parameters: {
            resolution: { type: 'enum', values: ['1K'] },
            aspect_ratio: { type: 'enum', values: ['1:1', '9:16'] },
            n: { type: 'range', min: 1, max: 1 },
            // A boolean-typed param and a range on an unextracted key must not
            // break parsing — the descriptor exposes none of them.
            seed: { type: 'boolean' },
            input_references: { type: 'range', min: 0, max: 14 },
          },
        }),
      ],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.supportedParameters).toEqual({
      resolution: ['1K'],
      aspectRatio: ['1:1', '9:16'],
      maxN: 1,
    });
  });

  it('drops a single parameter of an unexpected shape without failing the model', async () => {
    const fetch = catalogFetch({
      images: [
        imageModelFixture({
          // `resolution` arriving as a range instead of an enum is dropped
          // per-field; the model is still cataloged with its valid params.
          supported_parameters: {
            resolution: { type: 'range', min: 1, max: 4 },
            aspect_ratio: { type: 'enum', values: ['1:1'] },
          },
        }),
      ],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.supportedParameters).toEqual({
      resolution: [],
      aspectRatio: ['1:1'],
      maxN: undefined,
    });
  });

  it('carries the billable role and stringifies a numeric cost_usd', async () => {
    const fetch = catalogFetch({
      images: [imageModelFixture()],
      imageEndpoints: () =>
        imageEndpointsFixture([
          { billable: 'output_image', unit: 'token', cost_usd: 3e-5 },
          { billable: 'input_image', unit: 'token', cost_usd: 1e-6 },
        ]),
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.endpointPricing).toEqual([
      { billable: 'output_image', unit: 'token', costUsd: '0.00003' },
      { billable: 'input_image', unit: 'token', costUsd: '0.000001' },
    ]);
  });

  it('leaves billable undefined when a pricing row omits it', async () => {
    const fetch = catalogFetch({
      images: [imageModelFixture()],
      imageEndpoints: () => imageEndpointsFixture([{ unit: 'image', cost_usd: 0.05 }]),
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.endpointPricing[0]?.billable).toBeUndefined();
  });

  it('carries the raw video SKU dict and derived params through', async () => {
    const fetch = catalogFetch({ videos: [videoModelFixture()] });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const video = byId(catalog.models, 'google/test-video') as VideoMetadata;
    expect(video).toMatchObject({
      source: 'video',
      provider: 'google',
      generateAudio: true,
      seed: true,
      resolutions: ['720p', '1080p'],
      durations: ['4', '8'],
    });
    expect(video.pricingSkus).toEqual({
      duration_seconds_720p: '0.0988',
      duration_seconds_1080p: '0.15',
    });
  });

  it('derives provider from a model id without a slash', async () => {
    const fetch = catalogFetch({ models: [modelEntryFixture({ id: 'solomodel' })] });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect(byId(catalog.models, 'solomodel').provider).toBe('solomodel');
  });

  it('marks a model with an expiration date as deprecated', async () => {
    const fetch = catalogFetch({ models: [modelEntryFixture({ expiration_date: '2026-01-01' })] });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect((byId(catalog.models, 'openai/gpt-test') as LanguageMetadata).deprecated).toBe(true);
  });

  it('defaults absent language fields to empty metadata', async () => {
    const fetch = catalogFetch({
      models: [{ id: 'bare/model' }],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const language = byId(catalog.models, 'bare/model') as LanguageMetadata;
    expect(language).toMatchObject({
      inputModalities: [],
      outputModalities: [],
      supportedParameters: [],
      contextLength: undefined,
      pricing: undefined,
      deprecated: false,
    });
  });

  /** A fetch that serves 14 image models and records peak concurrent
   * `/endpoints` fan-out — the observable the N+1 batch cap controls. */
  function concurrencyProbe(): { readonly fetch: typeof globalThis.fetch; peak: () => number } {
    const images = Array.from({ length: 14 }, (_, index) =>
      imageModelFixture({ id: `prov/img-${String(index)}` })
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new Request(input).url;
      // Match by pathname: the language `/models` fetch carries `?sort=top-weekly`.
      const pathname = new URL(url).pathname;
      if (pathname === new URL(`${BASE_URL}/models`).pathname) return jsonResponse({ data: [] });
      if (pathname === new URL(`${BASE_URL}/endpoints/zdr`).pathname)
        return jsonResponse(zdrBody([]));
      if (pathname === new URL(`${BASE_URL}/videos/models`).pathname)
        return jsonResponse({ data: [] });
      if (pathname === new URL(`${BASE_URL}/images/models`).pathname)
        return jsonResponse({ data: images });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse(imageEndpointsFixture());
    };
    return { fetch, peak: () => maxInFlight };
  }

  it('caps image endpoint fetch concurrency at six by default', async () => {
    const probe = concurrencyProbe();
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch: probe.fetch }));
    expect(catalog.models).toHaveLength(14);
    expect(probe.peak()).toBeLessThanOrEqual(6);
    expect(probe.peak()).toBeGreaterThan(1);
  });

  it('honors a lower threaded endpoint concurrency', async () => {
    const probe = concurrencyProbe();
    const catalog = await unwrap(
      fetchGatewayCatalog({ baseUrl: BASE_URL, fetch: probe.fetch, endpointConcurrency: 3 })
    );
    expect(catalog.models).toHaveLength(14);
    expect(probe.peak()).toBeLessThanOrEqual(3);
    expect(probe.peak()).toBeGreaterThan(1);
  });

  it('fans out past the six-cap when a higher concurrency is threaded (dev)', async () => {
    const probe = concurrencyProbe();
    const catalog = await unwrap(
      fetchGatewayCatalog({ baseUrl: BASE_URL, fetch: probe.fetch, endpointConcurrency: 30 })
    );
    expect(catalog.models).toHaveLength(14);
    // 30 > 14, so every `/endpoints` fetch runs in a single batch.
    expect(probe.peak()).toBe(14);
  });

  it.each([
    ['models', () => routedFetch({ models: () => jsonResponse({}, 503) })],
    ['endpoints/zdr', () => routedFetch({ zdr: () => jsonResponse({}, 503) })],
    ['images/models', () => routedFetch({ images: () => jsonResponse({}, 500) })],
    ['videos/models', () => routedFetch({ videos: () => jsonResponse({}, 502) })],
  ])('fails unavailable on an HTTP error from %s', async (_label, makeFetch) => {
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch: makeFetch() });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails unavailable when an image endpoints fetch returns an HTTP error', async () => {
    const fetch = routedFetch({
      images: () => jsonResponse({ data: [imageModelFixture()] }),
      imageEndpoints: () => jsonResponse({}, 500),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it.each([
    ['models', () => routedFetch({ models: () => jsonResponse({ data: [{ nope: true }] }) })],
    ['endpoints/zdr', () => routedFetch({ zdr: () => jsonResponse({ data: [{ nope: true }] }) })],
    [
      'images/models',
      () => routedFetch({ images: () => jsonResponse({ data: [{ nope: true }] }) }),
    ],
    [
      'videos/models',
      () => routedFetch({ videos: () => jsonResponse({ data: [{ nope: true }] }) }),
    ],
  ])('fails validation on schema drift from %s', async (_label, makeFetch) => {
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch: makeFetch() });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails validation when an image endpoints body has a non-array pricing', async () => {
    const fetch = routedFetch({
      images: () => jsonResponse({ data: [imageModelFixture()] }),
      imageEndpoints: () =>
        jsonResponse({ id: 'google/test-image', endpoints: [{ pricing: 'not-a-list' }] }),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails unavailable when the network call itself rejects', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.reject(new Error('socket hangup'));
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails validation when a list body is not JSON', async () => {
    const fetch = routedFetch({
      models: () => new Response('<html>maintenance</html>', { status: 200 }),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('defaults absent image endpoint pricing to an empty list', async () => {
    const fetch = routedFetch({
      images: () => jsonResponse({ data: [imageModelFixture()] }),
      imageEndpoints: () => jsonResponse({ id: 'google/test-image', endpoints: [] }),
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.endpointPricing).toEqual([]);
  });

  it('defaults every absent image and video field to empty metadata', async () => {
    const fetch = routedFetch({
      images: () => jsonResponse({ data: [{ id: 'x/bare-img' }] }),
      imageEndpoints: () => jsonResponse(imageEndpointsFixture()),
      videos: () => jsonResponse({ data: [{ id: 'x/bare-vid' }] }),
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'x/bare-img') as ImageMetadata;
    expect(image.inputModalities).toEqual(['text']);
    expect(image.supportedParameters).toEqual({ resolution: [], aspectRatio: [], maxN: undefined });
    const video = byId(catalog.models, 'x/bare-vid') as VideoMetadata;
    expect(video).toMatchObject({
      supportsFrameImages: false,
      generateAudio: false,
      seed: false,
      resolutions: [],
      aspectRatios: [],
      durations: [],
    });
    expect(video.pricingSkus).toEqual({});
  });

  it('fails unavailable when an image model has no endpoints route to fetch', async () => {
    const fetch = routedFetch({ images: () => jsonResponse({ data: [imageModelFixture()] }) });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('the fixture rejects an unrouted URL', async () => {
    const fetch = routedFetch({});
    await expect(fetch(`${BASE_URL}/unknown`)).rejects.toThrow('unrouted');
  });

  it('sorts the language models fetch by top-weekly usage rank', async () => {
    const seen: string[] = [];
    const base = catalogFetch({ models: [modelEntryFixture()], zdrModelIds: ['openai/gpt-test'] });
    const fetch: typeof globalThis.fetch = (input, init) => {
      seen.push(new Request(input).url);
      return base(input, init);
    };
    await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect(seen).toContain(`${BASE_URL}/models?sort=top-weekly`);
  });

  it('captures the top-level reasoning object as camelCased metadata', async () => {
    const fetch = catalogFetch({
      models: [
        modelEntryFixture({
          reasoning: {
            mandatory: true,
            supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'],
            default_effort: 'medium',
            default_enabled: true,
          },
        }),
      ],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect((byId(catalog.models, 'openai/gpt-test') as LanguageMetadata).reasoning).toEqual({
      mandatory: true,
      supportedEfforts: ['xhigh', 'high', 'medium', 'low', 'none'],
      defaultEffort: 'medium',
      defaultEnabled: true,
    });
  });

  it('leaves reasoning undefined when the entry carries no reasoning object', async () => {
    const fetch = catalogFetch({ models: [modelEntryFixture()] });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect((byId(catalog.models, 'openai/gpt-test') as LanguageMetadata).reasoning).toBeUndefined();
  });

  it('preserves a null supported_efforts (all-accepted) distinct from an absent one', async () => {
    const fetch = catalogFetch({
      models: [modelEntryFixture({ reasoning: { mandatory: false, supported_efforts: null } })],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect((byId(catalog.models, 'openai/gpt-test') as LanguageMetadata).reasoning).toEqual({
      mandatory: false,
      supportedEfforts: null,
    });
  });

  it('omits reasoning sub-fields the entry leaves null or absent', async () => {
    const fetch = catalogFetch({
      models: [
        modelEntryFixture({
          reasoning: { mandatory: true, default_effort: null, default_enabled: null },
        }),
      ],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect((byId(catalog.models, 'openai/gpt-test') as LanguageMetadata).reasoning).toEqual({
      mandatory: true,
    });
  });

  it('assigns each language model its 0-based gateway index as popularityRank', async () => {
    const fetch = catalogFetch({
      models: [
        modelEntryFixture({ id: 'a/one' }),
        modelEntryFixture({ id: 'b/two' }),
        modelEntryFixture({ id: 'c/three' }),
      ],
      zdrModelIds: ['a/one', 'b/two', 'c/three'],
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect((byId(catalog.models, 'a/one') as LanguageMetadata).popularityRank).toBe(0);
    expect((byId(catalog.models, 'b/two') as LanguageMetadata).popularityRank).toBe(1);
    expect((byId(catalog.models, 'c/three') as LanguageMetadata).popularityRank).toBe(2);
  });
});
