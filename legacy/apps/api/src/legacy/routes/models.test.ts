import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { Hono } from 'hono';
import { clearModelCache } from '@hushbox/shared/models';
import { modelsRoute } from './models.js';
import { aiClientMiddleware, envMiddleware } from '../middleware/index.js';
import { createMockAIClient } from '../services/ai/mock.js';
import type { AIClient, RawModel } from '../services/ai/types.js';
import type { ModelsListResponse } from '@hushbox/shared';
import type { AppEnv } from '../types.js';

interface PublicModelFixture {
  id: string;
  name?: string;
  description?: string;
  type?: 'language' | 'image' | 'video' | 'embedding' | 'audio';
  pricing?: Record<string, unknown>;
}

/** Public `/v1/models` fixture — ZDR-compliant text models so processModels() keeps them. */
const MOCK_MODELS: PublicModelFixture[] = [
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    description: 'Most capable model',
    type: 'language',
    pricing: { input: '0.00001', output: '0.00003' },
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    description: 'Cheaper model',
    type: 'language',
    pricing: { input: '0.0000005', output: '0.0000015' },
  },
];

let currentFixture: PublicModelFixture[] = MOCK_MODELS;

function setMockModels(models: PublicModelFixture[]): void {
  currentFixture = models;
}

function createTestApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    // Production-mode env so getAIClient constructs the real client, which
    // calls `fetchModels` against the (stubbed) public `/v1/models` endpoint.
    // Local dev / E2E modes would return the in-memory mock instead.
    c.env = {
      NODE_ENV: 'production',
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    } as AppEnv['Bindings'];
    await next();
  });
  app.use('*', envMiddleware());
  app.use('*', aiClientMiddleware());
  app.route('/models', modelsRoute);
  return app;
}

describe('Models Routes', () => {
  beforeEach(() => {
    clearModelCache();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
    currentFixture = MOCK_MODELS;
    // `fetchModels` hits the public `/v1/models` endpoint via raw `fetch`.
    // The stub serves the current fixture without touching the network.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: currentFixture }),
        })
      )
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    currentFixture = MOCK_MODELS;
  });

  describe('GET /models', () => {
    it('returns list of available ZDR models in transformed format', async () => {
      setMockModels(MOCK_MODELS);

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data.models.length).toBeGreaterThan(0);
      const firstModel = data.models.find((m) => m.id === 'openai/gpt-5');
      expect(firstModel).toBeDefined();
      expect(firstModel!.id).toBe('openai/gpt-5');
      expect(firstModel!.name).toBe('GPT-5');
    });

    it('returns models with all required fields', async () => {
      setMockModels(MOCK_MODELS);

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      expect(data.models.length).toBeGreaterThan(0);
      const model = data.models[0]!;

      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('description');
      expect(model).toHaveProperty('provider');
      expect(model).toHaveProperty('contextLength');
      expect(model).toHaveProperty('pricePerInputToken');
      expect(model).toHaveProperty('pricePerOutputToken');
      expect(data).toHaveProperty('premiumModelIds');
      expect(Array.isArray(data.premiumModelIds)).toBe(true);
    });

    it('filters out non-ZDR models', async () => {
      setMockModels([
        ...MOCK_MODELS,
        {
          id: 'fake/non-zdr-model',
          name: 'Fake Non-ZDR',
          description: 'Should be filtered',
          type: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
      ]);

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      const ids = data.models.map((m) => m.id);
      expect(ids).not.toContain('fake/non-zdr-model');
    });

    it('classifies expensive models as premium', async () => {
      setMockModels(MOCK_MODELS);

      const app = createTestApp();
      const response = await app.request('/models');

      const data: ModelsListResponse = await response.json();
      // GPT-5 is more expensive than GPT-4o Mini → should be premium
      expect(data.premiumModelIds).toContain('openai/gpt-5');
    });

    it('returns empty models list when no ZDR-compliant models in response', async () => {
      setMockModels([
        {
          id: 'fake/not-zdr',
          name: 'Fake',
          description: 'Not on allow-list',
          type: 'language',
          pricing: { input: '0.00001', output: '0.00003' },
        },
      ]);

      const app = createTestApp();
      const response = await app.request('/models');

      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data.models).toEqual([]);
    });

    it('returns 500 in production when AI_GATEWAY_API_KEY is missing', async () => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.env = { NODE_ENV: 'production' } as AppEnv['Bindings'];
        await next();
      });
      app.use('*', envMiddleware());
      app.use('*', aiClientMiddleware());
      app.route('/models', modelsRoute);

      const response = await app.request('/models');
      expect(response.status).toBe(500);
    });

    it('reads the catalog from c.var.aiClient.listRawModels — never touches env keys', async () => {
      const customRaw: RawModel[] = [
        {
          id: 'anthropic/claude-sonnet-4.6',
          name: 'Sentinel Sonnet',
          description: 'Custom catalog injected via aiClient',
          modality: 'text',
          context_length: 200_000,
          pricing: { prompt: '0.000003', completion: '0.000015' },
          supported_parameters: [],
          created: 0,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];
      const stubClient: AIClient = {
        ...createMockAIClient(),
        listRawModels: () => Promise.resolve(customRaw),
      };

      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        // Intentionally NO AI_GATEWAY_API_KEY — proves the route never reads it.
        c.env = {} as AppEnv['Bindings'];
        c.set('aiClient', stubClient);
        await next();
      });
      app.route('/models', modelsRoute);

      const response = await app.request('/models');
      expect(response.status).toBe(200);
      const data: ModelsListResponse = await response.json();
      expect(data.models.find((m) => m.id === 'anthropic/claude-sonnet-4.6')?.name).toBe(
        'Sentinel Sonnet'
      );
    });
  });
});
