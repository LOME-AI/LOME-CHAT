import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  modelCatalog,
  users,
  wallets,
} from '@hushbox/db';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { createBillingStores } from '../billing/index.js';
import { createConversationsStores } from '../conversations/index.js';
import { createChatManifest } from './index.js';
import type { RealtimeBroadcast } from '../conversations/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

/** The realtime port's start outcome, mirrored locally (not on the barrel surface). */
type RunStartOutcome =
  | { readonly started: true; readonly runId: string; readonly deadlineAt: number }
  | { readonly started: false; readonly code: 'CONCURRENT_RUN' | 'IDEMPOTENCY_BODY_MISMATCH' }
  | { readonly outcome: 'replay'; readonly response: unknown }
  | { readonly outcome: 'attach' };

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for chat route integration tests');

const SECRET = 'secret-at-least-32-characters-long!!';
const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL: 'http://localhost:8079',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([3, 3, 3]);
const MODEL = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, [MODEL]));
  await db.$client.end();
});

async function seedModel(): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId: MODEL,
      descriptor: {
        id: MODEL,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: [],
        limits: { contextLength: 1000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        zdrReachable: true,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

async function seedUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@chat-route.test`,
      username: `cr${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedConversation(userId: string, withMember: boolean): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = rows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  if (withMember) {
    await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });
  }
  return conversationId;
}

async function seedPurchasedWallet(userId: string): Promise<void> {
  await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000n });
}

async function cookie(userId: string): Promise<string> {
  const sealed = await sealData(
    {
      userId,
      sessionId: 's1',
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return `${SESSION_COOKIE_NAME}=${sealed}`;
}

function fakeRealtime(
  outcome: RunStartOutcome,
  overrides: Partial<RealtimeBroadcast> = {}
): RealtimeBroadcast {
  return {
    broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
    evict: () => okAsync(0),
    presence: () => okAsync([]),
    startRun: () => okAsync(outcome),
    stopRun: () => okAsync(false),
    upgrade: () => okAsync(new Response(null, { status: 200 })),
    ...overrides,
  };
}

function createApp(realtime: RealtimeBroadcast): Hono<AppEnv> {
  const manifest = createChatManifest({
    conversations: createConversationsStores,
    billing: createBillingStores(),
    realtime: () => realtime,
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

async function postPath(
  path: string,
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return createApp(realtime).request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

async function post(
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return postPath('/chat', realtime, headers, body);
}

const STARTED: RunStartOutcome = { started: true, runId: 'run-x', deadlineAt: 999 };

describe('chat route: POST /chat', () => {
  it('rejects an anonymous request', async () => {
    const res = await post(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': 'k1' },
      { conversationId: 'c', model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const userId = await seedUser();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId: '', model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('requires an Idempotency-Key', async () => {
    const userId = await seedUser();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId) },
      { conversationId: crypto.randomUUID(), model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, false);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': 'k2' },
      { conversationId, model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(403);
  });

  it('returns a run handle (201) for a member with a purchased wallet', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, prompt: 'hello' }
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: 'run-x', deadlineAt: 999 });
  });

  it('maps a concurrent-run rejection to 409', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'CONCURRENT_RUN' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, prompt: 'hello' }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'CONCURRENT_RUN' });
  });

  it('maps a realtime transport failure to 503', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const errorRealtime: RealtimeBroadcast = {
      ...fakeRealtime(STARTED),
      startRun: () => errAsync(unavailableError('conversation room unreachable')),
    };
    const res = await post(
      errorRealtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, prompt: 'hello' }
    );
    expect(res.status).toBe(503);
  });

  it('refuses an unknown model with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: 'no/such-model', prompt: 'hello' }
    );
    expect(res.status).toBe(400);
  });

  it('replays the settled turn response (200) instead of a transport error', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ outcome: 'replay', response: { runId: 'settled-run' } }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, prompt: 'hello' }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'settled-run' });
  });

  it('attaches a duplicate while a run is still live (200)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ outcome: 'attach' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, prompt: 'hello' }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'attach' });
  });

  it('maps a reused key with a different body to 409', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'IDEMPOTENCY_BODY_MISMATCH' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, prompt: 'hello' }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });
});

describe('chat route: POST /chat/stop', () => {
  it('rejects an anonymous request', async () => {
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED),
      { 'Idempotency-Key': 'k1' },
      {
        conversationId: crypto.randomUUID(),
      }
    );
    expect(res.status).toBe(401);
  });

  it('requires an Idempotency-Key', async () => {
    const userId = await seedUser();
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED),
      { cookie: await cookie(userId) },
      { conversationId: crypto.randomUUID() }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, false);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(403);
  });

  it('settles the run for a member and reports the stop result', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(true) }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true });
  });

  it('reports no active run for a member when nothing was running', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, { stopRun: () => okAsync(false) }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: false });
  });

  it('maps a realtime transport failure to 503', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await postPath(
      '/chat/stop',
      fakeRealtime(STARTED, {
        stopRun: () => errAsync(unavailableError('conversation room unreachable')),
      }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId }
    );
    expect(res.status).toBe(503);
  });

  it('maps a membership store failure to 503', async () => {
    const userId = await seedUser();
    const failingConversations = (() => ({
      members: new Proxy(
        {},
        { get: () => () => errAsync(unavailableError('membership store down')) }
      ),
    })) as unknown as typeof createConversationsStores;
    const manifest = createChatManifest({
      conversations: failingConversations,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat/stop',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ conversationId: crypto.randomUUID() }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
  });
});
