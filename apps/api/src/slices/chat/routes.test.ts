import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createChatManifest } from './routes.js';
import { regenerateTurnBodySchema, startTurnBodySchema, trialTurnBodySchema } from './routes.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { ChatRouteDeps } from './domain/index.js';

/**
 * The chat turn body schemas gate `customInstructions` at the boundary: it is
 * optional, typed as a string, and length-bounded (5000, matching the
 * InferenceRequest cap). These are pure Zod checks — no route, DO, or stack.
 */

const UUID_A = '00000000-0000-4000-8000-000000000001';
const UUID_B = '00000000-0000-4000-8000-000000000002';

const startBase = {
  conversationId: UUID_A,
  model: 'answer-model',
  userMessage: { id: UUID_B, content: 'hello' },
};

const regenerateBase = {
  conversationId: UUID_A,
  model: 'answer-model',
  targetMessageId: UUID_A,
  action: 'retry' as const,
  userMessage: { id: UUID_B, content: 'hello' },
};

const trialBase = { model: 'answer-model', prompt: 'hello' };

describe('startTurnBodySchema customInstructions', () => {
  it('accepts an omitted custom-instructions field', () => {
    expect(startTurnBodySchema.safeParse(startBase).success).toBe(true);
  });

  it('accepts a custom-instructions string up to the 5000-char bound', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      customInstructions: 'x'.repeat(5000),
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = startTurnBodySchema.safeParse({
      ...startBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-string custom-instructions value', () => {
    const parsed = startTurnBodySchema.safeParse({ ...startBase, customInstructions: 42 });
    expect(parsed.success).toBe(false);
  });
});

describe('regenerateTurnBodySchema customInstructions', () => {
  it('accepts a bounded custom-instructions string', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      customInstructions: 'be terse',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = regenerateTurnBodySchema.safeParse({
      ...regenerateBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });
});

describe('GET /chat/mock/release-stream (dev-only held-stream release)', () => {
  const SECRET = 'secret-at-least-32-characters-long!!';
  const devEnvBase = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/hushbox',
    UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
    UPSTASH_REDIS_REST_TOKEN: 'token',
    IRON_SESSION_SECRET: SECRET,
    TELEMETRY_SINKS: 'console',
  };

  /** A fake ConversationRoom namespace recording the forwarded release fetch. */
  function fakeNamespace(response: Response): {
    readonly namespace: unknown;
    readonly calls: { name: string; path: string; method: string }[];
  } {
    const calls: { name: string; path: string; method: string }[] = [];
    const namespace = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({
        fetch: (input: string, init?: RequestInit) => {
          calls.push({
            name: id.toString(),
            path: new URL(input).pathname,
            method: init?.method ?? 'GET',
          });
          return Promise.resolve(response);
        },
      }),
    };
    return { namespace, calls };
  }

  function mountedApp(): Hono<AppEnv> {
    // The manifest closures capture deps but this route touches only `c.env`,
    // so an empty deps stub is never dereferenced.
    const manifest = createChatManifest({} as unknown as ChatRouteDeps);
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  it('forwards to the conversation room DO release route in dev/E2E', async () => {
    const { namespace, calls } = fakeNamespace(Response.json({ released: true }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ released: true });
    expect(calls).toEqual([{ name: 'conv-42', path: '/mock/release-stream', method: 'POST' }]);
  });

  it('fails closed with 404 in production (dev-only route class)', async () => {
    const { namespace, calls } = fakeNamespace(Response.json({ released: true }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, NODE_ENV: 'production', CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(404);
    // The handler never ran — no DO fetch was forwarded.
    expect(calls).toEqual([]);
  });

  it('answers 503 when the conversation room binding is absent', async () => {
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase }
    );
    expect(res.status).toBe(503);
  });

  it('answers 503 when the conversation room DO fetch is not ok', async () => {
    const { namespace } = fakeNamespace(new Response(null, { status: 500 }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(503);
  });

  it('answers 503 when the conversation room DO returns a malformed body', async () => {
    const { namespace } = fakeNamespace(Response.json({ unexpected: 'shape' }));
    const res = await mountedApp().request(
      '/chat/mock/release-stream?conversationId=conv-42',
      {},
      { ...devEnvBase, CONVERSATION_ROOM: namespace }
    );
    expect(res.status).toBe(503);
  });
});

describe('trialTurnBodySchema customInstructions', () => {
  it('accepts a bounded custom-instructions string', () => {
    const parsed = trialTurnBodySchema.safeParse({
      ...trialBase,
      customInstructions: 'answer in French',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a custom-instructions string over the 5000-char bound', () => {
    const parsed = trialTurnBodySchema.safeParse({
      ...trialBase,
      customInstructions: 'x'.repeat(5001),
    });
    expect(parsed.success).toBe(false);
  });
});
