import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

import { Hono } from 'hono';
import { clearModelCache } from '@hushbox/shared/models';
import { trialChatRoute } from './trial-chat.js';
import { createMockAIClient } from '../services/ai/mock.js';
import type { AppEnv } from '../types.js';

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

interface PublicModelFixture {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  pricing?: Record<string, unknown>;
  context_window?: number;
  created?: number;
}

let publicModelsFixture: PublicModelFixture[] = [];

/**
 * Stub `fetch` so the public `/v1/models` catalog returns the supplied models.
 *
 * `created` is intentionally omitted — the test sets fake system time to
 * 2024-01-15, while the fixture's `created` value is computed at module load
 * (real wall clock). Pushing the real value into the catalog would make every
 * model look "recent" relative to the fake clock and trip the premium-by-
 * recency guard. Defaulting `created` to 0 mirrors the pre-refactor behavior
 * where the SDK path hardcoded `created: 0` regardless of model age.
 */
function buildFetchMock(fetchMock: FetchMock, models: typeof trialChatModels): void {
  publicModelsFixture = models.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    type: 'language',
    pricing: { input: m.pricing.prompt, output: m.pricing.completion },
    context_window: m.context_length,
  }));
  fetchMock.mockImplementation(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: publicModelsFixture }),
    })
  );
}

// Trial chat specific models for testing
const trialChatModels = [
  {
    id: 'openai/gpt-4o-mini',
    name: 'Llama 3.1 70B',
    description: 'Basic model',
    context_length: 128_000,
    pricing: { prompt: '0.0000005', completion: '0.0000005' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60, // Old model
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'openai/gpt-5',
    name: 'GPT-4 Turbo',
    description: 'Premium model',
    context_length: 128_000,
    pricing: { prompt: '0.00001', completion: '0.00003' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000), // Recent model (premium)
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
];

interface ErrorBody {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

function createMockRedis(nextIncrValue = 1) {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    mget: vi.fn().mockResolvedValue([null, null]),
    incr: vi.fn().mockResolvedValue(nextIncrValue),
    expire: vi.fn().mockResolvedValue(true),
  };
}

/**
 * Stateful redis mock that tracks rate-limit get/set state across requests
 * (so the per-IP middleware can correctly count subsequent calls). It still
 * stubs `incr`/`expire`/`mget` to keep `consumeTrialMessage` happy with the
 * configured trial count.
 */
function createStatefulMockRedis(nextIncrValue = 1) {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve('OK');
    }),
    del: vi.fn().mockImplementation((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    mget: vi.fn().mockResolvedValue([null, null]),
    incr: vi.fn().mockResolvedValue(nextIncrValue),
    expire: vi.fn().mockResolvedValue(true),
  };
}

function createTestApp(
  options: {
    trialMessageCount?: number;
    redis?: ReturnType<typeof createMockRedis> | ReturnType<typeof createStatefulMockRedis>;
    aiClient?: ReturnType<typeof createMockAIClient>;
  } = {}
) {
  const app = new Hono<AppEnv>();

  // For the atomic consumeTrialMessage, the INCR return value represents the count
  // AFTER incrementing. So trialMessageCount=5 means 5 prior messages -> INCR returns 6 (over limit).
  // trialMessageCount=0 (default) means no prior messages -> INCR returns 1 (within limit).
  const nextIncrValue = (options.trialMessageCount ?? 0) + 1;
  const redis = options.redis ?? createMockRedis(nextIncrValue);

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'development',
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    } as AppEnv['Bindings'];
    c.set('user', null); // Trial user
    c.set('session', null);
    c.set('aiClient', options.aiClient ?? createMockAIClient());
    c.set('redis', redis as unknown as AppEnv['Variables']['redis']);
    c.set('db', {} as unknown as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', trialChatRoute);
  return app;
}

describe('trial chat routes', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    clearModelCache();
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

    // Default mock for fetchModels + fetchZdrModelIds
    buildFetchMock(fetchMock, trialChatModels);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    publicModelsFixture = [];
  });

  describe('POST /stream', () => {
    it('accepts trial requests without authentication', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    describe('Smart Model', () => {
      // Two cheap (non-premium) ZDR text models plus one expensive (premium)
      // one. Ids must be on the text ZDR allowlist or they're filtered out of
      // the eligible pool. The expensive model lifts the percentile threshold
      // so both cheap models stay non-premium and reach the trial eligible set,
      // giving the classifier a real choice to make.
      const smartModelClassifierCatalog = [
        {
          id: 'openai/gpt-4o-mini',
          name: 'GPT-4o mini',
          description: 'Cheap model A',
          context_length: 128_000,
          pricing: { prompt: '0.0000005', completion: '0.0000005' },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'openai/gpt-5-nano',
          name: 'GPT-5 nano',
          description: 'Cheap model B',
          context_length: 128_000,
          pricing: { prompt: '0.0000006', completion: '0.0000006' },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'openai/gpt-5',
          name: 'GPT-5',
          description: 'Premium model',
          context_length: 128_000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000),
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      it('resolves to the single eligible model and never forwards the virtual id', async () => {
        vi.useRealTimers();
        const aiClient = createMockAIClient();
        const app = createTestApp({ aiClient });

        const res = await app.request('/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trial-Token': 'test-trial-token',
            'X-Forwarded-For': '10.10.0.1',
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'smart-model',
          }),
        });

        expect(res.status).toBe(200);
        await res.text();

        const recordedModels = aiClient.getRequestHistory().map((r) => r.model);
        expect(recordedModels).not.toContain('smart-model');
        expect(recordedModels).toContain('openai/gpt-4o-mini');
      });

      it('routes through the classifier and infers with the resolved model', async () => {
        vi.useRealTimers();
        clearModelCache();
        buildFetchMock(fetchMock, smartModelClassifierCatalog);
        const aiClient = createMockAIClient({
          classifierResolution: 'openai/gpt-5-nano',
          classifierDelayMs: 0,
        });
        const app = createTestApp({ aiClient });

        const res = await app.request('/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trial-Token': 'test-trial-token',
            'X-Forwarded-For': '10.10.0.2',
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'smart-model',
          }),
        });

        expect(res.status).toBe(200);
        await res.text();

        const recordedModels = aiClient.getRequestHistory().map((r) => r.model);
        expect(recordedModels).not.toContain('smart-model');
        // Inference ran against the classifier's pick, not the virtual id.
        expect(recordedModels).toContain('openai/gpt-5-nano');
      });

      it('returns 402 when no eligible model fits the trial budget', async () => {
        vi.useRealTimers();
        clearModelCache();
        // ZDR text models priced far above the trial cap → all flagged premium /
        // over-budget → the trial eligible set is empty → resolution returns null.
        buildFetchMock(fetchMock, [
          {
            id: 'openai/gpt-5',
            name: 'GPT-5',
            description: 'Expensive',
            context_length: 128_000,
            pricing: { prompt: '0.1', completion: '0.1' },
            supported_parameters: ['temperature'],
            created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          },
          {
            id: 'openai/gpt-5.4',
            name: 'GPT-5.4',
            description: 'Expensive',
            context_length: 128_000,
            pricing: { prompt: '0.1', completion: '0.1' },
            supported_parameters: ['temperature'],
            created: Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60,
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
          },
        ]);
        const app = createTestApp();

        const res = await app.request('/stream', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trial-Token': 'test-trial-token',
            'X-Forwarded-For': '10.10.0.3',
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'smart-model',
          }),
        });

        expect(res.status).toBe(402);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('TRIAL_MESSAGE_TOO_EXPENSIVE');
      });
    });

    it('returns 400 when messages are missing', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
        },
        body: JSON.stringify({ model: 'openai/gpt-4o-mini' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when model is missing', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
        },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when last message is not from user', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
        },
        body: JSON.stringify({
          messages: [{ role: 'assistant', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('VALIDATION');
    });

    it('returns 403 when trying to use premium model', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-5', // Premium model
        }),
      });

      expect(res.status).toBe(403);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('PREMIUM_REQUIRES_ACCOUNT');
    });

    it('returns 403 with FEATURE_REQUIRES_AUTH when trial requests webSearchEnabled=true', async () => {
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
          webSearchEnabled: true,
        }),
      });

      expect(res.status).toBe(403);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('FEATURE_REQUIRES_AUTH');
    });

    it('still streams when webSearchEnabled is omitted or false on a trial request', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
          webSearchEnabled: false,
        }),
      });

      expect(res.status).toBe(200);
    });

    it('returns 429 when trial user has exceeded daily limit', async () => {
      const app = createTestApp({
        trialMessageCount: 5, // At limit (TRIAL_MESSAGE_LIMIT)
      });

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      expect(res.status).toBe(429);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('DAILY_LIMIT_EXCEEDED');
      expect(body.details?.['limit']).toBeDefined();
      expect(body.details?.['remaining']).toBe(0);
    });

    it('streams SSE response with token events', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: token');
      expect(text).toContain('event: done');
    });

    it('returns start event with message ID', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('"assistantMessageId"');
    });

    it('works without X-Trial-Token (uses IP only)', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      expect(res.status).toBe(200);
    });

    it('returns 400 when authenticated user tries to use trial endpoint', async () => {
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        // Simulate authenticated user with valid session
        c.set('user', {
          id: 'user-123',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', {
          sessionId: 'session-123',
          userId: 'user-123',
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        });
        c.set('aiClient', createMockAIClient());
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        c.set('db', {} as unknown as AppEnv['Variables']['db']);
        await next();
      });

      app.route('/', trialChatRoute);

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('AUTHENTICATED_ON_TRIAL');
    });

    it('returns 402 when message exceeds trial cost limit', async () => {
      const oneYearAgoSeconds = Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60;
      // Model must be cheap enough to pass trial affordability (non-premium),
      // but a very long message pushes total cost over $0.01 via storage cost alone.
      // 50K chars × $0.0000003/char storage = $0.015 > $0.01 trial budget.
      const budgetTestModels = [
        {
          id: 'budget-test/model',
          name: 'Budget Test Model',
          description: 'Model for budget testing',
          context_length: 128_000,
          pricing: { prompt: '0.0000001', completion: '0.0000001' }, // Very cheap — passes trial affordability
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds, // Old model (non-premium by recency)
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        // Add expensive models to push price percentile threshold above our test model
        {
          id: 'super-expensive/model-1',
          name: 'Super Expensive 1',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'super-expensive/model-2',
          name: 'Super Expensive 2',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'super-expensive/model-3',
          name: 'Super Expensive 3',
          description: 'Very expensive',
          context_length: 128_000,
          pricing: { prompt: '0.1', completion: '0.1' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      // Override default fetch mock
      buildFetchMock(fetchMock, budgetTestModels);

      const app = createTestApp();

      // Very long message that would exceed $0.01 limit
      const longMessage = 'x'.repeat(50_000);

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: longMessage }],
          model: 'budget-test/model',
        }),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('TRIAL_MESSAGE_TOO_EXPENSIVE');
    });

    it('allows messages within trial cost limit', async () => {
      vi.useRealTimers();
      const oneYearAgoSeconds = Math.floor(Date.now() / 1000) - 400 * 24 * 60 * 60;
      // Create models with cheap test model - need multiple so premium classification works
      const cheapTestModels = [
        {
          id: 'cheap/model',
          name: 'Cheap Model',
          description: 'Inexpensive model',
          context_length: 128_000,
          pricing: { prompt: '0.0000001', completion: '0.0000001' }, // Very cheap
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds, // Old model (non-premium by recency)
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        // Add expensive models to push threshold above our test model's price
        {
          id: 'expensive/model-1',
          name: 'Expensive 1',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'expensive/model-2',
          name: 'Expensive 2',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'expensive/model-3',
          name: 'Expensive 3',
          description: 'Expensive',
          context_length: 128_000,
          pricing: { prompt: '0.001', completion: '0.001' },
          supported_parameters: ['temperature'],
          created: oneYearAgoSeconds,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      // Override default fetch mock
      buildFetchMock(fetchMock, cheapTestModels);

      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'cheap/model',
        }),
      });

      expect(res.status).toBe(200);
    });

    it('does not persist messages to database', async () => {
      vi.useRealTimers();
      const app = createTestApp();

      const res = await app.request('/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Trial-Token': 'test-trial-token',
          'X-Forwarded-For': '192.168.1.1',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'openai/gpt-4o-mini',
        }),
      });

      await res.text(); // Consume response

      // Trial chat uses Redis for usage tracking, not the database
      // No database operations should occur for trial messages
      expect(res.status).toBe(200);
    });

    describe('per-IP rate limit (trialChatStreamIpRateLimit, 20/60s)', () => {
      // Stateful redis is reused across requests so the rate-limit window
      // accumulates correctly. Trial-quota incr is stubbed at 1 each call.
      function buildRequest(): RequestInit {
        return {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Trial-Token': 'rate-limit-token',
            'X-Forwarded-For': '203.0.113.1',
          },
          body: JSON.stringify({
            messages: [{ role: 'user', content: 'Hello' }],
            model: 'openai/gpt-4o-mini',
          }),
        };
      }

      it('returns 429 RATE_LIMITED on the 21st request from the same IP', async () => {
        const redis = createStatefulMockRedis(1);
        const app = createTestApp({ redis });

        for (let index = 0; index < 20; index++) {
          const res = await app.request('/stream', buildRequest());
          await res.text(); // drain SSE stream
          expect(res.status).toBe(200);
        }

        const blocked = await app.request('/stream', buildRequest());
        expect(blocked.status).toBe(429);
        const body: ErrorBody = await blocked.json();
        expect(body.code).toBe('RATE_LIMITED');
      });

      it('allows requests again after the 60s window expires', async () => {
        const redis = createStatefulMockRedis(1);
        const app = createTestApp({ redis });

        for (let index = 0; index < 20; index++) {
          const res = await app.request('/stream', buildRequest());
          await res.text();
        }
        const blocked = await app.request('/stream', buildRequest());
        expect(blocked.status).toBe(429);

        vi.advanceTimersByTime(61_000);

        const allowed = await app.request('/stream', buildRequest());
        await allowed.text();
        expect(allowed.status).toBe(200);
      });

      it('still applies the daily cap (DAILY_LIMIT_EXCEEDED) independently of the IP burst limit', async () => {
        // 6 = over the trial daily cap (TRIAL_MESSAGE_LIMIT=5). The per-IP
        // rate limit is well under its 20/60s threshold for a single request,
        // so the daily cap must still take effect.
        const redis = createStatefulMockRedis(6);
        const app = createTestApp({ redis });

        const res = await app.request('/stream', buildRequest());
        expect(res.status).toBe(429);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('DAILY_LIMIT_EXCEEDED');
      });
    });
  });
});
