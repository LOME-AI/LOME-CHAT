import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { sealData } from 'iron-session';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationForks,
  conversationMembers,
  conversations,
  createDb,
  epochs,
  messages,
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
import { hashCanonicalJson, hashIp } from './domain/index.js';
import type { RealtimeBroadcast } from '../conversations/index.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

/** The realtime port's start outcome, mirrored locally (not on the barrel surface). */
type RunStartOutcome =
  | { readonly started: true; readonly runId: string; readonly deadlineAt: number }
  | { readonly started: false; readonly code: 'CONCURRENT_RUN' | 'IDEMPOTENCY_BODY_MISMATCH' }
  | { readonly outcome: 'replay'; readonly response: unknown }
  | { readonly outcome: 'attach' };

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for chat route integration tests'
  );
}

const SECRET = 'secret-at-least-32-characters-long!!';
// The real SRH token is required: the trial route writes quota counters through
// `c.var.redis` (the paid route never touches Redis in these tests — the
// revocation check is deliberately unwired, so cookies pass without it).
const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const BYTES = new Uint8Array([3, 3, 3]);
const MODEL = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
const MODEL_B = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
const MODEL_C = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db
    .delete(modelCatalog)
    .where(
      inArray(modelCatalog.modelId, [
        MODEL,
        MODEL_B,
        MODEL_C,
        ...trialDecoyModelIds,
        ...trialGateModelIds,
      ])
    );
  // The header-less trial test increments the sentinel-IP counter; keep it from
  // accumulating across runs (it is the one trial IP key that is not unique).
  await redis.del(`trial:usage:ip:${await hashIp('0.0.0.0')}`);
  await db.$client.end();
});

async function seedModelId(modelId: string): Promise<void> {
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: {
        id: modelId,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: [],
        limits: { contextLength: 1000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        zdrReachable: true,
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
}

async function seedModel(): Promise<void> {
  await seedModelId(MODEL);
}

// A release timestamp (unix SECONDS) far outside the trial premium-recency
// window, so the seeded text models read as "old" and are eligible on that leg.
const OLD_RELEASE_SECONDS = 1_600_000_000;

// The trial premium gate ranks a model's combined price against the 75th
// percentile of the exposed text catalog. In an isolated run the only text
// models are the cheap fixtures, so without a pricier spread every model ties
// the threshold and reads as premium. These decoys give the catalog a spread so
// the cheap fixtures sit well below the quartile and stay trial-eligible.
const trialDecoyModelIds: string[] = [];

async function seedTrialDecoys(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    const modelId = `chat-route-decoy/${crypto.randomUUID().slice(0, 8)}`;
    trialDecoyModelIds.push(modelId);
    await db
      .insert(modelCatalog)
      .values({
        modelId,
        descriptor: {
          id: modelId,
          provider: 'p',
          version: '1',
          inputs: ['text'],
          outputs: ['text'],
          parameters: {},
          behaviors: [],
          limits: { contextLength: 1000 },
          pricing: { inputPerToken: '1000000000', outputPerToken: '1000000000' },
          zdrReachable: true,
          releasedAt: OLD_RELEASE_SECONDS,
          fetchedAt: 0,
        },
      })
      .onConflictDoNothing();
  }
}

// Trial-gate fixtures (image, premium-recent, over-priced) seeded per test.
const trialGateModelIds: string[] = [];

async function seedGateModel(
  modelId: string,
  descriptorOverrides: Record<string, unknown>
): Promise<void> {
  trialGateModelIds.push(modelId);
  await db
    .insert(modelCatalog)
    .values({
      modelId,
      descriptor: {
        id: modelId,
        provider: 'p',
        version: '1',
        inputs: ['text'],
        outputs: ['text'],
        parameters: {},
        behaviors: [],
        limits: { contextLength: 1000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        zdrReachable: true,
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: 0,
        ...descriptorOverrides,
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

async function seedFork(conversationId: string): Promise<string> {
  const rows = await db
    .insert(conversationForks)
    .values({ conversationId, name: 'Branch', tipMessageId: null })
    .returning({ id: conversationForks.id });
  const forkId = rows[0]?.id;
  if (forkId === undefined) throw new Error('fork seed failed');
  return forkId;
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
    trialRoomName: (sessionId) => `trial:${sessionId}`,
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

async function postTrial(
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return postPath('/chat/trial', realtime, headers, body);
}

async function getPath(
  path: string,
  realtime: RealtimeBroadcast,
  headers: Record<string, string>
): Promise<Response> {
  return createApp(realtime).request(path, { method: 'GET', headers }, testEnv);
}

/** The one upgrade the trial WS route makes; captured server-side to assert the target. */
interface UpgradeCall {
  readonly conversationId: string;
  readonly principalId: string;
  readonly isGuest: boolean;
}

/** A realtime double whose `upgrade` records its target so the route's server-derived room is checkable. */
function recordingUpgrade(): {
  readonly calls: UpgradeCall[];
  readonly realtime: RealtimeBroadcast;
} {
  const calls: UpgradeCall[] = [];
  const realtime = fakeRealtime(STARTED, {
    upgrade: (conversationId, principal) => {
      calls.push({
        conversationId,
        principalId: principal.principalId,
        isGuest: principal.isGuest,
      });
      return okAsync(new Response(null, { status: 200 }));
    },
  });
  return { calls, realtime };
}

/** Fresh anti-evasion identities per test so the SRH counters never collide. */
function trialHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Idempotency-Key': crypto.randomUUID(),
    'x-trial-token': crypto.randomUUID(),
    'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
    ...extra,
  };
}

const STARTED: RunStartOutcome = { started: true, runId: 'run-x', deadlineAt: 999 };

describe('chat route: POST /chat', () => {
  it('rejects an anonymous request', async () => {
    const res = await post(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': 'k1' },
      { conversationId: 'c', model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hi' } }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const userId = await seedUser();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId: '', model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hi' } }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('requires an Idempotency-Key', async () => {
    const userId = await seedUser();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId) },
      {
        conversationId: crypto.randomUUID(),
        model: MODEL,
        userMessage: { id: crypto.randomUUID(), content: 'hi' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, false);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': 'k2' },
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hi' } }
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
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: 'run-x', deadlineAt: 999 });
  });

  it('builds one sibling node per model when a multi-model list is sent', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    await seedModelId(MODEL_C);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        models: [MODEL, MODEL_B, MODEL_C],
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    // One optional skip-on-error sibling per selected model, in the sent order.
    expect(siblings.map((node) => node.model)).toEqual([MODEL, MODEL_B, MODEL_C]);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
    }
  });

  it('refuses a multi-model send when any listed model is unknown with 400', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        models: [MODEL, MODEL_B, `no/such-${crypto.randomUUID().slice(0, 8)}`],
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a send onto a missing fork with 404', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        forkId: crypto.randomUUID(),
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(404);
  });

  it('threads the forkId into the run for a member sending onto an existing fork', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const forkId = await seedFork(conversationId);
    const captured: { forkId: string | undefined }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ forkId: body.mode === 'paid' ? body.forkId : undefined });
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        forkId,
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([{ forkId }]);
  });

  it('maps a concurrent-run rejection to 409', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'CONCURRENT_RUN' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
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
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
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
      {
        conversationId,
        model: 'no/such-model',
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
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
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
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
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
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
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });
});

async function seedMessage(
  conversationId: string,
  options: {
    readonly senderType: 'user' | 'assistant';
    readonly senderId: string | null;
    readonly sequenceNumber: number;
    readonly parentMessageId: string | null;
  }
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: options.senderType,
      senderId: options.senderId,
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: options.sequenceNumber,
      parentMessageId: options.parentMessageId,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('message seed failed');
  return id;
}

async function postRegenerate(
  realtime: RealtimeBroadcast,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return postPath('/chat/regenerate', realtime, headers, body);
}

describe('chat route: POST /chat/regenerate', () => {
  it('refuses a regenerate whose target is not in the conversation with 404', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: crypto.randomUUID(),
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(404);
  });

  it('refuses a regenerate from a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, false);
    await seedPurchasedWallet(userId);
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: crypto.randomUUID(),
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(403);
  });

  it('rejects a regenerate naming an unknown model with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: `unknown/${crypto.randomUUID().slice(0, 8)}`,
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('threads a regenerate onto an existing fork (201)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const forkId = await seedFork(conversationId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    // Point the fork tip at the anchor so the guard's observed tip is a real id;
    // the route must carry exactly it into the run body (the settlement fence).
    await db
      .update(conversationForks)
      .set({ tipMessageId: anchor })
      .where(eq(conversationForks.id, forkId));

    const captured: { forkId: unknown; regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({
          forkId: body.mode === 'paid' ? body.forkId : undefined,
          regenerate: body.mode === 'paid' ? body.regenerate : undefined,
        });
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: anchor,
        action: 'retry',
        forkId,
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([
      {
        forkId,
        regenerate: { action: 'retry', targetMessageId: anchor, observedForkTipId: anchor },
      },
    ]);
  });

  it('keeps the bodyHash identical when only the observed fork tip moved between same-key retries', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const forkId = await seedFork(conversationId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: anchor })
      .where(eq(conversationForks.id, forkId));

    const captured: { bodyHash: string; regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        if (body.mode === 'paid') {
          captured.push({ bodyHash: body.bodyHash, regenerate: body.regenerate });
        }
        return okAsync(STARTED);
      },
    });
    // One client intent, retried under one Idempotency-Key. Between the two
    // sends the fork tip legitimately advances (an assistant reply landed), so
    // the server-derived observedForkTipId differs — the hash the DO compares
    // for same-key dedup must not, or a benign retry would 409 body-mismatch.
    const idempotencyKey = crypto.randomUUID();
    const clientBody = {
      conversationId,
      model: MODEL,
      targetMessageId: anchor,
      action: 'retry',
      forkId,
      userMessage: { id: crypto.randomUUID(), content: 'again' },
    };
    const headers = { cookie: await cookie(userId), 'Idempotency-Key': idempotencyKey };

    const first = await postRegenerate(realtime, headers, clientBody);
    expect(first.status).toBe(201);

    const reply = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: anchor,
    });
    await db
      .update(conversationForks)
      .set({ tipMessageId: reply })
      .where(eq(conversationForks.id, forkId));

    const second = await postRegenerate(realtime, headers, clientBody);
    expect(second.status).toBe(201);

    expect(captured).toHaveLength(2);
    // The tip really moved between the two run bodies …
    expect(captured[0]?.regenerate).toEqual({
      action: 'retry',
      targetMessageId: anchor,
      observedForkTipId: anchor,
    });
    expect(captured[1]?.regenerate).toEqual({
      action: 'retry',
      targetMessageId: anchor,
      observedForkTipId: reply,
    });
    // … yet the dedup hash is unchanged: the tip is excluded from client intent.
    expect(captured[1]?.bodyHash).toBe(captured[0]?.bodyHash);
    // Non-vacuity: folding the moved tip into the same hash input would have
    // produced a different digest, so the equality above is a real exclusion.
    const hashWithTip = await hashCanonicalJson({
      conversationId,
      model: MODEL,
      forkId,
      userMessage: clientBody.userMessage,
      regenerate: {
        action: 'retry',
        targetMessageId: anchor,
        observedForkTipId: reply,
      },
    });
    expect(hashWithTip).not.toBe(captured[0]?.bodyHash);
  });

  it("blocks a regenerate across another member's message with 403", async () => {
    const owner = await seedUser();
    const other = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: other, visibleFromEpoch: 1 });
    // owner → a1 → other → a2(tip). Regenerating from the owner's message would
    // delete the other member's intervening message.
    const u1 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const a1 = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: u1,
    });
    const u2 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: other,
      sequenceNumber: 3,
      parentMessageId: a1,
    });
    await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 4,
      parentMessageId: u2,
    });

    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: u1,
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
  });

  it('threads the regenerate action into the run for a solo retry (201)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const replaceAssistantId = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: anchor,
    });

    const captured: { regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ regenerate: body.mode === 'paid' ? body.regenerate : undefined });
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: anchor,
        action: 'retry',
        replaceAssistantId,
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([
      { regenerate: { action: 'retry', targetMessageId: anchor, replaceAssistantId } },
    ]);
  });

  it("refuses a retry-one whose replaceAssistantId is a co-member's message (arbitrary delete) with 404", async () => {
    await seedModel();
    const owner = await seedUser();
    const other = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: other, visibleFromEpoch: 1 });
    // The victim is the co-member's message; the owner's own message is the tip,
    // so the tip→target walk is empty (no cross-member 403), which is exactly
    // where the unguarded replaceAssistantId delete slipped through.
    const victim = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: other,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 2,
      parentMessageId: null,
    });

    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: anchor,
        action: 'retry',
        replaceAssistantId: victim,
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'NOT_FOUND' });
    // The paid run never started, so the settlement's unscoped delete never runs.
    expect(captured).toEqual([]);
  });

  it('refuses a no-forkId regenerate once the conversation has a fork with 409', async () => {
    await seedModel();
    const owner = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await seedFork(conversationId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 1,
      parentMessageId: null,
    });

    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'FORK_ID_REQUIRED' });
    // The unsafe linear sequence-delete never started.
    expect(captured).toEqual([]);
  });

  it('threads an edit action into the run for a solo edit (201)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });

    const captured: { regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ regenerate: body.mode === 'paid' ? body.regenerate : undefined });
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: anchor,
        action: 'edit',
        userMessage: { id: crypto.randomUUID(), content: 'edited' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([{ regenerate: { action: 'edit', targetMessageId: anchor } }]);
  });

  // A member must not regenerate/edit ANOTHER member's turn: the anchor must be
  // the caller's own user message. attacker(m1) → assistant(m2) → victim(m3) →
  // assistant(m4, tip); anchoring on m3 with the tip m4 above it makes the
  // tip→target walk empty, so only the ownership gate stops the settlement's
  // sequence-scoped delete from destroying the victim's m3 + m4.
  async function seedCrossMemberTurn(): Promise<{
    readonly attacker: string;
    readonly conversationId: string;
    readonly m3: string;
    readonly m4: string;
  }> {
    await seedModel();
    const attacker = await seedUser();
    const victim = await seedUser();
    const conversationId = await seedConversation(attacker, true);
    await seedPurchasedWallet(attacker);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: victim, visibleFromEpoch: 1 });
    const m1 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: attacker,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const m2 = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: m1,
    });
    const m3 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: victim,
      sequenceNumber: 3,
      parentMessageId: m2,
    });
    const m4 = await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 4,
      parentMessageId: m3,
    });
    return { attacker, conversationId, m3, m4 };
  }

  async function expectVictimSurvives(m3: string, m4: string): Promise<void> {
    const survivors = await db
      .select({ id: messages.id })
      .from(messages)
      .where(inArray(messages.id, [m3, m4]));
    expect(new Set(survivors.map((row) => row.id))).toEqual(new Set([m3, m4]));
  }

  it("refuses editing another member's message (foreign anchor) — 403, no run, victim survives", async () => {
    const { attacker, conversationId, m3, m4 } = await seedCrossMemberTurn();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: m3,
        action: 'edit',
        userMessage: { id: crypto.randomUUID(), content: 'hijacked' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(m3, m4);
  });

  it("refuses retry-all on another member's message (foreign anchor) — 403, no run, victim survives", async () => {
    const { attacker, conversationId, m3, m4 } = await seedCrossMemberTurn();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: m3,
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(m3, m4);
  });

  it("refuses retry-one on another member's turn even with the anchor's own assistant reply — 403, no run, victim survives", async () => {
    const { attacker, conversationId, m3, m4 } = await seedCrossMemberTurn();
    const captured: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(attacker), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: m3,
        action: 'retry',
        replaceAssistantId: m4,
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'REGENERATION_BLOCKED_BY_OTHER_USER' });
    expect(captured).toEqual([]);
    await expectVictimSurvives(m3, m4);
  });

  it("allows editing the caller's OWN message in a group turn they own (201)", async () => {
    await seedModel();
    const owner = await seedUser();
    const other = await seedUser();
    const conversationId = await seedConversation(owner, true);
    await seedPurchasedWallet(owner);
    await db
      .insert(conversationMembers)
      .values({ conversationId, userId: other, visibleFromEpoch: 1 });
    // owner(m1) → assistant(m2, tip); no co-member message after the anchor.
    const m1 = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: owner,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    await seedMessage(conversationId, {
      senderType: 'assistant',
      senderId: null,
      sequenceNumber: 2,
      parentMessageId: m1,
    });

    const captured: { regenerate: unknown }[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push({ regenerate: body.mode === 'paid' ? body.regenerate : undefined });
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(owner), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: m1,
        action: 'edit',
        userMessage: { id: crypto.randomUUID(), content: 'edited' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured).toEqual([{ regenerate: { action: 'edit', targetMessageId: m1 } }]);
  });
});

describe('chat route: POST /chat/trial', () => {
  beforeAll(seedTrialDecoys);

  it('refuses an authenticated caller (belongs on the main chat)', async () => {
    const userId = await seedUser();
    const res = await postTrial(
      fakeRealtime(STARTED),
      trialHeaders({ cookie: await cookie(userId) }),
      {
        model: MODEL,
        prompt: 'hi',
      }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'AUTHENTICATED_ON_TRIAL' });
  });

  it('refuses a web-search request (an account feature)', async () => {
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: MODEL,
      prompt: 'hi',
      webSearchEnabled: true,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FEATURE_REQUIRES_AUTH' });
  });

  it('requires an Idempotency-Key', async () => {
    const res = await postTrial(
      fakeRealtime(STARTED),
      { 'x-trial-token': crypto.randomUUID() },
      { model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(400);
  });

  it('starts a trial run (201) for an anonymous caller within quota', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: MODEL,
      prompt: 'hi',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: 'run-x', deadlineAt: 999 });
  });

  it('refuses an unknown model with 400', async () => {
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: 'no/such-model',
      prompt: 'hi',
    });
    expect(res.status).toBe(400);
  });

  it('does not consume a quota slot for a refused unknown-model request', async () => {
    await seedModel();
    // One fixed identity so both quota counters would accumulate if the refused
    // requests consumed slots. The daily limit is 5; five refusals followed by a
    // valid send proves the refusals burned nothing (validation precedes the INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: 'no/such-model', prompt: 'hi' }
      );
      expect(refused.status).toBe(400);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { model: MODEL, prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });

  it('blocks a non-text (image) model with 403 MEDIA_TRIAL_BLOCKED', async () => {
    const imageId = `chat-route-image/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(imageId, { outputs: ['image'], pricing: { perImage: '40000000' } });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: imageId,
      prompt: 'hi',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'MEDIA_TRIAL_BLOCKED' });
  });

  it('blocks a premium (recently released) model with 403 PREMIUM_REQUIRES_ACCOUNT', async () => {
    const premiumId = `chat-route-premium/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(premiumId, { releasedAt: Math.floor(Date.now() / 1000) });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: premiumId,
      prompt: 'hi',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'PREMIUM_REQUIRES_ACCOUNT' });
  });

  it('blocks an over-1¢ message with 402 TRIAL_MESSAGE_TOO_EXPENSIVE', async () => {
    const dearId = `chat-route-dear/${crypto.randomUUID().slice(0, 8)}`;
    // Eligible on the model legs (old, below-quartile), yet a long prompt pushes
    // the actual message past 1¢ on the minimum basis.
    await seedGateModel(dearId, { pricing: { inputPerToken: '1000', outputPerToken: '0' } });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: dearId,
      prompt: 'x'.repeat(25_000),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  it('refuses a model with incomplete token pricing with a 400', async () => {
    const partialId = `chat-route-partial/${crypto.randomUUID().slice(0, 8)}`;
    // Only inputPerToken is priced: eligible on the model legs, but the actual
    // per-message cost cannot be computed, so the send is refused as invalid.
    await seedGateModel(partialId, { pricing: { inputPerToken: '2' } });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: partialId,
      prompt: 'hi',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('lets an eligible cheap text model through, consuming a quota slot', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: MODEL,
      prompt: 'hi',
    });
    expect(res.status).toBe(201);
  });

  it('burns no quota slot for a gate refusal', async () => {
    const imageId = `chat-route-image/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(imageId, { outputs: ['image'], pricing: { perImage: '40000000' } });
    await seedModel();
    // One fixed identity: five refusals then a valid send prove the refusals
    // burned no slot (the gate precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.9-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: imageId, prompt: 'hi' }
      );
      expect(refused.status).toBe(403);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { model: MODEL, prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });

  it('burns no quota slot for a premium-model refusal', async () => {
    const premiumId = `chat-route-premium/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(premiumId, { releasedAt: Math.floor(Date.now() / 1000) });
    await seedModel();
    // One fixed identity: five 403 PREMIUM refusals then a valid send prove the
    // refusals burned no slot (the gate precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.11-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: premiumId, prompt: 'hi' }
      );
      expect(refused.status).toBe(403);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { model: MODEL, prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });

  it('burns no quota slot for an over-1¢ message refusal', async () => {
    const dearId = `chat-route-dear/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(dearId, { pricing: { inputPerToken: '1000', outputPerToken: '0' } });
    await seedModel();
    // One fixed identity: five 402 TOO_EXPENSIVE refusals then a valid send prove
    // the refusals burned no slot (the affordability check precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.12-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: dearId, prompt: 'x'.repeat(25_000) }
      );
      expect(refused.status).toBe(402);
    }
    const ok = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { model: MODEL, prompt: 'hi' }
    );
    expect(ok.status).toBe(201);
  });

  it('mints a session and defaults the IP when the token and IP headers are absent', async () => {
    await seedModel();
    // No x-trial-token (a session id is minted) and no cf-connecting-ip (the
    // sentinel IP is used) — the session counter is fresh, so the run starts.
    const res = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID() },
      { model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(201);
  });

  it('maps a realtime transport failure to 503', async () => {
    await seedModel();
    const errorRealtime: RealtimeBroadcast = {
      ...fakeRealtime(STARTED),
      startRun: () => errAsync(unavailableError('conversation room unreachable')),
    };
    const res = await postTrial(errorRealtime, trialHeaders(), { model: MODEL, prompt: 'hi' });
    expect(res.status).toBe(503);
  });

  it('depletes the 5/day quota and refuses the sixth send (429)', async () => {
    await seedModel();
    // One fixed identity across the burst so both counters accumulate.
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
    };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const ok = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: MODEL, prompt: 'hi' }
      );
      expect(ok.status).toBe(201);
    }
    const sixth = await postTrial(
      fakeRealtime(STARTED),
      { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
      { model: MODEL, prompt: 'hi' }
    );
    expect(sixth.status).toBe(429);
    expect(await sixth.json()).toEqual({ code: 'TRIAL_LIMIT_REACHED' });
  });

  // The per-IP burst throttle: 20 sends / 60s, distinct from the 5/day quota.
  const BURST_CAP = 20;

  /** A fresh header set that pins the caller IP (the burst identity) across a run. */
  function burstHeaders(ip: string): Record<string, string> {
    return {
      'Idempotency-Key': crypto.randomUUID(),
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': ip,
    };
  }

  it('throttles the send past the per-IP burst cap with 429 RATE_LIMITED', async () => {
    await seedModel();
    // Unknown-model sends pass the burst gate but fail the later build (400),
    // so the burst counter climbs to the cap without any daily-quota accounting.
    const ip = `203.0.113.30-${crypto.randomUUID()}`;
    for (let attempt = 1; attempt <= BURST_CAP; attempt += 1) {
      const admitted = await postTrial(fakeRealtime(STARTED), burstHeaders(ip), {
        model: 'no/such-model',
        prompt: 'hi',
      });
      expect(admitted.status).toBe(400);
    }
    const throttled = await postTrial(fakeRealtime(STARTED), burstHeaders(ip), {
      model: 'no/such-model',
      prompt: 'hi',
    });
    expect(throttled.status).toBe(429);
    // The refusal carries the machine code and a numeric retry hint.
    expect(await throttled.json()).toEqual({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    await redis.del(`trial:burst:ip:ratelimit:${await hashIp(ip)}`);
  });

  it('refuses the over-cap send before the catalog read, so it burns no daily quota slot', async () => {
    await seedModel();
    const ip = `203.0.113.31-${crypto.randomUUID()}`;
    const dailyIpKey = `trial:usage:ip:${await hashIp(ip)}`;
    // Valid-model sends reach the daily quota (per-IP cap 5), so 1..5 succeed and
    // 6..20 are refused as TRIAL_LIMIT_REACHED; all 20 pass the burst gate and
    // each reaches — and increments — the daily counter.
    for (let attempt = 1; attempt <= BURST_CAP; attempt += 1) {
      const res = await postTrial(fakeRealtime(STARTED), burstHeaders(ip), {
        model: MODEL,
        prompt: 'hi',
      });
      expect([201, 429]).toContain(res.status);
      if (res.status === 429) expect(await res.json()).toEqual({ code: 'TRIAL_LIMIT_REACHED' });
    }
    const dailyBefore = await redis.get(dailyIpKey);

    const throttled = await postTrial(fakeRealtime(STARTED), burstHeaders(ip), {
      model: MODEL,
      prompt: 'hi',
    });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: 'RATE_LIMITED' });
    // The burst refusal short-circuits before the quota INCR: the daily counter
    // is unchanged, proving the throttled send consumed no quota slot.
    expect(await redis.get(dailyIpKey)).toBe(dailyBefore);
    await redis.del(`trial:burst:ip:ratelimit:${await hashIp(ip)}`);
    await redis.del(dailyIpKey);
  });

  it('counts the burst per IP, so a fresh IP is unaffected', async () => {
    const limited = `203.0.113.32-${crypto.randomUUID()}`;
    const fresh = `203.0.113.33-${crypto.randomUUID()}`;
    for (let attempt = 1; attempt <= BURST_CAP; attempt += 1) {
      await postTrial(fakeRealtime(STARTED), burstHeaders(limited), {
        model: 'no/such-model',
        prompt: 'hi',
      });
    }
    const throttled = await postTrial(fakeRealtime(STARTED), burstHeaders(limited), {
      model: 'no/such-model',
      prompt: 'hi',
    });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: 'RATE_LIMITED' });

    // A different IP's first send is not throttled (it reaches the build → 400).
    const other = await postTrial(fakeRealtime(STARTED), burstHeaders(fresh), {
      model: 'no/such-model',
      prompt: 'hi',
    });
    expect(other.status).toBe(400);
    await redis.del(`trial:burst:ip:ratelimit:${await hashIp(limited)}`);
    await redis.del(`trial:burst:ip:ratelimit:${await hashIp(fresh)}`);
  });

  it('does not burst-limit the trial WebSocket route', async () => {
    // Drive one IP to its POST burst cap, then upgrade the WS from that same IP:
    // the WS route shares no per-IP burst counter, so it still upgrades (200).
    const ip = `203.0.113.34-${crypto.randomUUID()}`;
    for (let attempt = 1; attempt <= BURST_CAP + 1; attempt += 1) {
      await postTrial(fakeRealtime(STARTED), burstHeaders(ip), {
        model: 'no/such-model',
        prompt: 'hi',
      });
    }
    const { calls, realtime } = recordingUpgrade();
    const res = await createApp(realtime).request(
      '/chat/trial/websocket',
      { method: 'GET', headers: { 'x-trial-token': crypto.randomUUID(), 'cf-connecting-ip': ip } },
      testEnv
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    await redis.del(`trial:burst:ip:ratelimit:${await hashIp(ip)}`);
  });

  it('fails closed (503) when Redis is unavailable for the burst check', async () => {
    // A wrong SRH token makes every Redis call 401 (fast, no network retries):
    // the burst INCR errors and the send is refused, never admitted unbounded.
    const badRedisEnv = { ...testEnv, UPSTASH_REDIS_REST_TOKEN: 'wrong-srh-token' };
    const res = await createApp(fakeRealtime(STARTED)).request(
      '/chat/trial',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...burstHeaders('203.0.113.35') },
        body: JSON.stringify({ model: MODEL, prompt: 'hi' }),
      },
      badRedisEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});

describe('chat route: GET /chat/trial/websocket', () => {
  it('upgrades a trial session to its own server-derived trial room', async () => {
    const token = crypto.randomUUID();
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath('/chat/trial/websocket', realtime, { 'x-trial-token': token });
    // The port double answers a 200 stand-in for the DO's real 101 (undici
    // cannot construct a sub-200 Response); the route forwards it untouched.
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { conversationId: `trial:${token}`, principalId: `trial:${token}`, isGuest: false },
    ]);
  });

  it('mints a fresh trial room when no token is supplied', async () => {
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath('/chat/trial/websocket', realtime, {});
    expect(res.status).toBe(200);
    // A minted session still targets a prefix-scoped self-room: id equals principal.
    expect(calls[0]?.conversationId).toMatch(/^trial:/);
    expect(calls[0]?.principalId).toBe(calls[0]?.conversationId);
  });

  it('derives the room server-side, ignoring client-injected room and principal params', async () => {
    const token = crypto.randomUUID();
    const foreignConversation = crypto.randomUUID();
    const foreignPrincipal = `trial:${crypto.randomUUID()}`;
    const { calls, realtime } = recordingUpgrade();
    // A crafted request injecting conversationId / principalId query params must
    // not retarget the upgrade — only the x-trial-token is honored, and the room
    // is trialRoomName(sessionId), so no trial credential can reach a foreign
    // trial room or any conversation DO.
    const res = await getPath(
      `/chat/trial/websocket?conversationId=${foreignConversation}&principalId=${foreignPrincipal}`,
      realtime,
      { 'x-trial-token': token }
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.conversationId).toBe(`trial:${token}`);
    expect(calls[0]?.principalId).toBe(`trial:${token}`);
    expect(calls[0]?.conversationId).not.toBe(foreignConversation);
    expect(calls[0]?.principalId).not.toBe(foreignPrincipal);
  });

  it('refuses an authenticated caller (belongs on the conversation socket)', async () => {
    const userId = await seedUser();
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath('/chat/trial/websocket', realtime, {
      'x-trial-token': crypto.randomUUID(),
      cookie: await cookie(userId),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'AUTHENTICATED_ON_TRIAL' });
    expect(calls).toEqual([]);
  });

  it('maps a realtime transport failure to 503', async () => {
    const errorRealtime: RealtimeBroadcast = {
      ...fakeRealtime(STARTED),
      upgrade: () => errAsync(unavailableError('conversation room unreachable')),
    };
    const res = await getPath('/chat/trial/websocket', errorRealtime, {
      'x-trial-token': crypto.randomUUID(),
    });
    expect(res.status).toBe(503);
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
      trialRoomName: (sessionId) => `trial:${sessionId}`,
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
