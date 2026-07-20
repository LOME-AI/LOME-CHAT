import { describe, it, expect, beforeAll } from 'vitest';
import {
  clearTestModelCache,
  consumeStream,
  getCheapestTestModel,
  setupIntegrationClient,
} from './test-utilities.js';
import type { AIClient, TextRequest } from './types.js';

const TEXT_TIMEOUT_MS = 30_000;

const MIN_DISTINCT_PROVIDERS = 2;

describe('AIClient real integration', () => {
  let client: AIClient;

  beforeAll(() => {
    clearTestModelCache();
    const setup = setupIntegrationClient();
    client = setup.client;
  });

  describe('listModels', () => {
    it(
      'returns ModelInfo entries with the expected discriminated shape',
      async () => {
        const models = await client.listModels();
        expect(models.length).toBeGreaterThan(0);
        for (const model of models) {
          expect(model.id).toBeTruthy();
          expect(model.name).toBeTruthy();
          expect(model.provider).toBeTruthy();
          expect(['text', 'image', 'audio', 'video']).toContain(model.modality);
          expect(['token', 'image', 'audio', 'video']).toContain(model.pricing.kind);
        }
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'includes at least one ZDR-listed model so the chat tier-gate has something to lock',
      async () => {
        const models = await client.listModels();
        const zdrModels = models.filter((m) => m.isZdr);
        expect(zdrModels.length).toBeGreaterThan(0);
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'spans multiple distinct providers',
      async () => {
        const models = await client.listModels();
        const distinctProviders = new Set(models.map((m) => m.provider));
        expect(distinctProviders.size).toBeGreaterThanOrEqual(MIN_DISTINCT_PROVIDERS);
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('getModel', () => {
    it(
      'returns the requested model by id',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        const model = await client.getModel(spec.modelId);
        expect(model.id).toBe(spec.modelId);
        expect(model.modality).toBe('text');
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'rejects for an unknown model id',
      async () => {
        await expect(
          client.getModel('nonexistent/model-that-does-not-exist')
        ).rejects.toBeDefined();
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('stream(text)', () => {
    it(
      'produces text content and a finish event with providerMetadata.generationId',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: 'Reply with a short greeting.' }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.textContent.length).toBeGreaterThan(0);
        expect(result.events.at(-1)?.kind).toBe('finish');
        expect(result.generationId).toBeDefined();
        expect(result.generationId?.length ?? 0).toBeGreaterThan(0);
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'streams multiple events incrementally rather than one buffered chunk',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [{ role: 'user', content: 'Write a one-sentence reply.' }],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.events.length).toBeGreaterThan(1);
      },
      TEXT_TIMEOUT_MS
    );

    it(
      'produces non-empty content for a system + user message',
      async () => {
        const spec = await getCheapestTestModel(client, 'text');
        if (spec.parameters.kind !== 'text') throw new Error('expected text spec');
        const request: TextRequest = {
          modality: 'text',
          model: spec.modelId,
          messages: [
            { role: 'system', content: 'You are a concise assistant.' },
            { role: 'user', content: 'Say hello.' },
          ],
          maxOutputTokens: spec.parameters.maxOutputTokens,
        };
        const result = await consumeStream(client.stream(request));
        expect(result.textContent.length).toBeGreaterThan(0);
      },
      TEXT_TIMEOUT_MS
    );
  });

  describe('ZDR enforcement', () => {
    it(
      'flags ZDR-listed entries with isZdr === true',
      async () => {
        // The public `/v1/models` endpoint exposes the full Vercel AI Gateway
        // catalog; `listModels` no longer narrows to ZDR. ZDR enforcement
        // happens downstream in `processModels` (route serving) and at the
        // SDK provider-options boundary in `real.ts`. Verify the `isZdr`
        // flag flips correctly for at least one entry on the allow-list.
        const models = await client.listModels();
        const zdrText = models.find((m) => m.modality === 'text' && m.isZdr);
        expect(zdrText).toBeDefined();
      },
      TEXT_TIMEOUT_MS
    );
  });
});
