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
        imageEndpointsFixture([{ billable: true, unit: 'image', cost_usd: '0.05' }]),
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.source).toBe('image');
    expect(image.endpointPricing).toEqual([{ billable: true, unit: 'image', costUsd: '0.05' }]);
    expect(image.supportedParameters).toEqual({
      resolution: [],
      aspectRatio: ['1:1', '16:9'],
      maxN: 4,
    });
  });

  it('defaults a missing image pricing billable flag to true', async () => {
    const fetch = catalogFetch({
      images: [imageModelFixture()],
      imageEndpoints: () => imageEndpointsFixture([{ unit: 'image', cost_usd: '0.05' }]),
    });
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    const image = byId(catalog.models, 'google/test-image') as ImageMetadata;
    expect(image.endpointPricing[0]?.billable).toBe(true);
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

  it('caps image endpoint fetch concurrency at six', async () => {
    const images = Array.from({ length: 14 }, (_, index) =>
      imageModelFixture({ id: `prov/img-${String(index)}` })
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new Request(input).url;
      if (url === `${BASE_URL}/models`) return jsonResponse({ data: [] });
      if (url === `${BASE_URL}/endpoints/zdr`) return jsonResponse(zdrBody([]));
      if (url === `${BASE_URL}/videos/models`) return jsonResponse({ data: [] });
      if (url === `${BASE_URL}/images/models`) return jsonResponse({ data: images });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse(imageEndpointsFixture());
    };
    const catalog = await unwrap(fetchGatewayCatalog({ baseUrl: BASE_URL, fetch }));
    expect(catalog.models).toHaveLength(14);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBeGreaterThan(1);
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
      imageEndpoints: () => jsonResponse({ data: { pricing: 'not-a-list' } }),
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
      imageEndpoints: () => jsonResponse({ data: {} }),
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
});
