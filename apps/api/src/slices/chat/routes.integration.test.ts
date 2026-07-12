import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { Redis } from '@upstash/redis';
import { sealData } from 'iron-session';
import { eq, inArray, like, notLike } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationForks,
  conversationMembers,
  conversations,
  createDb,
  deviceTokens,
  epochs,
  memberBudgets,
  messages,
  modelCatalog,
  sharedLinks,
  users,
  wallets,
} from '@hushbox/db';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { createBillingStores } from '../billing/index.js';
import { createConversationsStores } from '../conversations/index.js';
import { createLinkResolutionAdapter } from '../../adapters/link-resolution.js';
import {
  createDeviceTokenStore,
  createMockPushSender,
  sendPushForNewMessage,
} from '../notifications/index.js';
import { createChatManifest } from './index.js';
import { createChatStores } from './adapters/stores.js';
import { withModelCatalogLock } from '../models/__tests__/model-catalog-lock.js';
import { LINK_CREDENTIAL_HEADER, hashCanonicalJson, hashIp } from './domain/index.js';
import { MAX_SELECTED_MODELS, SMART_MODEL_ID, toBase64 } from '@hushbox/shared';
import type { MembershipReader } from '../notifications/index.js';
import type { NotifyNewMessage } from './index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from '../conversations/index.js';
import type { WorkflowDefinition } from '@hushbox/shared';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';

/** The realtime port's start outcome, mirrored locally (not on the barrel surface). */
type RunStartOutcome =
  | { readonly started: true; readonly runId: string; readonly deadlineAt: number }
  | {
      readonly started: false;
      readonly code:
        | 'CONCURRENT_RUN'
        | 'IDEMPOTENCY_BODY_MISMATCH'
        | 'INSUFFICIENT_ADMISSION'
        | 'ADMISSION_UNAVAILABLE'
        | 'TRIAL_CAPACITY_REACHED';
    }
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
// Web-search fixtures are cheap, tool-capable, priceable text models. Left in the
// shared catalog they sink the trial premium-price 75th-percentile threshold and
// wrongly mark the over-1¢ trial fixtures premium. Each seed is dropped in its own
// `finally`; this prefix lets the suite also purge any row a killed run leaked before
// the finally could run (the `chat-route%` prefix survives the isolate-catalog reset,
// so leaks would otherwise accumulate across runs).
const WEB_SEARCH_MODEL_PREFIX = 'chat-route-search';
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

// Smart Model candidate derivation reads the WHOLE exposed catalog, and the
// classifier reserve scales with its size — a concurrent suite's text models
// would inflate the reserve until the cheap fixtures fall out of the affordable
// / 1¢-eligible set, refusing a send that should succeed (a 402 where a 201 is
// expected). Isolate the read: under the shared catalog lock, drop every foreign
// suite's rows — all of this suite's models are `chat-route*`, so its fixtures
// and the premium-gate price-spread decoys survive — so derivation sees only
// this suite's controlled set — but it keeps this suite's own `chat-route%` rows
// (the Smart Model success tests need the fixtures they just seeded). That makes
// it right for success reads but NOT for a percentile-dependent refusal, whose
// class (cost 402 vs premium 403) also flips when this suite's *own* accumulated
// cheap fixtures crowd the 75th-percentile threshold below the fixture's price;
// those refusals use `withDearTrialCatalog`, which pins the full set instead.
async function withIsolatedCatalog<T>(run: () => Promise<T>): Promise<T> {
  return withModelCatalogLock(redis, async () => {
    await db.delete(modelCatalog).where(notLike(modelCatalog.modelId, 'chat-route%'));
    return run();
  });
}

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

// Clear any web-search fixture leaked by an earlier run killed before its `finally`
// ran, so the trial premium-price percentile never sees a stale cheap decoy.
beforeAll(async () => {
  await db.delete(modelCatalog).where(like(modelCatalog.modelId, `${WEB_SEARCH_MODEL_PREFIX}%`));
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

/** A tool-capable text model — the web-search build gate requires `tools`. */
async function seedToolCapableModelId(modelId: string): Promise<void> {
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
        behaviors: ['streaming', 'tools'],
        limits: { contextLength: 1000 },
        pricing: { inputPerToken: '2', outputPerToken: '3' },
        zdrReachable: true,
        releasedAt: OLD_RELEASE_SECONDS,
        fetchedAt: 0,
      },
    })
    .onConflictDoNothing();
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

// The premium gate ranks a model's combined price against floor(len*0.75) of the
// exposed priceable-text catalog, so a trial refusal whose intended class is
// *cost* (402) reads as *premium* (403) whenever the distribution's cheap side is
// crowded — by foreign suites' rows OR by this suite's own accumulated cheap
// fixtures, which `withIsolatedCatalog` deliberately preserves. Pin a
// deterministic set instead: under the catalog lock, clear every row and seed one
// cheap eligible model, the pricey decoys that hold the top quartile, and the
// dear fixture at `dearId` priced just under the quartile — so the dear model
// stays non-premium and the intended cost gate fires, regardless of run order.
// Per-test re-seeding (every test seeds the models it needs) makes the wipe safe.
async function withDearTrialCatalog<T>(dearId: string, postSend: () => Promise<T>): Promise<T> {
  return withModelCatalogLock(redis, async () => {
    await db.delete(modelCatalog);
    await seedModel();
    await seedTrialDecoys();
    await seedGateModel(dearId, { pricing: { inputPerToken: '1000', outputPerToken: '0' } });
    return postSend();
  });
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
    // The real composition-root adapter over the conversations shared-link store,
    // so the public guest-send seam resolves credentials against seeded links.
    linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
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

  it('rejects a models array wider than MAX_SELECTED_MODELS with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        models: Array.from(
          { length: MAX_SELECTED_MODELS + 1 },
          (_, index) => `m/model-${String(index)}`
        ),
        userMessage: { id: crypto.randomUUID(), content: 'hi' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
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

  it('threads x-mock-* headers into the run-start body mockDirectives in dev/E2E', async () => {
    // The test env is NODE_ENV=development, so the route reads the mock headers
    // and populates the run-start body — proving per-request directives now flow.
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: Record<string, unknown>[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as Record<string, unknown>);
        return okAsync(STARTED);
      },
    });
    const res = await post(
      realtime,
      {
        cookie: await cookie(userId),
        'Idempotency-Key': crypto.randomUUID(),
        'x-mock-classifier-resolution': 'a/model',
        'x-mock-failing-models': 'm1,m2',
      },
      {
        conversationId,
        model: MODEL,
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.['mockDirectives']).toEqual({
      classifierResolution: 'a/model',
      failingModels: ['m1', 'm2'],
    });
  });

  it('builds a media (image) turn carrying its config as node params (201)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(imageModel, { outputs: ['image'], pricing: { perImage: '40000000' } });
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
        model: imageModel,
        modality: 'image',
        imageConfig: { aspectRatio: '4:3' },
        userMessage: { id: crypto.randomUUID(), content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    // A media turn is deadline-classed 'media' and dispatches the image model
    // with its config as params (the image adapter reads them at execution).
    expect(definition.deadlineClass).toBe('media');
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.model).toBe(imageModel);
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ aspectRatio: '4:3' });
  });

  it('builds an image turn with empty params when no config is supplied (201)', async () => {
    const imageModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(imageModel, { outputs: ['image'], pricing: { perImage: '40000000' } });
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
        model: imageModel,
        modality: 'image',
        userMessage: { id: crypto.randomUUID(), content: 'a red cube' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({});
  });

  it('builds a media (video) turn with its full config (201)', async () => {
    const videoModel = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(videoModel, { outputs: ['video'] });
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
        model: videoModel,
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
        userMessage: { id: crypto.randomUUID(), content: 'a drone shot' },
      }
    );
    expect(res.status).toBe(201);
    const answer = captured[0]?.nodes.find((node) => node.type === 'modelCall');
    expect(answer?.type === 'modelCall' && answer.params).toEqual({
      aspectRatio: '16:9',
      durationSeconds: 6,
      resolution: '720p',
    });
  });

  it('rejects a video turn missing its config with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        modality: 'video',
        userMessage: { id: crypto.randomUUID(), content: 'a drone shot' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses a media turn over a text-only model with 400 (wrong modality)', async () => {
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
        modality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        userMessage: { id: crypto.randomUUID(), content: 'a red cube' },
      }
    );
    expect(res.status).toBe(400);
  });

  it('refuses a paid send past the per-user rate cap (429) and stays per-user', async () => {
    await seedModel();
    const limitedUser = await seedUser();
    // Pre-fill this user's 60s window to the cap; the next send is the 31st.
    await redis.set(`chat:stream:user:ratelimit:${limitedUser}`, 30, { ex: 60 });
    const overLimit = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(limitedUser), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId: crypto.randomUUID(),
        model: MODEL,
        userMessage: { id: crypto.randomUUID(), content: 'hi' },
      }
    );
    expect(overLimit.status).toBe(429);
    expect(await overLimit.json()).toMatchObject({ code: 'RATE_LIMITED' });

    // A different user with a fresh window is unaffected — the limit is per-user.
    const freshUser = await seedUser();
    const conversationId = await seedConversation(freshUser, true);
    await seedPurchasedWallet(freshUser);
    const allowed = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(freshUser), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hi' } }
    );
    expect(allowed.status).toBe(201);
    await redis.del(`chat:stream:user:ratelimit:${limitedUser}`);
    await redis.del(`chat:stream:user:ratelimit:${freshUser}`);
  });

  it('threads web search onto the answer node for a tool-capable model (201)', async () => {
    const model = `${WEB_SEARCH_MODEL_PREFIX}/${crypto.randomUUID().slice(0, 8)}`;
    await seedToolCapableModelId(model);
    try {
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
      // Hold the catalog lock over the send: the build gate ranks the model's
      // price against the exposed-catalog percentile, so a foreign row landing
      // mid-request could push this tool-capable fixture over the premium
      // threshold and refuse it (400). The `chat-route-search/...` id survives
      // the isolation wipe (it clears only non-`chat-route%` rows).
      const res = await withIsolatedCatalog(() =>
        post(
          realtime,
          { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
          {
            conversationId,
            model,
            webSearchEnabled: true,
            userMessage: { id: crypto.randomUUID(), content: 'hello' },
          }
        )
      );
      expect(res.status).toBe(201);
      const definition = captured[0];
      if (definition === undefined) throw new Error('expected a captured definition');
      const answer = definition.nodes.find((node) => node.type === 'modelCall');
      expect(answer?.type === 'modelCall' && answer.tools).toEqual(['webSearch']);
      expect(answer?.type === 'modelCall' && answer.maxSteps).toBe(10);
    } finally {
      // Drop the seeded model so it never shifts the suite-shared catalog's
      // trial premium-price quartile for later trial tests.
      await db.delete(modelCatalog).where(eq(modelCatalog.modelId, model));
    }
  });

  it('refuses web search on a tool-incapable model with 400', async () => {
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
        webSearchEnabled: true,
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
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

  it('builds the one-node smartModel definition for a smart-model send (201)', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
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
    const res = await withIsolatedCatalog(async () =>
      post(
        realtime,
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          model: SMART_MODEL_ID,
          userMessage: { id: crypto.randomUUID(), content: 'hello' },
        }
      )
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    expect(definition.nodes).toHaveLength(1);
    const node = definition.nodes[0];
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    // Candidates are server-derived from the exposed catalog + wallet balance
    // (other suites seed catalog rows concurrently, so assert membership and
    // ordering invariants, never an exact list).
    const candidateIds = node.candidates.map((candidate) => candidate.id);
    expect(candidateIds).toEqual(expect.arrayContaining([MODEL, MODEL_B]));
    expect(node.classifierModelId).toBe(candidateIds[0]);
    expect(candidateIds).not.toContain(SMART_MODEL_ID);
  });

  it('hashes only client intent for a smart-model send — candidates never perturb the body hash', async () => {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const hashes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        hashes.push(body.bodyHash);
        return okAsync(STARTED);
      },
    });
    const userMessage = { id: crypto.randomUUID(), content: 'hello' };
    const body = { conversationId, model: SMART_MODEL_ID, userMessage };
    await withIsolatedCatalog(async () =>
      post(realtime, { cookie: await cookie(userId), 'Idempotency-Key': 'key-a' }, body)
    );
    // Second identical send after the catalog gained a model (a new candidate).
    await seedModelId(MODEL_C);
    await withIsolatedCatalog(async () =>
      post(realtime, { cookie: await cookie(userId), 'Idempotency-Key': 'key-b' }, body)
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).toBe(hashes[1]);
    // The hash is exactly the single-model hash shape over the sentinel id.
    expect(hashes[0]).toBe(
      await hashCanonicalJson({
        conversationId,
        model: SMART_MODEL_ID,
        userMessage,
        history: [],
      })
    );
  });

  it('refuses a smart-model send combined with a multi-model list with 400', async () => {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: SMART_MODEL_ID,
        models: [MODEL, MODEL_B],
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('refuses a smart-model send when no candidate is affordable with 402', async () => {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    // Both wallets, as at registration, with a zero purchased balance: the turn
    // routes to the free wallet, but Smart Model derives its candidates from the
    // purchased balance, so even the cheapest candidate plus the classifier
    // reserve is out of reach and the candidate list is empty.
    await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 0n });
    await db.insert(wallets).values({ userId, type: 'free', balanceNanoUsd: 0n });
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: SMART_MODEL_ID,
        userMessage: { id: crypto.randomUUID(), content: 'hello' },
      }
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: 'INSUFFICIENT_ADMISSION' });
  });

  it('maps a smart-model candidate-derivation failure to its domain error response (503)', async () => {
    await seedModelId(MODEL);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    // Fail only the allowance leg of the balance read: the turn context
    // (readWallets) still resolves, so the error surfaces inside the
    // smart-model candidate derivation and rides the route's domain-error map.
    const billing = createBillingStores();
    const failingBilling: typeof billing = {
      ...billing,
      readAllowanceSpent: () => errAsync(unavailableError('allowance read down')),
    };
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: failingBilling,
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          model: SMART_MODEL_ID,
          userMessage: { id: crypto.randomUUID(), content: 'hello' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
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

  it('maps an admission refusal to a synchronous 402 (never only a WS event)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'INSUFFICIENT_ADMISSION' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'INSUFFICIENT_ADMISSION' });
  });

  it('maps an admission-unavailable refusal to a synchronous 503', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'ADMISSION_UNAVAILABLE' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'ADMISSION_UNAVAILABLE' });
  });

  it('maps a trial-capacity refusal to a synchronous 429', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const res = await post(
      fakeRealtime({ started: false, code: 'TRIAL_CAPACITY_REACHED' }),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ code: 'TRIAL_CAPACITY_REACHED' });
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

// A release timestamp (unix SECONDS) inside the premium-recency window, so the
// seeded model reads as premium on the recency leg alone — independent of the
// shared catalog's price spread. Evaluated at seed time; the gate reads the wall
// clock a few ms later, so the model is unambiguously recent.
function recentReleaseSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Seeds a premium text model (registered for afterAll cleanup) and passes its id
 * to the test body, dropping it immediately afterwards so its cheap price never
 * lingers in the suite-shared catalog to sink a concurrent trial percentile.
 */
async function withPremiumModel(run: (modelId: string) => Promise<void>): Promise<void> {
  const modelId = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
  await seedGateModel(modelId, { releasedAt: recentReleaseSeconds() });
  try {
    await run(modelId);
  } finally {
    await db.delete(modelCatalog).where(eq(modelCatalog.modelId, modelId));
  }
}

/** A member with a zero purchased balance (cannot access premium) plus a free wallet. */
async function seedZeroBalanceMember(): Promise<{ userId: string; conversationId: string }> {
  const userId = await seedUser();
  const conversationId = await seedConversation(userId, true);
  await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd: 0n });
  await db.insert(wallets).values({ userId, type: 'free', balanceNanoUsd: 0n });
  return { userId, conversationId };
}

/**
 * An owner-funded group conversation: the owner has an ample balance, a
 * per-conversation budget, and a per-member cap for the sender, so a group turn
 * pays the OWNER's wallet. The sending member has no wallet of their own — so
 * the payer is never the caller, the direct-billing tier gate is skipped, and
 * the caller's own wallet read is a path distinct from the turn context's.
 */
async function seedOwnerFundedGroup(): Promise<{
  conversationId: string;
  owner: string;
  sender: string;
}> {
  const owner = await seedUser();
  const conversationRows = await db
    .insert(conversations)
    .values({ userId: owner, title: BYTES, conversationBudgetNanoUsd: 1_000_000n })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  await db
    .insert(epochs)
    .values({ conversationId, epochNumber: 1, epochPublicKey: BYTES, confirmationHash: BYTES });
  await db
    .insert(wallets)
    .values({ userId: owner, type: 'purchased', balanceNanoUsd: 10_000_000n });

  const sender = await seedUser();
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId: sender, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('member seed failed');
  await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 1_000_000n });
  return { conversationId, owner, sender };
}

describe('chat route: POST /chat premium-tier gate', () => {
  it('refuses a premium model for a zero-balance caller with 403 MODEL_TIER_LOCKED', async () => {
    await withPremiumModel(async (premiumModel) => {
      const { userId, conversationId } = await seedZeroBalanceMember();
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          model: premiumModel,
          userMessage: { id: crypto.randomUUID(), content: 'hello' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
    });
  });

  it('admits a non-premium model for the same zero-balance caller (201)', async () => {
    await seedModel();
    const { userId, conversationId } = await seedZeroBalanceMember();
    const res = await post(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage: { id: crypto.randomUUID(), content: 'hello' } }
    );
    expect(res.status).toBe(201);
  });

  it('admits the same premium model for a caller with a positive purchased balance (201)', async () => {
    await withPremiumModel(async (premiumModel) => {
      const userId = await seedUser();
      const conversationId = await seedConversation(userId, true);
      await seedPurchasedWallet(userId);
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          model: premiumModel,
          userMessage: { id: crypto.randomUUID(), content: 'hello' },
        }
      );
      expect(res.status).toBe(201);
    });
  });

  it('locks a multi-model send when any selected model is premium for a zero-balance caller (403)', async () => {
    await withPremiumModel(async (premiumModel) => {
      await seedModelId(MODEL);
      const { userId, conversationId } = await seedZeroBalanceMember();
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          model: MODEL,
          models: [MODEL, premiumModel],
          userMessage: { id: crypto.randomUUID(), content: 'hello' },
        }
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'MODEL_TIER_LOCKED' });
    });
  });

  it('does not tier-lock an owner-funded group turn (the caller is not the payer) (201)', async () => {
    await withPremiumModel(async (premiumModel) => {
      // The owner funds the group turn, so the payer is the OWNER's wallet. The
      // sending member has no wallet and could never access premium personally,
      // yet the gate must not fire — the caller is not the direct payer.
      const { conversationId, sender } = await seedOwnerFundedGroup();
      const res = await post(
        fakeRealtime(STARTED),
        { cookie: await cookie(sender), 'Idempotency-Key': crypto.randomUUID() },
        {
          conversationId,
          model: premiumModel,
          userMessage: { id: crypto.randomUUID(), content: 'hello' },
        }
      );
      expect(res.status).toBe(201);
    });
  });

  it('surfaces a caller wallet-read failure from the gate as 503', async () => {
    // The gate reads the CALLER's own wallets to decide premium access — a read
    // the owner-funded turn context never makes (it reads only the owner). A
    // failing sender read must surface as a typed unavailable error, distinct
    // from the context's own reads succeeding on the owner.
    const { conversationId, sender } = await seedOwnerFundedGroup();
    await seedModel();
    const billing = createBillingStores();
    const failingBilling: typeof billing = {
      ...billing,
      readWallets: (walletDb, userId) =>
        userId === sender
          ? errAsync(unavailableError('wallet read down'))
          : billing.readWallets(walletDb, userId),
    };
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: failingBilling,
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(sender),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          model: MODEL,
          userMessage: { id: crypto.randomUUID(), content: 'hello' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
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

  it('refuses a regenerate past the per-user rate cap (429)', async () => {
    const userId = await seedUser();
    // Pre-fill the shared per-user window to the cap; the next send is the 31st.
    await redis.set(`chat:stream:user:ratelimit:${userId}`, 30, { ex: 60 });
    const res = await postRegenerate(
      fakeRealtime(STARTED),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId: crypto.randomUUID(),
        model: MODEL,
        targetMessageId: crypto.randomUUID(),
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' });
    await redis.del(`chat:stream:user:ratelimit:${userId}`);
  });

  it('fans out a regenerate over a multi-model list (201)', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    await seedModelId(MODEL_C);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        models: [MODEL, MODEL_B, MODEL_C],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings.map((node) => node.model)).toEqual([MODEL, MODEL_B, MODEL_C]);
    for (const sibling of siblings) {
      expect(sibling.optional).toBe(true);
      expect(sibling.onError).toBe('skip');
    }
  });

  it('caps a multi-model regenerate at the payer-budget output ceiling', async () => {
    // A big-context model so the shared ceiling is BUDGET-derived (not context-
    // capped), proving the payer budget feeds the multi-model regenerate turn —
    // the path that silently lost its ceiling when the options argument bound to
    // a bare boolean. Money-adjacent: the ceiling feeds the admission hold.
    const bigA = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    const bigB = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(bigA, { limits: { contextLength: 1_000_000 } });
    await seedGateModel(bigB, { limits: { contextLength: 1_000_000 } });
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: bigA,
        models: [bigA, bigB],
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
      }
    );
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const siblings = definition.nodes.filter((node) => node.type === 'modelCall');
    expect(siblings).toHaveLength(2);
    const ceilings = siblings.map((node) => node.params['maxOutputTokens']);
    for (const ceiling of ceilings) {
      // Present, positive, and strictly below the context window — a budget-derived
      // ceiling. Before the fix, options bound to `false`, dropping the budget, so
      // no maxOutputTokens param was written at all.
      expect(typeof ceiling).toBe('number');
      expect(ceiling as number).toBeGreaterThan(0);
      expect(ceiling as number).toBeLessThan(1_000_000);
    }
    // The siblings share one ceiling (the multi-model turn's single budget).
    expect(ceilings[0]).toBe(ceilings[1]);
  });

  it('includes the models list in the regenerate body hash', async () => {
    await seedModelId(MODEL);
    await seedModelId(MODEL_B);
    await seedModelId(MODEL_C);
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const anchor = await seedMessage(conversationId, {
      senderType: 'user',
      senderId: userId,
      sequenceNumber: 1,
      parentMessageId: null,
    });
    const hashes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        hashes.push(body.bodyHash);
        return okAsync(STARTED);
      },
    });
    // Two regenerates identical but for the models list — different bodyHashes
    // prove the list feeds the dedup hash (so a multi-model retry never replays a
    // single-model run and vice versa).
    const userMessage = { id: crypto.randomUUID(), content: 'again' };
    const shared = {
      conversationId,
      model: MODEL,
      targetMessageId: anchor,
      action: 'retry',
    } as const;
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, models: [MODEL, MODEL_B], userMessage }
    );
    await postRegenerate(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { ...shared, models: [MODEL, MODEL_C], userMessage }
    );
    expect(hashes).toHaveLength(2);
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it("refuses a regenerate naming 'smart-model' with a clean 400 (unknown model)", async () => {
    // The regenerate route has no smart-model sentinel handling: the id is not
    // a catalog model, so the definition build refuses it like any unknown
    // model. Asserted explicitly so the behavior cannot change silently.
    await seedModelId(MODEL);
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
        model: SMART_MODEL_ID,
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

  it('starts a trial run (201) echoing the supplied session id', async () => {
    await seedModel();
    // A supplied token resolves as the session id, so the run room and the
    // returned trialSessionId are that token.
    const token = crypto.randomUUID();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders({ 'x-trial-token': token }), {
      model: MODEL,
      prompt: 'hi',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ runId: 'run-x', deadlineAt: 999, trialSessionId: token });
  });

  it('caps a trial single-model answer at the 1¢-derived output ceiling', async () => {
    // A cheap (trial-eligible) text model with a large context window, so the 1¢
    // budget derives a concrete cap rather than being swallowed by the window.
    const bigCtx = `chat-route/${crypto.randomUUID().slice(0, 8)}`;
    await seedGateModel(bigCtx, { limits: { contextLength: 1_000_000 } });
    const captured: WorkflowDefinition[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        return okAsync(STARTED);
      },
    });
    const res = await postTrial(realtime, trialHeaders(), { model: bigCtx, prompt: 'hi' });
    expect(res.status).toBe(201);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    const answer = definition.nodes.find((node) => node.type === 'modelCall');
    // free 1¢ budget (10_000_000n), base rates 2/3 (marked 2/3), prompt "hi" (2
    // chars): estInput=ceil(2/2)=1; fixed=1×2+2×300=602; variable=3+4×300=1203;
    // budgetMax=floor((10_000_000−602)/1203)=8312; context 1_000_000 keeps it capped.
    expect(answer?.type === 'modelCall' && answer.params).toEqual({ maxOutputTokens: 8312 });
  });

  it('mints and returns a session id a tokenless client can attach to its room', async () => {
    await seedModel();
    // No x-trial-token: the route mints a fresh session id and runs in trial:<id>.
    let capturedRoom = '';
    const realtime = fakeRealtime(STARTED, {
      startRun: (conversationId) => {
        capturedRoom = conversationId;
        return okAsync(STARTED);
      },
    });
    const res = await postTrial(
      realtime,
      {
        'Idempotency-Key': crypto.randomUUID(),
        'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
      },
      { model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(201);
    // The run room is trial:<mintedSessionId>; the 201 echoes that session id so
    // a tokenless client learns it.
    const sessionId = capturedRoom.replace(/^trial:/, '');
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await res.json()).toEqual({
      runId: 'run-x',
      deadlineAt: 999,
      trialSessionId: sessionId,
    });

    // A follow-up WS upgrade using that id as the token attaches to the SAME
    // server-derived room the run started in.
    const { calls, realtime: wsRealtime } = recordingUpgrade();
    const ws = await getPath('/chat/trial/websocket', wsRealtime, { 'x-trial-token': sessionId });
    expect(ws.status).toBe(200);
    expect(calls).toEqual([
      { conversationId: capturedRoom, principalId: capturedRoom, isGuest: false },
    ]);
  });

  it('ignores a trialToken query param on the POST (header-only route)', async () => {
    await seedModel();
    const queryToken = crypto.randomUUID();
    let capturedRoom = '';
    const realtime = fakeRealtime(STARTED, {
      startRun: (conversationId) => {
        capturedRoom = conversationId;
        return okAsync(STARTED);
      },
    });
    // No x-trial-token header: the WS-only query fallback must NOT leak into
    // the POST — the route mints a fresh session instead of adopting the param.
    const res = await postPath(
      `/chat/trial?trialToken=${encodeURIComponent(queryToken)}`,
      realtime,
      {
        'Idempotency-Key': crypto.randomUUID(),
        'cf-connecting-ip': `198.51.100.7-${crypto.randomUUID()}`,
      },
      { model: MODEL, prompt: 'hi' }
    );
    expect(res.status).toBe(201);
    expect(capturedRoom).toMatch(/^trial:/);
    expect(capturedRoom).not.toBe(`trial:${queryToken}`);
  });

  it('replays a settled trial key without the session-id 201 shape (200)', async () => {
    await seedModel();
    // A non-started outcome (a settled key replay) takes the shared contract, not
    // the fresh-run 201 — so no trialSessionId is minted onto it.
    const realtime = fakeRealtime({ outcome: 'replay', response: { runId: 'settled-trial' } });
    const res = await postTrial(realtime, trialHeaders(), { model: MODEL, prompt: 'hi' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: 'settled-trial' });
  });

  it('maps a trial run-start refusal to its status (409) without a session id', async () => {
    await seedModel();
    const realtime = fakeRealtime({ started: false, code: 'CONCURRENT_RUN' });
    const res = await postTrial(realtime, trialHeaders(), { model: MODEL, prompt: 'hi' });
    expect(res.status).toBe(409);
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

  it('builds the one-node smartModel definition for a trial smart-model send (201)', async () => {
    await seedModel();
    const captured: WorkflowDefinition[] = [];
    const modes: string[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body.definition);
        modes.push(body.mode);
        return okAsync(STARTED);
      },
    });
    const res = await withIsolatedCatalog(() =>
      postTrial(realtime, trialHeaders(), {
        model: SMART_MODEL_ID,
        prompt: 'hello',
      })
    );
    expect(res.status).toBe(201);
    expect(modes).toEqual(['trial']);
    const definition = captured[0];
    if (definition === undefined) throw new Error('expected a captured definition');
    // The same one-node smartModel turn as the paid path, under the trial
    // (no-persist / no-charge) hooks.
    expect(definition.hooks).toEqual({ admission: 'trial', settlement: 'trial' });
    expect(definition.nodes).toHaveLength(1);
    const node = definition.nodes[0];
    if (node?.type !== 'smartModel') throw new Error('expected a smartModel node');
    // Candidates are server-derived from the trial-eligible catalog subset
    // (other suites seed catalog rows concurrently, so assert membership and
    // invariants, never an exact list). The expensive decoys fail the trial
    // affordability leg, so they can never appear.
    const candidateIds = node.candidates.map((candidate) => candidate.id);
    expect(candidateIds).toContain(MODEL);
    expect(candidateIds).not.toContain(SMART_MODEL_ID);
    for (const decoyId of trialDecoyModelIds) {
      expect(candidateIds).not.toContain(decoyId);
    }
    expect(node.classifierModelId).toBe(candidateIds[0]);
  });

  // Large enough that even a 1-nano-per-input-token candidate's message base
  // (chars / 2 tokens) exceeds the 1¢ cap, so NO candidate can be eligible.
  const OVER_CAP_PROMPT_CHARS = 21_000_000;

  it('refuses a trial smart-model send with no eligible candidate as 402 TRIAL_MESSAGE_TOO_EXPENSIVE', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: SMART_MODEL_ID,
      prompt: 'x'.repeat(OVER_CAP_PROMPT_CHARS),
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  it('burns no quota slot for a trial smart-model refusal', async () => {
    await seedModel();
    // One fixed identity: five 402 refusals then a valid send prove the
    // refusals burned no slot (the candidate derivation precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.13-${crypto.randomUUID()}`,
    };
    const overCap = 'x'.repeat(OVER_CAP_PROMPT_CHARS);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: SMART_MODEL_ID, prompt: overCap }
      );
      expect(refused.status).toBe(402);
    }
    const ok = await withIsolatedCatalog(() =>
      postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: SMART_MODEL_ID, prompt: 'hi' }
      )
    );
    expect(ok.status).toBe(201);
  });

  it('consumes exactly one quota slot per successful trial smart-model send', async () => {
    await seedModel();
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.14-${crypto.randomUUID()}`,
    };
    // Hold the lock across all six sends: each derives candidates from the
    // catalog, so a foreign row landing mid-loop would refuse (402) a send the
    // test expects to reach the quota gate.
    await withIsolatedCatalog(async () => {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const ok = await postTrial(
          fakeRealtime(STARTED),
          { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
          { model: SMART_MODEL_ID, prompt: 'hi' }
        );
        expect(ok.status).toBe(201);
      }
      const sixth = await postTrial(
        fakeRealtime(STARTED),
        { 'Idempotency-Key': crypto.randomUUID(), ...fixed },
        { model: SMART_MODEL_ID, prompt: 'hi' }
      );
      expect(sixth.status).toBe(429);
      expect(await sixth.json()).toEqual({ code: 'TRIAL_LIMIT_REACHED' });
    });
  });

  it('refuses web search on a trial smart-model send first (403 FEATURE_REQUIRES_AUTH)', async () => {
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: SMART_MODEL_ID,
      prompt: 'hi',
      webSearchEnabled: true,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'FEATURE_REQUIRES_AUTH' });
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
    // The dear model is eligible on the model legs (old, below-quartile), yet a
    // long prompt pushes the actual message past 1¢ on the minimum basis. Its
    // refusal class is percentile-dependent, so pin a deterministic catalog.
    const res = await withDearTrialCatalog(dearId, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        model: dearId,
        prompt: 'x'.repeat(25_000),
      })
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  it('refuses a model with incomplete token pricing at the premium gate', async () => {
    const partialId = `chat-route-partial/${crypto.randomUUID().slice(0, 8)}`;
    // Only inputPerToken is priced: text on the model legs, but not priceable for
    // trial, so the eligibility gate excludes it as a premium exclusion.
    await seedGateModel(partialId, { pricing: { inputPerToken: '2' } });
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: partialId,
      prompt: 'hi',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'PREMIUM_REQUIRES_ACCOUNT' });
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
    // One fixed identity: five 402 TOO_EXPENSIVE refusals then a valid send prove
    // the refusals burned no slot (the affordability check precedes the quota INCR).
    const fixed = {
      'x-trial-token': crypto.randomUUID(),
      'cf-connecting-ip': `203.0.113.12-${crypto.randomUUID()}`,
    };
    // Pin a deterministic catalog for the whole sequence: the refusals' 402-vs-403
    // class is percentile-dependent (the helper seeds `dearId` + MODEL), and the
    // closing 201 on MODEL is a catalog-sensitive success send.
    await withDearTrialCatalog(dearId, async () => {
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
    // Hold the lock across all six sends: each derives the trial-eligible set
    // from the catalog, so a foreign row landing mid-loop could refuse (402/403)
    // a send the test expects to reach the quota gate (201, then 429).
    await withIsolatedCatalog(async () => {
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
    // Hold the lock across the burst: each valid-model send reads the trial set
    // from the catalog, so a foreign row landing mid-loop could refuse (402/403)
    // a send this test needs to either succeed (201) or hit the daily quota (429).
    await withIsolatedCatalog(async () => {
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
    });
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

  it('throttles a trial smart-model send at the burst cap before deriving candidates', async () => {
    await seedModel();
    // The burst gate answers before the smart-model candidate derivation ever
    // runs: an over-cap IP gets RATE_LIMITED, not a candidate-based outcome.
    const ip = `203.0.113.36-${crypto.randomUUID()}`;
    for (let attempt = 1; attempt <= BURST_CAP; attempt += 1) {
      await postTrial(fakeRealtime(STARTED), burstHeaders(ip), {
        model: 'no/such-model',
        prompt: 'hi',
      });
    }
    const throttled = await postTrial(fakeRealtime(STARTED), burstHeaders(ip), {
      model: SMART_MODEL_ID,
      prompt: 'hi',
    });
    expect(throttled.status).toBe(429);
    expect(await throttled.json()).toMatchObject({ code: 'RATE_LIMITED' });
    await redis.del(`trial:burst:ip:ratelimit:${await hashIp(ip)}`);
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

  it('upgrades via the trialToken query param when the header is absent (browser WS)', async () => {
    const token = crypto.randomUUID();
    const { calls, realtime } = recordingUpgrade();
    // A browser WebSocket cannot set headers, so the upgrade must honor the
    // query-param credential and land in the SAME room the POST started.
    const res = await getPath(
      `/chat/trial/websocket?trialToken=${encodeURIComponent(token)}`,
      realtime,
      {}
    );
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { conversationId: `trial:${token}`, principalId: `trial:${token}`, isGuest: false },
    ]);
  });

  it('prefers the x-trial-token header over the trialToken query param', async () => {
    const headerToken = crypto.randomUUID();
    const queryToken = crypto.randomUUID();
    const { calls, realtime } = recordingUpgrade();
    const res = await getPath(
      `/chat/trial/websocket?trialToken=${encodeURIComponent(queryToken)}`,
      realtime,
      { 'x-trial-token': headerToken }
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.conversationId).toBe(`trial:${headerToken}`);
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
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
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

describe('chat routes: client-supplied history threading', () => {
  const HISTORY = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'first answer' },
  ];

  interface CapturedRun {
    readonly history: unknown;
    readonly bodyHash: string;
  }

  /** Records every run body the routes hand to the (faked) conversation room. */
  function capturingRealtime(runs: CapturedRun[]): RealtimeBroadcast {
    return fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        runs.push({ history: body.history, bodyHash: body.bodyHash });
        return okAsync(STARTED);
      },
    });
  }

  it('round-trips history from a paid send into the run body', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const runs: CapturedRun[] = [];
    const res = await post(
      capturingRealtime(runs),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        userMessage: { id: crypto.randomUUID(), content: 'and now?' },
        history: HISTORY,
      }
    );
    expect(res.status).toBe(201);
    expect(runs[0]?.history).toEqual(HISTORY);
  });

  it('round-trips history from a regenerate into the run body', async () => {
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
    const runs: CapturedRun[] = [];
    const res = await postRegenerate(
      capturingRealtime(runs),
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        targetMessageId: anchor,
        action: 'retry',
        userMessage: { id: crypto.randomUUID(), content: 'again' },
        history: HISTORY,
      }
    );
    expect(res.status).toBe(201);
    expect(runs[0]?.history).toEqual(HISTORY);
  });

  it('round-trips history from a trial send into the run body', async () => {
    await seedModel();
    const runs: CapturedRun[] = [];
    const res = await postTrial(capturingRealtime(runs), trialHeaders(), {
      model: MODEL,
      prompt: 'and now?',
      history: HISTORY,
    });
    expect(res.status).toBe(201);
    expect(runs[0]?.history).toEqual(HISTORY);
  });

  it('hashes an absent history identically to an empty one (no spurious body-mismatch 409)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const userMessage = { id: crypto.randomUUID(), content: 'same turn' };
    const runs: CapturedRun[] = [];
    const realtime = capturingRealtime(runs);
    const absent = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage }
    );
    const empty = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage, history: [] }
    );
    expect(absent.status).toBe(201);
    expect(empty.status).toBe(201);
    expect(runs[1]?.bodyHash).toBe(runs[0]?.bodyHash);
  });

  it('hashes a different history to a different body (drives the referee body-mismatch 409)', async () => {
    await seedModel();
    const userId = await seedUser();
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const userMessage = { id: crypto.randomUUID(), content: 'same turn' };
    const runs: CapturedRun[] = [];
    const realtime = capturingRealtime(runs);
    const first = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      { conversationId, model: MODEL, userMessage, history: HISTORY }
    );
    const second = await post(
      realtime,
      { cookie: await cookie(userId), 'Idempotency-Key': crypto.randomUUID() },
      {
        conversationId,
        model: MODEL,
        userMessage,
        history: [{ role: 'user', content: 'a different past' }],
      }
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(runs[1]?.bodyHash).not.toBe(runs[0]?.bodyHash);
  });

  it('blocks a trial send whose history pushes the message past 1¢ with 402', async () => {
    const dearId = `chat-route-dear/${crypto.randomUUID().slice(0, 8)}`;
    // The dear model is eligible on the model legs, and the prompt alone is
    // affordable — the resent history is what makes this send cost more than 1¢.
    // Its refusal class is percentile-dependent, so pin a deterministic catalog.
    const res = await withDearTrialCatalog(dearId, () =>
      postTrial(fakeRealtime(STARTED), trialHeaders(), {
        model: dearId,
        prompt: 'hi',
        history: [
          { role: 'user', content: 'x'.repeat(12_500) },
          { role: 'assistant', content: 'y'.repeat(12_500) },
        ],
      })
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ code: 'TRIAL_MESSAGE_TOO_EXPENSIVE' });
  });

  it('admits a trial send whose short history stays within the 1¢ cap', async () => {
    // The known-eligible cheap model: a short history adds a handful of input
    // tokens, nowhere near the cap (the exact price boundary is unit-tested on
    // trialMessageBaseNanoUsd).
    await seedModel();
    const res = await postTrial(fakeRealtime(STARTED), trialHeaders(), {
      model: MODEL,
      prompt: 'hi',
      history: [{ role: 'user', content: 'short past' }],
    });
    expect(res.status).toBe(201);
  });
});

// The paid run-start body the guest route hands the DO, captured server-side.
interface CapturedRunBody {
  readonly userId?: string;
  readonly senderId?: string;
  readonly sender?: { readonly kind: string; readonly linkId?: string; readonly memberId?: string };
  readonly walletId?: string;
}

async function postGuest(
  realtime: RealtimeBroadcast,
  credential: string | undefined,
  body: unknown
): Promise<Response> {
  const headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() };
  if (credential !== undefined) headers[LINK_CREDENTIAL_HEADER] = credential;
  return postPath('/chat/guest', realtime, headers, body);
}

interface SeededGuest {
  readonly credential: string;
  readonly linkId: string;
  readonly memberId: string;
}

/** Seeds a shared link + its link-guest member (write by default) for a conversation. */
async function seedGuestLink(
  conversationId: string,
  options: { readonly privilege?: 'read' | 'write'; readonly leftAt?: boolean } = {}
): Promise<SeededGuest> {
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const linkRows = await db
    .insert(sharedLinks)
    .values({ conversationId, linkPublicKey: publicKey, displayName: 'Guest' })
    .returning({ id: sharedLinks.id });
  const linkId = linkRows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  const memberRows = await db
    .insert(conversationMembers)
    .values({
      conversationId,
      linkId,
      privilege: options.privilege ?? 'write',
      visibleFromEpoch: 1,
      ...(options.leftAt === true ? { leftAt: new Date() } : {}),
    })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('guest member seed failed');
  return { credential: toBase64(publicKey), linkId, memberId };
}

/** Funds an owner-covered guest turn: owner purchased wallet, conversation cap, member cap. */
async function seedOwnerFunding(
  ownerId: string,
  conversationId: string,
  memberId: string
): Promise<void> {
  await db
    .insert(wallets)
    .values({ userId: ownerId, type: 'purchased', balanceNanoUsd: 10_000_000n });
  await db
    .update(conversations)
    .set({ conversationBudgetNanoUsd: 1_000_000n })
    .where(eq(conversations.id, conversationId));
  await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });
}

describe('chat route: POST /chat/guest (link-guest send)', () => {
  it('owner-funds a WRITE guest turn and resolves the sender server-side from the credential', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'hello from a guest' },
    });
    expect(res.status).toBe(201);
    const body = captured[0];
    // The OWNER pays; the guest is the sender (linkId), member id server-resolved.
    expect(body?.userId).toBe(ownerId);
    expect(body?.senderId).toBe(guest.linkId);
    expect(body?.sender).toEqual({
      kind: 'linkGuest',
      linkId: guest.linkId,
      memberId: guest.memberId,
    });
  });

  it('IGNORES a client-spoofed sender/memberId/userId in the body (server resolution wins)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'spoof attempt' },
      // Attacker-supplied identity fields — must be dropped, never trusted.
      userId: 'attacker-owner',
      senderId: 'attacker-link',
      sender: { kind: 'linkGuest', linkId: 'attacker-link', memberId: 'attacker-member' },
      memberId: 'attacker-member',
    });
    expect(res.status).toBe(201);
    const body = captured[0];
    expect(body?.userId).toBe(ownerId);
    expect(body?.senderId).toBe(guest.linkId);
    expect(body?.sender).toEqual({
      kind: 'linkGuest',
      linkId: guest.linkId,
      memberId: guest.memberId,
    });
  });

  it('DENIES a guest turn the owner cannot fund (no member cap → no fall-through wallet)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    // Owner wallet + conversation cap, but NO member-budget row → zero headroom.
    await db
      .insert(wallets)
      .values({ userId: ownerId, type: 'purchased', balanceNanoUsd: 10_000_000n });
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 1_000_000n })
      .where(eq(conversations.id, conversationId));
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'no funds' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a READ-only guest', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'read' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'read only' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a REVOKED guest (its member row marked left)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write', leftAt: true });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'revoked' },
    });
    expect(res.status).toBe(403);
  });

  it('refuses a guest of conversation A pointing its credential at conversation B (typed match)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationA = await seedConversation(ownerId, false);
    const conversationB = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationA, { privilege: 'write' });
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId: conversationB,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'wrong conversation' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a guest send with no link credential (401)', async () => {
    const conversationId = crypto.randomUUID();
    const res = await postGuest(fakeRealtime(STARTED), undefined, {
      conversationId,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'anon' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a guest Smart Model send that also carries a multi-model list (400)', async () => {
    const conversationId = crypto.randomUUID();
    const res = await postGuest(
      fakeRealtime(STARTED),
      toBase64(crypto.getRandomValues(new Uint8Array(32))),
      {
        conversationId,
        model: SMART_MODEL_ID,
        models: [MODEL, MODEL_B],
        userMessage: { id: crypto.randomUUID(), content: 'bad combo' },
      }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('lets a FULL-SESSION user send on the guest route, resolved as a user (not a guest)', async () => {
    await seedModel();
    const userId = await seedUser();
    // The user owns the conversation and is a member; a session cookie (no link
    // credential) resolves them as a user caller.
    const conversationId = await seedConversation(userId, true);
    await seedPurchasedWallet(userId);
    const captured: CapturedRunBody[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as CapturedRunBody);
        return okAsync(STARTED);
      },
    });
    const res = await createApp(realtime).request(
      '/chat/guest',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: await cookie(userId),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          model: MODEL,
          userMessage: { id: crypto.randomUUID(), content: 'a user on the guest route' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(201);
    expect(captured[0]?.userId).toBe(userId);
    expect(captured[0]?.sender?.kind).toBe('user');
  });

  it('carries a fork send through the guest seam (forkId bound to the run body)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const forkId = await seedFork(conversationId);
    const captured: Record<string, unknown>[] = [];
    const realtime = fakeRealtime(STARTED, {
      startRun: (_conversationId, body) => {
        captured.push(body as unknown as Record<string, unknown>);
        return okAsync(STARTED);
      },
    });
    const res = await postGuest(realtime, guest.credential, {
      conversationId,
      model: MODEL,
      forkId,
      userMessage: { id: crypto.randomUUID(), content: 'onto a fork' },
    });
    expect(res.status).toBe(201);
    expect(captured[0]?.['forkId']).toBe(forkId);
  });

  it('fails closed (503) when the link-resolution store is unavailable', async () => {
    const conversationId = crypto.randomUUID();
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: () => ({
        resolveLinkCredential: () => errAsync(unavailableError('link store down')),
      }),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await app.request(
      '/chat/guest',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [LINK_CREDENTIAL_HEADER]: toBase64(crypto.getRandomValues(new Uint8Array(32))),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          model: MODEL,
          userMessage: { id: crypto.randomUUID(), content: 'store down' },
        }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
  });

  it('refuses a guest send past the per-sender rate cap (429, keyed on the linkId)', async () => {
    await seedModel();
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    // Pre-fill the guest's 60s window to the cap (keyed on the linkId).
    await redis.set(`chat:stream:user:ratelimit:${guest.linkId}`, 30, { ex: 60 });
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      model: MODEL,
      userMessage: { id: crypto.randomUUID(), content: 'flooding' },
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('surfaces a guest build refusal (unknown model) from the shared pipeline', async () => {
    const ownerId = await seedUser();
    const conversationId = await seedConversation(ownerId, false);
    const guest = await seedGuestLink(conversationId, { privilege: 'write' });
    await seedOwnerFunding(ownerId, conversationId, guest.memberId);
    const res = await postGuest(fakeRealtime(STARTED), guest.credential, {
      conversationId,
      model: `chat-route/${crypto.randomUUID().slice(0, 8)}-absent`,
      userMessage: { id: crypto.randomUUID(), content: 'unknown model' },
    });
    // The build refuses before any run starts (never a 201) — the guest turn is
    // the SAME compile pipeline as an authenticated send.
    expect(res.status).toBe(400);
  });
});

describe('chat route: POST /chat/:conversationId/message (user-only send)', () => {
  /** A conversation whose epoch key is REAL (the route wraps content to it). */
  async function seedMessageConversation(
    userId: string,
    options: { readonly member?: boolean; readonly privilege?: 'read' | 'write' } = {}
  ): Promise<string> {
    const rows = await db
      .insert(conversations)
      .values({ userId, title: BYTES })
      .returning({ id: conversations.id });
    const conversationId = rows[0]?.id;
    if (conversationId === undefined) throw new Error('conversation seed failed');
    createdConversationIds.push(conversationId);
    await db.insert(epochs).values({
      conversationId,
      epochNumber: 1,
      epochPublicKey: generateEpochKeyPair().publicKey,
      confirmationHash: BYTES,
    });
    if (options.member !== false) {
      await db.insert(conversationMembers).values({
        conversationId,
        userId,
        visibleFromEpoch: 1,
        privilege: options.privilege ?? 'write',
      });
    }
    return conversationId;
  }

  function postMessage(
    realtime: RealtimeBroadcast,
    conversationId: string,
    headers: Record<string, string>,
    body: unknown
  ): Promise<Response> {
    return postPath(`/chat/${conversationId}/message`, realtime, headers, body);
  }

  it('rejects an anonymous request', async () => {
    const res = await postMessage(
      fakeRealtime(STARTED),
      crypto.randomUUID(),
      {},
      {
        messageId: crypto.randomUUID(),
        content: 'hi',
      }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a malformed body with 400', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const res = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: await cookie(userId) },
      { messageId: 'not-a-uuid', content: '' }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: 'VALIDATION' });
  });

  it('refuses a non-member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId, { member: false });
    const res = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: await cookie(userId) },
      { messageId: crypto.randomUUID(), content: 'hi' }
    );
    expect(res.status).toBe(403);
  });

  it('refuses a read-only member with 403', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId, { privilege: 'read' });
    const res = await postMessage(
      fakeRealtime(STARTED),
      conversationId,
      { cookie: await cookie(userId) },
      { messageId: crypto.randomUUID(), content: 'hi' }
    );
    expect(res.status).toBe(403);
  });

  it('persists without an Idempotency-Key header and broadcasts message:new post-commit', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    const broadcasts: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      broadcast: (targetId, event) => {
        broadcasts.push({ targetId, event });
        return okAsync({ delivered: 1, paused: 0, evicted: 0 });
      },
    });

    // Deliberately NO Idempotency-Key header: the messageId is the natural key.
    const res = await postMessage(
      realtime,
      conversationId,
      { cookie: await cookie(userId) },
      { messageId, content: 'group message, ai off' }
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId, sequenceNumber: 1, epochNumber: 1 });
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.senderType).toBe('user');
    expect(rows[0]?.senderId).toBe(userId);
    expect(broadcasts).toEqual([
      {
        targetId: conversationId,
        event: expect.objectContaining({
          type: 'message:new',
          messageId,
          conversationId,
          senderType: 'user',
          senderId: userId,
          sequenceNumber: 1,
        }),
      },
    ]);
  });

  it('answers 409 DUPLICATE_MESSAGE for a resent messageId', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    const sessionCookie = await cookie(userId);
    const send = (): Promise<Response> =>
      postMessage(
        fakeRealtime(STARTED),
        conversationId,
        { cookie: sessionCookie },
        { messageId, content: 'same again' }
      );

    const firstSend = await send();
    expect(firstSend.status).toBe(200);
    const dup = await send();
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ code: 'DUPLICATE_MESSAGE' });
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
  });

  it('still answers 200 when the broadcast fails (best-effort, already committed)', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    const realtime = fakeRealtime(STARTED, {
      broadcast: () => errAsync(unavailableError('room unreachable')),
    });

    const res = await postMessage(
      realtime,
      conversationId,
      { cookie: await cookie(userId) },
      { messageId, content: 'commit survives broadcast failure' }
    );

    expect(res.status).toBe(200);
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
  });

  it('honors injected chatStores and epoch reader (manifest composer pass-through)', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    const readerCalls: number[] = [];
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      chatStores: createChatStores(),
      readEpochPublicKey: async (tx, targetConversation, epochNumber) => {
        readerCalls.push(epochNumber);
        const rows = await tx
          .select({ key: epochs.epochPublicKey })
          .from(epochs)
          .where(eq(epochs.conversationId, targetConversation));
        return rows[0]?.key ?? null;
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      `/chat/${conversationId}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await cookie(userId) },
        body: JSON.stringify({ messageId, content: 'through injected deps' }),
      },
      testEnv
    );
    expect(res.status).toBe(200);
    expect(readerCalls).toEqual([1]);
  });

  it('maps a domain write failure through the slice error map (503)', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => fakeRealtime(STARTED),
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      // A missing wrap key is the defect arm: the write fails unavailable.
      readEpochPublicKey: () => Promise.resolve(null),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await app.request(
      `/chat/${conversationId}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await cookie(userId) },
        body: JSON.stringify({ messageId: crypto.randomUUID(), content: 'will fail' }),
      },
      testEnv
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: 'UNAVAILABLE' });
  });

  it('refuses a caller on a nonexistent conversation with 403 (member gate answers first)', async () => {
    const userId = await seedUser();
    const res = await postMessage(
      fakeRealtime(STARTED),
      crypto.randomUUID(),
      { cookie: await cookie(userId) },
      { messageId: crypto.randomUUID(), content: 'nowhere' }
    );
    expect(res.status).toBe(403);
  });

  // The post-commit push side-band: the runless send historically fired NO push
  // (unlike the AI turn). These exercise the wired capability — its arguments,
  // its suppression, and its strict best-effort isolation from the response.

  /** A collecting ExecutionContext so the route's `waitUntil` push is awaitable. */
  function collectingCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
    const tasks: Promise<unknown>[] = [];
    const ctx: ExecutionContext = {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
      passThroughOnException: () => {
        /* no-op in tests */
      },
      props: {},
    };
    return {
      ctx,
      settled: async () => {
        await Promise.all(tasks);
      },
    };
  }

  /** A noop telemetry for the composed test notify (only `.warn` is ever reached). */
  function noopTelemetry(): Telemetry {
    const noop = (): void => undefined;
    return {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      emitMetric: noop,
      captureError: noop,
    } as unknown as Telemetry;
  }

  /** Mounts the user-only route with an injected push capability (factory ignores env/db). */
  function appWithNotify(realtime: RealtimeBroadcast, notify: NotifyNewMessage): Hono<AppEnv> {
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => realtime,
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      notifyNewMessage: () => notify,
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  async function postMessageNotify(args: {
    app: Hono<AppEnv>;
    conversationId: string;
    userId: string;
    body: unknown;
    ctx: ExecutionContext;
  }): Promise<Response> {
    return args.app.request(
      `/chat/${args.conversationId}/message`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: await cookie(args.userId) },
        body: JSON.stringify(args.body),
      },
      testEnv,
      args.ctx
    );
  }

  it('fires the push side-band with the sender and the live-presence snapshot', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const presentId = crypto.randomUUID();
    const calls: {
      conversationId: string;
      senderUserId: string;
      presentUserIds: readonly string[];
    }[] = [];
    const notify: NotifyNewMessage = (args) => {
      calls.push(args);
      return Promise.resolve();
    };
    const realtime = fakeRealtime(STARTED, { presence: () => okAsync([presentId]) });
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(realtime, notify),
      conversationId,
      userId,
      body: { messageId: crypto.randomUUID(), content: 'ai off, notify the room' },
      ctx,
    });
    expect(res.status).toBe(200);
    await settled();

    // The sender is the poster and the present set is the live DO snapshot —
    // both handed straight to the capability (suppression happens downstream).
    expect(calls).toEqual([{ conversationId, senderUserId: userId, presentUserIds: [presentId] }]);
  });

  it('pushes only the absent, non-muted member — present, muted, and sender suppressed', async () => {
    const sender = await seedUser();
    const conversationId = await seedMessageConversation(sender);
    const absent = await seedUser();
    const present = await seedUser();
    const muted = await seedUser();
    await db.insert(deviceTokens).values([
      { userId: sender, token: `tok-${crypto.randomUUID()}`, platform: 'ios' },
      { userId: absent, token: `tok-absent-${crypto.randomUUID()}`, platform: 'ios' },
      { userId: present, token: `tok-${crypto.randomUUID()}`, platform: 'ios' },
      { userId: muted, token: `tok-${crypto.randomUUID()}`, platform: 'ios' },
    ]);
    const absentTokenRows = await db
      .select({ token: deviceTokens.token })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, absent));
    const absentToken = absentTokenRows[0]?.token;

    const mockPush = createMockPushSender();
    // The route hands the capability the sender + presence; this stand-in runs
    // the real recipient selection + device-token read over the DO's exact
    // suppression rules (mute / presence / sender), observing what it sends.
    const members = [
      { userId: sender, muted: false },
      { userId: absent, muted: false },
      { userId: present, muted: false },
      { userId: muted, muted: true },
    ];
    const membership: MembershipReader = { listActiveUserMembers: () => okAsync(members) };
    const notify: NotifyNewMessage = ({ conversationId: cid, senderUserId, presentUserIds }) =>
      sendPushForNewMessage(
        {
          membership,
          presence: { presence: () => okAsync(presentUserIds) },
          deviceTokens: createDeviceTokenStore(db),
          push: mockPush,
          logger: noopTelemetry(),
        },
        {
          conversationId: cid,
          senderUserId,
          title: 'New message',
          body: 'You have a new message in a conversation.',
        }
      ).match(
        () => {
          /* delivered — best-effort */
        },
        () => {
          /* logged already — best-effort */
        }
      );
    const realtime = fakeRealtime(STARTED, { presence: () => okAsync([present]) });
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(realtime, notify),
      conversationId,
      userId: sender,
      body: { messageId: crypto.randomUUID(), content: 'only the absent member is pushed' },
      ctx,
    });
    expect(res.status).toBe(200);
    await settled();

    const sent = mockPush.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.tokens).toEqual([absentToken]);
  });

  it('still answers 200 and commits when the push capability rejects', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    const notify: NotifyNewMessage = () => Promise.reject(new Error('push subsystem down'));
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(fakeRealtime(STARTED), notify),
      conversationId,
      userId,
      body: { messageId, content: 'push blows up but the send stands' },
      ctx,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId, sequenceNumber: 1, epochNumber: 1 });
    await settled();
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
  });

  it('does not push on a duplicate resend — the push fires only on the committed save', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    let calls = 0;
    const notify: NotifyNewMessage = () => {
      calls += 1;
      return Promise.resolve();
    };
    const app = appWithNotify(fakeRealtime(STARTED), notify);
    const body = { messageId, content: 'same message twice' };

    const first = collectingCtx();
    const firstRes = await postMessageNotify({
      app,
      conversationId,
      userId,
      body,
      ctx: first.ctx,
    });
    expect(firstRes.status).toBe(200);
    await first.settled();

    const second = collectingCtx();
    const dup = await postMessageNotify({
      app,
      conversationId,
      userId,
      body,
      ctx: second.ctx,
    });
    expect(dup.status).toBe(409);
    await second.settled();

    expect(calls).toBe(1);
  });

  it('still answers 200 and commits when the push FACTORY throws synchronously', async () => {
    // The factory (createPushSenderFromEnv, run at notifyFactory(env, db)) throws
    // synchronously on a misconfigured deploy. That construction must sit inside the
    // best-effort guard, or the throw escapes onto the request path after commit +
    // broadcast and turns the 200 into a 500 — violating the best-effort guarantee.
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    const messageId = crypto.randomUUID();
    const broadcasts: unknown[] = [];
    const realtime = fakeRealtime(STARTED, {
      broadcast: (targetId, event) => {
        broadcasts.push({ targetId, event });
        return okAsync({ delivered: 1, paused: 0, evicted: 0 });
      },
    });
    const manifest = createChatManifest({
      conversations: createConversationsStores,
      billing: createBillingStores(),
      realtime: () => realtime,
      trialRoomName: (sessionId) => `trial:${sessionId}`,
      linkResolution: (linkDb) => createLinkResolutionAdapter(linkDb),
      notifyNewMessage: () => {
        throw new Error('FCM config missing');
      },
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app,
      conversationId,
      userId,
      body: { messageId, content: 'factory blows up but the send stands' },
      ctx,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messageId, sequenceNumber: 1, epochNumber: 1 });
    await settled();
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(rows).toHaveLength(1);
    expect(broadcasts).toHaveLength(1);
  });

  it('skips the push and still answers 200 when presence is unavailable', async () => {
    const userId = await seedUser();
    const conversationId = await seedMessageConversation(userId);
    let calls = 0;
    const notify: NotifyNewMessage = () => {
      calls += 1;
      return Promise.resolve();
    };
    const realtime = fakeRealtime(STARTED, {
      presence: () => errAsync(unavailableError('room unreachable')),
    });
    const { ctx, settled } = collectingCtx();

    const res = await postMessageNotify({
      app: appWithNotify(realtime, notify),
      conversationId,
      userId,
      body: { messageId: crypto.randomUUID(), content: 'presence down, no push' },
      ctx,
    });
    expect(res.status).toBe(200);
    await settled();
    expect(calls).toBe(0);
  });
});
