import { describe, expect, it } from 'vitest';
import {
  TEST_GATEWAY_BASE_URL,
  configFixture,
  endpointsFixture,
  jsonResponse,
  modelEntryFixture,
  routedFetch,
} from './gateway-fixtures.js';
import { fetchGatewayCatalog } from './gateway-metadata.js';

const BASE_URL = TEST_GATEWAY_BASE_URL;

describe('fetchGatewayCatalog', () => {
  it('merges the model list with per-model endpoint metadata', async () => {
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture()], ['openai'])),
      endpoints: () => jsonResponse(endpointsFixture()),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    const catalog = result._unsafeUnwrap();
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      id: 'openai/gpt-test',
      provider: 'openai',
      modelType: 'language',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportedParameters: ['temperature', 'top_p', 'max_output_tokens'],
      contextLength: 128_000,
      endpointProviders: ['openai'],
    });
    expect(catalog.models[0]?.pricing).toEqual({ input: '0.0000025', output: '0.00001' });
  });

  it('exposes the gateway ZDR provider list as a set', async () => {
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture()], ['openai', 'google'])),
      endpoints: () => jsonResponse(endpointsFixture()),
    });
    const catalogResult = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    const catalog = catalogResult._unsafeUnwrap();
    expect(catalog.zdrProviders.has('google')).toBe(true);
    expect(catalog.zdrProviders.has('mystery')).toBe(false);
  });

  it('treats a missing ZDR provider list as empty (fail-closed)', async () => {
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture()])),
      endpoints: () => jsonResponse(endpointsFixture()),
    });
    const catalogResult = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    const catalog = catalogResult._unsafeUnwrap();
    expect(catalog.zdrProviders.size).toBe(0);
  });

  it('defaults absent endpoint detail fields to empty metadata', async () => {
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture({ pricing: null })])),
      endpoints: () => jsonResponse({ data: {} }),
    });
    const catalogResult = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    const catalog = catalogResult._unsafeUnwrap();
    expect(catalog.models[0]).toMatchObject({
      inputModalities: [],
      outputModalities: [],
      supportedParameters: [],
      endpointProviders: [],
    });
    expect(catalog.models[0]?.pricing).toBeUndefined();
    expect(catalog.models[0]?.contextLength).toBeUndefined();
  });

  it('normalizes a null modelType to undefined', async () => {
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture({ modelType: null })])),
      endpoints: () => jsonResponse(endpointsFixture()),
    });
    const catalogResult = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    const catalog = catalogResult._unsafeUnwrap();
    expect(catalog.models[0]?.modelType).toBeUndefined();
  });

  it('caps endpoint fetch concurrency at six', async () => {
    const models = Array.from({ length: 14 }, (_, index) =>
      modelEntryFixture({ id: `prov/m-${String(index)}` })
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const fetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = new Request(input).url;
      if (url.endsWith('/config')) return jsonResponse(configFixture(models, ['prov']));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse(endpointsFixture());
    };
    const catalogResult = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    const catalog = catalogResult._unsafeUnwrap();
    expect(catalog.models).toHaveLength(14);
    expect(maxInFlight).toBeLessThanOrEqual(6);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('fails unavailable when the model list endpoint returns an HTTP error', async () => {
    const fetch = routedFetch({ config: () => jsonResponse({}, 503) });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails unavailable when an endpoints fetch returns an HTTP error', async () => {
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture()], ['openai'])),
      endpoints: () => jsonResponse({}, 500),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails validation on model list schema drift', async () => {
    const fetch = routedFetch({ config: () => jsonResponse({ models: [{ nope: true }] }) });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails validation on endpoints schema drift', async () => {
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture()])),
      endpoints: () => jsonResponse({ data: { endpoints: 'not-a-list' } }),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails unavailable when the network call itself rejects', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.reject(new Error('socket hangup'));
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('fails validation when the model list body is not JSON', async () => {
    const fetch = routedFetch({
      config: () => new Response('<html>maintenance</html>', { status: 200 }),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('fails unavailable when an endpoints fetch rejects', async () => {
    // No endpoints route: the fixture rejects the tier-2 request outright.
    const fetch = routedFetch({
      config: () => jsonResponse(configFixture([modelEntryFixture()], ['openai'])),
    });
    const result = await fetchGatewayCatalog({ baseUrl: BASE_URL, fetch });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});
