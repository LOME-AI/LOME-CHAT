import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationForks,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  messages,
  sharedLinks,
  sharedMessages,
  users,
} from '@hushbox/db';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createRedisMembershipCache } from './adapters/membership.js';
import {
  createConversationsManifest,
  createConversationsStores,
  publicShareReadRateLimit,
} from './index.js';
import { createMembershipRevoker } from './adapters/membership.js';
import { deleteForkMessagesWithinTx } from '../chat/index.js';
import { Redis } from '@upstash/redis';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from './ports/realtime.js';
import type { ConversationsStores } from './ports/index.js';
import type { DomainError } from '../../lib/errors/index.js';
import type { ResultAsync } from '../../lib/result/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for conversations route tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

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

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
let userCounter = 0;

const BYTES = new Uint8Array([9, 9, 9]);
const B64 = toBase64(new Uint8Array([1, 2, 3]));

interface TestUser {
  userId: string;
  cookie: string;
  publicKey: Uint8Array;
}

async function newUser(): Promise<TestUser> {
  userCounter += 1;
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}u${String(userCounter)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@conversations.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const sealed = await sealData(
    {
      userId,
      sessionId: `session-${userId}`,
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return { userId, cookie: `${SESSION_COOKIE_NAME}=${sealed}`, publicKey };
}

interface EvictedCall {
  conversationId: string;
  principalId: string;
}

interface BroadcastCall {
  conversationId: string;
  event: { type: string; [key: string]: unknown };
}

function recordingRealtime(
  evicted: EvictedCall[],
  broadcasts: BroadcastCall[] = []
): RealtimeBroadcast {
  return {
    broadcast: (conversationId, event) => {
      broadcasts.push({ conversationId, event: event as BroadcastCall['event'] });
      return okAsync({ delivered: 0, paused: 0, evicted: 0 });
    },
    evict: (conversationId, principalId) => {
      evicted.push({ conversationId, principalId });
      return okAsync(1);
    },
    presence: () => okAsync([]),
    startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0 }),
    stopRun: () => okAsync(false),
    upgrade: () => okAsync(new Response(null, { status: 200 })),
  };
}

function createApp(evicted: EvictedCall[] = [], broadcasts: BroadcastCall[] = []): Hono<AppEnv> {
  const manifest = createConversationsManifest({
    stores: createConversationsStores,
    revoker: createMembershipRevoker,
    realtime: () => recordingRealtime(evicted, broadcasts),
    deleteForkMessages: (db) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(db, conversationId, ids),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

interface SendOptions {
  app?: Hono<AppEnv>;
  idempotencyKey?: string | null;
  env?: Bindings & TelemetryEnv;
}

interface RequestSpec extends SendOptions {
  method: string;
  path: string;
  cookie: string;
  body?: unknown;
}

interface ConversationBody {
  created: boolean;
  conversation: { id: string; title: string; currentEpoch: number };
  membership: Record<string, unknown>;
  forks?: { id: string; name: string; tipMessageId: string | null }[];
}

interface ListBody {
  conversations: { id: string; pinned: boolean }[];
  nextCursor: string | null;
}

interface MemberBody {
  member: { id: string; userId: string | null };
  newEpochNumber: number | null;
}

async function dispatch(spec: RequestSpec): Promise<Response> {
  const app = spec.app ?? createApp();
  const headers: Record<string, string> = {
    cookie: spec.cookie,
    'content-type': 'application/json',
  };
  if (spec.idempotencyKey !== null && spec.method !== 'GET') {
    headers['Idempotency-Key'] = spec.idempotencyKey ?? crypto.randomUUID();
  }
  return app.request(
    spec.path,
    {
      method: spec.method,
      headers,
      ...(spec.body === undefined ? {} : { body: JSON.stringify(spec.body) }),
    },
    spec.env ?? testEnv
  );
}

const send = (method: string, path: string, cookie: string, body?: unknown): Promise<Response> =>
  dispatch({ method, path, cookie, body });

const get = (path: string, cookie: string, options: SendOptions = {}): Promise<Response> =>
  dispatch({ method: 'GET', path, cookie, ...options });

function createBody(id: string): Record<string, unknown> {
  return {
    id,
    title: B64,
    epochPublicKey: B64,
    confirmationHash: B64,
    memberWrap: B64,
  };
}

/** Creates a conversation through the API and tracks it for cleanup. */
async function createConversation(owner: TestUser): Promise<string> {
  const id = crypto.randomUUID();
  createdConversationIds.push(id);
  const res = await send('POST', '/conversations', owner.cookie, createBody(id));
  if (res.status !== 200) throw new Error(`conversation create failed: ${String(res.status)}`);
  return id;
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('conversations routes: pipeline enforcement', () => {
  const ID = '0197a000-0000-7000-8000-000000000001';
  const routes: [string, string][] = [
    ['POST', '/conversations'],
    ['GET', '/conversations'],
    ['GET', `/conversations/${ID}`],
    ['DELETE', `/conversations/${ID}`],
    ['GET', `/conversations/${ID}/members`],
    ['POST', `/conversations/${ID}/members`],
    ['POST', `/conversations/${ID}/members/${ID}/remove`],
    ['POST', `/conversations/${ID}/leave`],
    ['PATCH', `/conversations/${ID}`],
    ['PATCH', `/conversations/${ID}/membership/mute`],
    ['PATCH', `/conversations/${ID}/membership/pin`],
    ['PATCH', `/conversations/${ID}/membership/accept`],
    ['POST', `/conversations/${ID}/membership/decline`],
    ['PATCH', `/conversations/${ID}/member/${ID}/privilege`],
    ['GET', `/conversations/${ID}/keychain`],
    ['GET', `/conversations/${ID}/forks`],
    ['POST', `/conversations/${ID}/forks`],
    ['PATCH', `/conversations/${ID}/forks/${ID}`],
    ['PUT', `/conversations/${ID}/forks/${ID}/tip`],
    ['DELETE', `/conversations/${ID}/forks/${ID}`],
  ];

  it.each(routes)('answers 401 to an anonymous %s %s', async (method, path) => {
    const res = await createApp().request(path, { method }, testEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });

  it('demands an Idempotency-Key on the create route', async () => {
    const { cookie } = await newUser();
    const res = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie,
      body: createBody(crypto.randomUUID()),
      idempotencyKey: null,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED });
  });
});

describe('conversations routes: create', () => {
  it('creates a conversation and answers the serialized record', async () => {
    const owner = await newUser();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const res = await send('POST', '/conversations', owner.cookie, createBody(id));
    expect(res.status).toBe(200);
    const body: ConversationBody = await res.json();
    expect(body.created).toBe(true);
    expect(body.conversation.id).toBe(id);
    expect(body.conversation.title).toBe(B64);
    expect(body.conversation.currentEpoch).toBe(1);
  });

  it('bootstraps epoch 1 with the owner wrap and membership atomically', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const epochRows = await db.select().from(epochs).where(eq(epochs.conversationId, id));
    expect(epochRows).toHaveLength(1);
    expect(epochRows[0]?.epochNumber).toBe(1);
    expect(epochRows[0]?.previousEpochId).toBeNull();
    const epochId = epochRows[0]?.id;
    if (epochId === undefined) throw new Error('epoch missing');
    const wraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epochId));
    expect(wraps).toHaveLength(1);
    expect(toBase64(new Uint8Array(wraps[0]?.memberPublicKey ?? []))).toBe(
      toBase64(owner.publicKey)
    );
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    expect(memberRows).toHaveLength(1);
    expect(memberRows[0]?.privilege).toBe('owner');
    expect(memberRows[0]?.acceptedAt).not.toBeNull();
  });

  it('replays the stored response for a retried Idempotency-Key without duplicating rows', async () => {
    const owner = await newUser();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const key = crypto.randomUUID();
    const first = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(id),
      idempotencyKey: key,
    });
    const second = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(id),
      idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    const epochRows = await db.select().from(epochs).where(eq(epochs.conversationId, id));
    expect(epochRows).toHaveLength(1);
  });

  it('converges a re-create of the same id under a fresh key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', '/conversations', owner.cookie, createBody(id));
    expect(res.status).toBe(200);
    const body: ConversationBody = await res.json();
    expect(body.created).toBe(false);
  });

  it("rejects a create reusing another user's conversation id", async () => {
    const owner = await newUser();
    const rival = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', '/conversations', rival.cookie, createBody(id));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
  });

  it('rejects a malformed body with the uniform validation answer', async () => {
    const { cookie } = await newUser();
    const res = await send('POST', '/conversations', cookie, { id: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});

describe('conversations routes: list', () => {
  it('lists the caller conversations with member state', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get('/conversations', owner.cookie);
    expect(res.status).toBe(200);
    const body: ListBody = await res.json();
    const row = body.conversations.find((c) => c.id === id);
    expect(row).toMatchObject({
      id,
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      invitedByUsername: null,
    });
    expect(body.nextCursor).toBeNull();
  });

  it('does not list conversations the caller is no longer a member of', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(eq(conversationMembers.conversationId, id));
    const res = await get('/conversations', owner.cookie);
    const body: ListBody = await res.json();
    expect(body.conversations.map((c) => c.id)).not.toContain(id);
  });

  it('pages with a cursor ordered by most recent update', async () => {
    const owner = await newUser();
    const ids = [
      await createConversation(owner),
      await createConversation(owner),
      await createConversation(owner),
    ];
    const first = await get('/conversations?limit=2', owner.cookie);
    const firstBody: ListBody = await first.json();
    expect(firstBody.conversations).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await get(
      `/conversations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      owner.cookie
    );
    const secondBody: ListBody = await second.json();
    const seen = [...firstBody.conversations, ...secondBody.conversations].map((c) => c.id);
    for (const id of ids) expect(seen).toContain(id);
  });

  it('answers an empty page for an undecodable cursor', async () => {
    const owner = await newUser();
    await createConversation(owner);
    const res = await get('/conversations?cursor=%%%garbage', owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [], nextCursor: null });
  });

  it('answers 503 when the database is unreachable', async () => {
    const { cookie } = await newUser();
    const res = await get('/conversations', cookie, {
      env: { ...testEnv, DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:9/hushbox' },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});

describe('conversations routes: get', () => {
  it('answers the conversation with the caller membership state', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}`, owner.cookie);
    expect(res.status).toBe(200);
    const body: ConversationBody = await res.json();
    expect(body.conversation.id).toBe(id);
    expect(body.membership).toMatchObject({
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
    });
    // A fresh, unforked conversation reports an empty branch set.
    expect(body.forks).toEqual([]);
  });

  it('hides an existing conversation from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers 404 for an absent conversation', async () => {
    const { cookie } = await newUser();
    const res = await get(`/conversations/${crypto.randomUUID()}`, cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: websocket upgrade', () => {
  it('proxies the upgrade to the DO for an active member', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie);
    // The port double answers a 200 stand-in for the DO's real 101 (undici
    // cannot construct a sub-200 Response); the route forwards it untouched.
    expect(res.status).toBe(200);
  });

  it('refuses a non-member with 403 before proxying', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, outsider.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('rejects an unauthenticated upgrade with 401', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/websocket`, '');
    expect(res.status).toBe(401);
  });

  it('answers 503 when the DO upgrade fails at the transport', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const manifest = createConversationsManifest({
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => ({
        ...recordingRealtime([]),
        upgrade: () => errAsync(unavailableError('room upgrade transport failed')),
      }),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await get(`/conversations/${id}/websocket`, owner.cookie, { app });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});

describe('conversations routes: delete', () => {
  it('hard-deletes an owned conversation with its epoch chain', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('DELETE', `/conversations/${id}`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toHaveLength(0);
    expect(await db.select().from(epochs).where(eq(epochs.conversationId, id))).toHaveLength(0);
  });

  it('forbids a non-owner member from deleting', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await db.insert(conversationMembers).values({
      conversationId: id,
      userId: member.userId,
      privilege: 'admin',
      visibleFromEpoch: 1,
    });
    const res = await send('DELETE', `/conversations/${id}`, member.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('hides the delete surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('DELETE', `/conversations/${id}`, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('answers 404 for an already-deleted conversation under a fresh key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await send('DELETE', `/conversations/${id}`, owner.cookie);
    const res = await send('DELETE', `/conversations/${id}`, owner.cookie);
    expect(res.status).toBe(404);
  });

  it('evicts every member: cache entries deleted and sockets closed', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await db.insert(conversationMembers).values({
      conversationId: id,
      userId: member.userId,
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    const cache = createRedisMembershipCache(redis);
    await cache.set(id, owner.userId, 'member', 30);
    await cache.set(id, member.userId, 'member', 30);

    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'DELETE',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    expect(evicted).toEqual(
      expect.arrayContaining([
        { conversationId: id, principalId: owner.userId },
        { conversationId: id, principalId: member.userId },
      ])
    );
    expect(await cache.get(id, owner.userId)).toBeNull();
    expect(await cache.get(id, member.userId)).toBeNull();
  });
});

function randomB64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

function rotationFor(expectedEpoch: number, memberKeys: Uint8Array[]): Record<string, unknown> {
  return {
    expectedEpoch,
    epochPublicKey: randomB64(),
    confirmationHash: randomB64(),
    chainLink: randomB64(),
    memberWraps: memberKeys.map((key) => ({ memberPublicKey: toBase64(key), wrap: randomB64() })),
    encryptedTitle: B64,
  };
}

async function addFullHistory(
  owner: TestUser,
  conversationId: string,
  target: TestUser,
  privilege = 'write'
): Promise<string> {
  const res = await send('POST', `/conversations/${conversationId}/members`, owner.cookie, {
    userId: target.userId,
    privilege,
    giveFullHistory: true,
    wrap: randomB64(),
    expectedEpoch: 1,
  });
  if (res.status !== 200) throw new Error(`member add failed: ${String(res.status)}`);
  const body: MemberBody = await res.json();
  return body.member.id;
}

async function epochRows(conversationId: string): Promise<(typeof epochs.$inferSelect)[]> {
  return db
    .select()
    .from(epochs)
    .where(eq(epochs.conversationId, conversationId))
    .orderBy(epochs.epochNumber);
}

describe('conversations routes: members list', () => {
  it('lists active members with usernames for any member', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await get(`/conversations/${id}/members`, member.cookie);
    expect(res.status).toBe(200);
    const body: { members: { userId: string | null }[] } = await res.json();
    expect(body.members).toHaveLength(2);
    expect(body.members.map((m) => m.userId)).toEqual(
      expect.arrayContaining([owner.userId, member.userId])
    );
  });

  it('hides the member list from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/members`, outsider.cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: add member (full history)', () => {
  it('adds the member with visibility from the first epoch and a current-epoch wrap', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(200);
    const body: MemberBody = await res.json();
    expect(body.member).toMatchObject({
      userId: target.userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      accepted: false,
    });
    expect(body.newEpochNumber).toBeNull();

    const allEpochs = await epochRows(id);
    expect(allEpochs).toHaveLength(1);
    const epochId = allEpochs[0]?.id;
    if (epochId === undefined) throw new Error('epoch missing');
    const wraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epochId));
    expect(wraps).toHaveLength(2);
  });

  it('rejects a wrap built for a stale epoch without persisting anything', async () => {
    const owner = await newUser();
    const member = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    // Rotate to epoch 2 by adding `member` without history.
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: member.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, member.publicKey]),
    });
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 2 },
    });
    const targetRows = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, target.userId)
        )
      );
    expect(targetRows).toHaveLength(0);
  });

  it('answers already-member for an active member', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, target);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ALREADY_MEMBER });
  });

  it('answers 404 for an unknown target user', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: crypto.randomUUID(),
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(404);
  });

  it('enforces the member limit with the typed error', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const fillers = Array.from({ length: 99 }, (_, index) => ({
      email: `${crypto.randomUUID()}@fill.test`,
      username: `zzfill${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}${String(index)}`,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    }));
    const fillerIds = await db.insert(users).values(fillers).returning({ id: users.id });
    createdUserIds.push(...fillerIds.map((row) => row.id));
    await db.insert(conversationMembers).values(
      fillerIds.map((row) => ({
        conversationId: id,
        userId: row.id,
        privilege: 'read' as const,
        visibleFromEpoch: 1,
      }))
    );
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.MEMBER_LIMIT_REACHED,
      details: { limit: 100 },
    });
  });

  it('forbids a write-privilege member from adding members', async () => {
    const owner = await newUser();
    const member = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member, 'write');
    const res = await send('POST', `/conversations/${id}/members`, member.cookie, {
      userId: target.userId,
      privilege: 'read',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(403);
  });

  it('forbids granting a privilege not strictly below the caller', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, admin, 'admin');
    const res = await send('POST', `/conversations/${id}/members`, admin.cookie, {
      userId: target.userId,
      privilege: 'admin',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(403);
  });

  it('hides the surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, outsider.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: true,
      wrap: randomB64(),
      expectedEpoch: 1,
    });
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: add member (rotation)', () => {
  it('rotates atomically: new epoch chained, wraps replaced, visibility from the new epoch', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
    });
    expect(res.status).toBe(200);
    const body: MemberBody = await res.json();
    expect(body.newEpochNumber).toBe(2);
    expect(body.member).toMatchObject({ visibleFromEpoch: 2 });

    const allEpochs = await epochRows(id);
    expect(allEpochs.map((e) => e.epochNumber)).toEqual([1, 2]);
    expect(allEpochs[1]?.previousEpochId).toBe(allEpochs[0]?.id);
    const conversationRow = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(conversationRow[0]?.currentEpoch).toBe(2);

    const epoch1Id = allEpochs[0]?.id;
    const epoch2Id = allEpochs[1]?.id;
    if (epoch1Id === undefined || epoch2Id === undefined) throw new Error('epochs missing');
    expect(
      await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch1Id))
    ).toHaveLength(0);
    const newWraps = await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id));
    expect(newWraps).toHaveLength(2);
    const byKey = new Map(newWraps.map((w) => [toBase64(new Uint8Array(w.memberPublicKey)), w]));
    expect(byKey.get(toBase64(owner.publicKey))?.visibleFromEpoch).toBe(1);
    expect(byKey.get(toBase64(target.publicKey))?.visibleFromEpoch).toBe(2);
  });

  it('rejects a wrap set that does not match the active members exactly', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      // Missing the new member's wrap.
      rotation: rotationFor(1, [owner.publicKey]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.WRAP_SET_MISMATCH });
    expect(await epochRows(id)).toHaveLength(1);
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    expect(memberRows).toHaveLength(1);
  });

  it('rejects a stale rotation with the authoritative epoch', async () => {
    const owner = await newUser();
    const m1 = await newUser();
    const m2 = await newUser();
    const id = await createConversation(owner);
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: m1.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, m1.publicKey]),
    });
    const res = await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: m2.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, m1.publicKey, m2.publicKey]),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 2 },
    });
  });
});

describe('conversations routes: rotation safety', () => {
  it('rolls back the whole rotation when a mid-rotation write fails', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);

    const manifest = createConversationsManifest({
      stores: (db_) => {
        const stores = createConversationsStores(db_);
        return {
          ...stores,
          epochs: {
            ...stores.epochs,
            // The injected seam failure: every new-epoch wrap write fails.
            insertWraps: () => errAsync(unavailableError('injected mid-rotation failure')),
          },
        };
      },
      revoker: createMembershipRevoker,
      realtime: () => recordingRealtime([]),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
      app,
    });
    expect(res.status).toBe(503);

    const conversationRow = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(conversationRow[0]?.currentEpoch).toBe(1);
    expect(await epochRows(id)).toHaveLength(1);
    const memberRows = await db
      .select()
      .from(conversationMembers)
      .where(and(eq(conversationMembers.conversationId, id), isNull(conversationMembers.leftAt)));
    expect(memberRows).toHaveLength(2);
  });

  it('serializes concurrent rotations: exactly one wins, the loser sees stale-epoch', async () => {
    const owner = await newUser();
    const m1 = await newUser();
    const m2 = await newUser();
    const id = await createConversation(owner);
    const m1Id = await addFullHistory(owner, id, m1);
    const m2Id = await addFullHistory(owner, id, m2);

    const [r1, r2] = await Promise.all([
      send('POST', `/conversations/${id}/members/${m1Id}/remove`, owner.cookie, {
        rotation: rotationFor(1, [owner.publicKey, m2.publicKey]),
      }),
      send('POST', `/conversations/${id}/members/${m2Id}/remove`, owner.cookie, {
        rotation: rotationFor(1, [owner.publicKey, m1.publicKey]),
      }),
    ]);
    const statuses = [r1.status, r2.status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const conversationRow = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(conversationRow[0]?.currentEpoch).toBe(2);
    const allEpochs = await epochRows(id);
    expect(allEpochs.map((e) => e.epochNumber)).toEqual([1, 2]);
    const epoch2Id = allEpochs[1]?.id;
    if (epoch2Id === undefined) throw new Error('epoch 2 missing');
    expect(
      await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id))
    ).toHaveLength(2);
  });

  it('enforces epoch-number uniqueness per conversation at the database', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await expect(
      db.insert(epochs).values({
        conversationId: id,
        epochNumber: 1,
        epochPublicKey: BYTES,
        confirmationHash: BYTES,
      })
    ).rejects.toThrow();
  });
});

describe('conversations routes: remove member', () => {
  async function removalSetup(): Promise<{
    owner: TestUser;
    member: TestUser;
    id: string;
    memberId: string;
  }> {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    return { owner, member, id, memberId };
  }

  it('marks the member left and rotates the epoch', async () => {
    const { owner, member, id, memberId } = await removalSetup();
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      {
        rotation: rotationFor(1, [owner.publicKey]),
      }
    );
    expect(res.status).toBe(200);
    const body: { removed: boolean; newEpochNumber: number } = await res.json();
    expect(body.removed).toBe(true);
    expect(body.newEpochNumber).toBe(2);
    const rows = await db
      .select()
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, member.userId)
        )
      );
    expect(rows[0]?.leftAt).not.toBeNull();
  });

  it('evicts the removed member: cache deleted, socket eviction invoked, reads revoked', async () => {
    const { owner, member, id, memberId } = await removalSetup();
    const cache = createRedisMembershipCache(redis);
    await cache.set(id, member.userId, 'member', 30);
    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    expect(evicted).toEqual([{ conversationId: id, principalId: member.userId }]);
    expect(await cache.get(id, member.userId)).toBeNull();
    const read = await get(`/conversations/${id}`, member.cookie);
    expect(read.status).toBe(404);
  });

  it('refuses removing yourself', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const id = await createConversation(owner);
    const adminId = await addFullHistory(owner, id, admin, 'admin');
    const res = await send('POST', `/conversations/${id}/members/${adminId}/remove`, admin.cookie, {
      rotation: rotationFor(1, [owner.publicKey]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CANNOT_REMOVE_SELF });
  });

  it('refuses removing the owner', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, admin, 'admin');
    const ownerRows = await db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, owner.userId)
        )
      );
    const ownerMemberId = ownerRows[0]?.id;
    if (ownerMemberId === undefined) throw new Error('owner member missing');
    const res = await send(
      'POST',
      `/conversations/${id}/members/${ownerMemberId}/remove`,
      admin.cookie,
      { rotation: rotationFor(1, [admin.publicKey]) }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CANNOT_REMOVE_OWNER });
  });

  it('refuses a removal without a strictly higher privilege', async () => {
    const owner = await newUser();
    const adminA = await newUser();
    const adminB = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminA, 'admin');
    const bId = await addFullHistory(owner, id, adminB, 'admin');
    const res = await send('POST', `/conversations/${id}/members/${bId}/remove`, adminA.cookie, {
      rotation: rotationFor(1, [owner.publicKey, adminA.publicKey]),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('forbids a write member from removing anyone', async () => {
    const { member, id } = await removalSetup();
    const writer = member;
    const ownerRows = await db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    const someId = ownerRows[0]?.id;
    if (someId === undefined) throw new Error('member missing');
    const res = await send('POST', `/conversations/${id}/members/${someId}/remove`, writer.cookie, {
      rotation: rotationFor(1, [writer.publicKey]),
    });
    expect(res.status).toBe(403);
  });

  it('answers 404 for an unknown member id', async () => {
    const { owner, id } = await removalSetup();
    const res = await send(
      'POST',
      `/conversations/${id}/members/${crypto.randomUUID()}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) }
    );
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: leave', () => {
  it('lets a member leave with a rotation and evicts them', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/leave`,
      cookie: member.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    const body: { left: boolean; newEpochNumber: number } = await res.json();
    expect(body.left).toBe(true);
    expect(body.newEpochNumber).toBe(2);
    expect(evicted).toEqual([{ conversationId: id, principalId: member.userId }]);
    const list = await get('/conversations', member.cookie);
    const listBody: ListBody = await list.json();
    expect(listBody.conversations.map((c) => c.id)).not.toContain(id);
  });

  it('requires a rotation for a non-owner leave', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('POST', `/conversations/${id}/leave`, member.cookie, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.ROTATION_REQUIRED });
  });

  it('deletes the conversation when the owner leaves', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const evicted: EvictedCall[] = [];
    const res = await dispatch({
      method: 'POST',
      path: `/conversations/${id}/leave`,
      cookie: owner.cookie,
      body: {},
      app: createApp(evicted),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toHaveLength(0);
    expect(evicted.map((e) => e.principalId)).toEqual(
      expect.arrayContaining([owner.userId, member.userId])
    );
  });

  it('answers 404 for a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/leave`, outsider.cookie, {});
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: mute and pin', () => {
  it('sets only the caller membership flag', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('PATCH', `/conversations/${id}/membership/mute`, member.cookie, {
      muted: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ muted: true });
    const rows = await db
      .select({ userId: conversationMembers.userId, muted: conversationMembers.muted })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, id));
    expect(rows.find((r) => r.userId === member.userId)?.muted).toBe(true);
    expect(rows.find((r) => r.userId === owner.userId)?.muted).toBe(false);
  });

  it('pins for the caller and reports it in the list', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/pin`, owner.cookie, {
      pinned: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pinned: true });
    const list = await get('/conversations', owner.cookie);
    const body: ListBody = await list.json();
    expect(body.conversations.find((c) => c.id === id)?.pinned).toBe(true);
  });

  it('answers 404 to a non-member flag write', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/mute`, outsider.cookie, {
      muted: true,
    });
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: keychain', () => {
  it('answers the full chain for a founding member after a rotation', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
    });
    const res = await get(`/conversations/${id}/keychain`, owner.cookie);
    expect(res.status).toBe(200);
    const body: KeychainBody = await res.json();
    expect(body.currentEpoch).toBe(2);
    expect(body.wraps.map((w) => w.epochNumber)).toEqual([2]);
    expect(body.chainLinks.map((l) => l.epochNumber)).toEqual([2]);
  });

  it('filters chain links below a late joiner visibility floor', async () => {
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: target.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
    });
    const res = await get(`/conversations/${id}/keychain`, target.cookie);
    const body: KeychainBody = await res.json();
    expect(body.wraps.map((w) => w.epochNumber)).toEqual([2]);
    expect(body.chainLinks).toEqual([]);
  });

  it('hides the keychain from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/keychain`, outsider.cookie);
    expect(res.status).toBe(404);
  });
});

async function seedMessage(conversationId: string, sequenceNumber: number): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('message seed failed');
  return id;
}

async function seedChildMessage(
  conversationId: string,
  sequenceNumber: number,
  parentMessageId: string | null
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber,
      parentMessageId,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('child message seed failed');
  return id;
}

async function seedForkRow(
  conversationId: string,
  name: string,
  tipMessageId: string | null
): Promise<string> {
  const rows = await db
    .insert(conversationForks)
    .values({ conversationId, name, tipMessageId })
    .returning({ id: conversationForks.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('fork seed failed');
  return id;
}

async function messageIds(conversationId: string): Promise<string[]> {
  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  return rows.map((row) => row.id).toSorted((a, b) => a.localeCompare(b));
}

async function forkTipOf(forkId: string): Promise<string | null> {
  const rows = await db
    .select({ tip: conversationForks.tipMessageId })
    .from(conversationForks)
    .where(eq(conversationForks.id, forkId));
  return rows[0]?.tip ?? null;
}

interface KeychainBody {
  currentEpoch: number;
  wraps: { epochNumber: number }[];
  chainLinks: { epochNumber: number }[];
}

interface ForksBody {
  forks: ForkView[];
  isNew?: boolean;
}

interface ForkView {
  id: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

async function createForkVia(
  owner: TestUser,
  conversationId: string,
  fromMessageId: string,
  name?: string
): Promise<string> {
  const forkId = crypto.randomUUID();
  const res = await send('POST', `/conversations/${conversationId}/forks`, owner.cookie, {
    id: forkId,
    fromMessageId,
    ...(name === undefined ? {} : { name }),
  });
  if (res.status !== 200) throw new Error(`fork create failed: ${String(res.status)}`);
  return forkId;
}

describe('conversations routes: forks list', () => {
  it('answers an empty fork list for a linear conversation', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/forks`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forks: [] });
  });

  it('hides the fork list from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/forks`, outsider.cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: fork delete orphan cleanup', () => {
  it('deletes only the deleted branch, preserving shared ancestors and surviving tips', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    // m0 → m1, then Main (m2), F1 (f1a→f1b), F2 (f2a→f2b) all branch off m1.
    const m0 = await seedChildMessage(id, 1, null);
    const m1 = await seedChildMessage(id, 2, m0);
    const m2 = await seedChildMessage(id, 3, m1);
    const f1a = await seedChildMessage(id, 4, m1);
    const f1b = await seedChildMessage(id, 5, f1a);
    const f2a = await seedChildMessage(id, 6, m1);
    const f2b = await seedChildMessage(id, 7, f2a);
    await seedForkRow(id, 'Main', m2);
    const f1 = await seedForkRow(id, 'F1', f1b);
    const f2 = await seedForkRow(id, 'F2', f2b);

    const res = await dispatch({
      method: 'DELETE',
      path: `/conversations/${id}/forks/${f2}`,
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);

    // Only F2's exclusive branch (f2a, f2b) is gone; the shared ancestors and
    // both surviving branches remain.
    expect(await messageIds(id)).toEqual(
      [m0, m1, m2, f1a, f1b].toSorted((a, b) => a.localeCompare(b))
    );
    // The surviving fork tips were never nulled by the ON DELETE SET NULL cascade.
    expect(await forkTipOf(f1)).toBe(f1b);
  });
});

describe('conversations routes: fork events', () => {
  it('broadcasts fork:created when a new branch is created', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = crypto.randomUUID();
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/forks`,
      cookie: owner.cookie,
      body: { id: forkId, fromMessageId: m1, name: 'Alt take' },
    });
    expect(res.status).toBe(200);
    const created = broadcasts.filter((b) => b.event.type === 'fork:created');
    expect(created).toHaveLength(1);
    expect(created[0]?.event).toMatchObject({
      forkId,
      conversationId: id,
      name: 'Alt take',
      tipMessageId: m1,
    });
  });

  it('broadcasts fork:renamed when a branch is renamed', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Original');
    const res = await dispatch({
      app,
      method: 'PATCH',
      path: `/conversations/${id}/forks/${forkId}`,
      cookie: owner.cookie,
      body: { name: 'Renamed' },
    });
    expect(res.status).toBe(200);
    const renamed = broadcasts.filter((b) => b.event.type === 'fork:renamed');
    expect(renamed).toHaveLength(1);
    expect(renamed[0]?.event).toMatchObject({ forkId, conversationId: id, name: 'Renamed' });
  });

  it('broadcasts fork:deleted when a branch is deleted', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    await createForkVia(owner, id, m1, 'First');
    const second = await createForkVia(owner, id, m2, 'Second');
    const res = await dispatch({
      app,
      method: 'DELETE',
      path: `/conversations/${id}/forks/${second}`,
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const deleted = broadcasts.filter((b) => b.event.type === 'fork:deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.event).toMatchObject({ forkId: second, conversationId: id });
  });
});

describe('conversations routes: forks create', () => {
  it('creates the Main fork at the latest message alongside the first branch', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = crypto.randomUUID();
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: forkId,
      fromMessageId: m1,
      name: 'Alt take',
    });
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.isNew).toBe(true);
    expect(body.forks).toHaveLength(2);
    expect(body.forks[0]).toMatchObject({ name: 'Main', tipMessageId: m2 });
    expect(body.forks[1]).toMatchObject({ id: forkId, name: 'Alt take', tipMessageId: m1 });
  });

  it('auto-names a fork when no name is given', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
    });
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.forks.map((f) => f.name)).toEqual(['Main', 'Fork 1']);
  });

  it('converges a re-create of the same fork id without duplicating rows', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: forkId,
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.isNew).toBe(false);
    expect(body.forks).toHaveLength(2);
  });

  it('rejects a duplicate fork name without persisting anything', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    await createForkVia(owner, id, m1, 'Alt');
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORK_NAME_TAKEN });
    const rows = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, id));
    expect(rows).toHaveLength(2);
  });

  it('rejects a first branch named Main without persisting anything', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Main',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORK_NAME_TAKEN });
    const rows = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, id));
    expect(rows).toHaveLength(0);
  });

  it('enforces the fork limit with the typed error', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    await db.insert(conversationForks).values(
      Array.from({ length: 5 }, (_, index) => ({
        conversationId: id,
        name: `Seeded ${String(index)}`,
        tipMessageId: m1,
      }))
    );
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'One too many',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.FORK_LIMIT_REACHED,
      details: { limit: 5 },
    });
  });

  it('answers 404 for a branch-from message outside the conversation', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const other = await createConversation(owner);
    const foreign = await seedMessage(other, 1);
    const res = await send('POST', `/conversations/${id}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: foreign,
      name: 'Alt',
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('forbids a read-privilege member from creating a fork', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, reader.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(403);
  });

  it('hides the surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send('POST', `/conversations/${id}/forks`, outsider.cookie, {
      id: crypto.randomUUID(),
      fromMessageId: m1,
      name: 'Alt',
    });
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: forks rename', () => {
  it('renames a fork and answers the updated record', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PATCH', `/conversations/${id}/forks/${forkId}`, owner.cookie, {
      name: 'Renamed',
    });
    expect(res.status).toBe(200);
    const body: { fork: ForkView } = await res.json();
    expect(body.fork).toMatchObject({ id: forkId, name: 'Renamed' });
  });

  it('rejects a rename onto a taken name', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PATCH', `/conversations/${id}/forks/${forkId}`, owner.cookie, {
      name: 'Main',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORK_NAME_TAKEN });
  });

  it('answers 404 for an unknown fork', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send(
      'PATCH',
      `/conversations/${id}/forks/${crypto.randomUUID()}`,
      owner.cookie,
      { name: 'Renamed' }
    );
    expect(res.status).toBe(404);
  });

  it('forbids a read-privilege member from renaming', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PATCH', `/conversations/${id}/forks/${forkId}`, reader.cookie, {
      name: 'Renamed',
    });
    expect(res.status).toBe(403);
  });
});

describe('conversations routes: fork tip', () => {
  it('moves the tip when the expected state holds', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
      tipMessageId: m2,
      expectedTipMessageId: m1,
    });
    expect(res.status).toBe(200);
    const body: { fork: ForkView } = await res.json();
    expect(body.fork).toMatchObject({ id: forkId, tipMessageId: m2 });
  });

  it('rejects a stale expected tip with the authoritative tip', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
      tipMessageId: m2,
      expectedTipMessageId: m2,
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.FORK_TIP_CONFLICT,
      details: { currentTipMessageId: m1 },
    });
  });

  it('serializes concurrent tip updates: exactly one wins', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const m3 = await seedMessage(id, 3);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const [r1, r2] = await Promise.all([
      send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
        tipMessageId: m2,
        expectedTipMessageId: m1,
      }),
      send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
        tipMessageId: m3,
        expectedTipMessageId: m1,
      }),
    ]);
    const statuses = [r1.status, r2.status].toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);
    const rows = await db
      .select({ tipMessageId: conversationForks.tipMessageId })
      .from(conversationForks)
      .where(eq(conversationForks.id, forkId));
    const winner = r1.status === 200 ? r1 : r2;
    const winnerBody: { fork: ForkView } = await winner.json();
    expect(rows[0]?.tipMessageId).toBe(winnerBody.fork.tipMessageId);
    const loser = r1.status === 200 ? r2 : r1;
    expect(await loser.json()).toEqual({
      code: ERROR_CODES.FORK_TIP_CONFLICT,
      details: { currentTipMessageId: winnerBody.fork.tipMessageId },
    });
  });

  it('answers 404 for a tip message outside the conversation', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const other = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const foreign = await seedMessage(other, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, owner.cookie, {
      tipMessageId: foreign,
      expectedTipMessageId: m1,
    });
    expect(res.status).toBe(404);
  });

  it('answers 404 for an unknown fork', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const res = await send(
      'PUT',
      `/conversations/${id}/forks/${crypto.randomUUID()}/tip`,
      owner.cookie,
      { tipMessageId: m1, expectedTipMessageId: null }
    );
    expect(res.status).toBe(404);
  });

  it('forbids a read-privilege member from moving a tip', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const m2 = await seedMessage(id, 2);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('PUT', `/conversations/${id}/forks/${forkId}/tip`, reader.cookie, {
      tipMessageId: m2,
      expectedTipMessageId: m1,
    });
    expect(res.status).toBe(403);
  });
});

describe('conversations routes: forks delete', () => {
  it('deletes a fork and answers the remaining forks', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const alt = await createForkVia(owner, id, m1, 'Alt');
    const extra = await createForkVia(owner, id, m1, 'Extra');
    const res = await send('DELETE', `/conversations/${id}/forks/${extra}`, owner.cookie);
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.forks.map((f) => f.id)).toContain(alt);
    expect(body.forks.map((f) => f.id)).not.toContain(extra);
    expect(body.forks).toHaveLength(2);
  });

  it('reverts to linear when only one fork would remain', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const alt = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('DELETE', `/conversations/${id}/forks/${alt}`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forks: [] });
    const rows = await db
      .select()
      .from(conversationForks)
      .where(eq(conversationForks.conversationId, id));
    expect(rows).toHaveLength(0);
  });

  it('converges when the fork is already gone', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    await createForkVia(owner, id, m1, 'Alt');
    await createForkVia(owner, id, m1, 'Extra');
    const res = await send(
      'DELETE',
      `/conversations/${id}/forks/${crypto.randomUUID()}`,
      owner.cookie
    );
    expect(res.status).toBe(200);
    const body: ForksBody = await res.json();
    expect(body.forks).toHaveLength(3);
  });

  it('forbids a read-privilege member from deleting', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, reader, 'read');
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('DELETE', `/conversations/${id}/forks/${forkId}`, reader.cookie);
    expect(res.status).toBe(403);
  });

  it('hides the surface from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const m1 = await seedMessage(id, 1);
    const forkId = await createForkVia(owner, id, m1, 'Alt');
    const res = await send('DELETE', `/conversations/${id}/forks/${forkId}`, outsider.cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: idempotency-key body binding', () => {
  it('rejects a reused key with a different body', async () => {
    const owner = await newUser();
    const key = crypto.randomUUID();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const first = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(id),
      idempotencyKey: key,
    });
    expect(first.status).toBe(200);
    const second = await dispatch({
      method: 'POST',
      path: '/conversations',
      cookie: owner.cookie,
      body: createBody(crypto.randomUUID()),
      idempotencyKey: key,
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ code: ERROR_CODES.IDEMPOTENCY_BODY_MISMATCH });
  });
});

describe('conversations routes: unknown conversation answers not-found', () => {
  const UNKNOWN = '0197a000-0000-7000-8000-00000000dead';
  const MEMBER_BODY = {
    userId: '0197a000-0000-7000-8000-00000000beef',
    privilege: 'write',
    giveFullHistory: true,
    wrap: B64,
    expectedEpoch: 1,
  };
  const cases: [string, string, unknown][] = [
    ['GET', `/conversations/${UNKNOWN}`, undefined],
    ['DELETE', `/conversations/${UNKNOWN}`, undefined],
    ['GET', `/conversations/${UNKNOWN}/members`, undefined],
    ['POST', `/conversations/${UNKNOWN}/members`, MEMBER_BODY],
    [
      'POST',
      `/conversations/${UNKNOWN}/members/${UNKNOWN}/remove`,
      { rotation: rotationFor(1, [crypto.getRandomValues(new Uint8Array(32))]) },
    ],
    ['POST', `/conversations/${UNKNOWN}/leave`, {}],
    ['GET', `/conversations/${UNKNOWN}/keychain`, undefined],
    ['GET', `/conversations/${UNKNOWN}/forks`, undefined],
    [
      'POST',
      `/conversations/${UNKNOWN}/forks`,
      { id: crypto.randomUUID(), fromMessageId: crypto.randomUUID(), name: 'Alt' },
    ],
    ['PATCH', `/conversations/${UNKNOWN}/forks/${UNKNOWN}`, { name: 'Renamed' }],
    [
      'PUT',
      `/conversations/${UNKNOWN}/forks/${UNKNOWN}/tip`,
      { tipMessageId: crypto.randomUUID(), expectedTipMessageId: null },
    ],
    ['DELETE', `/conversations/${UNKNOWN}/forks/${UNKNOWN}`, undefined],
  ];

  it.each(cases)('answers 404 to %s %s', async (method, path, body) => {
    const user = await newUser();
    const res = await send(method, path, user.cookie, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: store unavailability answers 503 everywhere', () => {
  function failingApp(): Hono<AppEnv> {
    const fail = (): ResultAsync<never, DomainError> =>
      errAsync(unavailableError('injected store failure'));
    const failingGroup = new Proxy({}, { get: () => fail });
    const manifest = createConversationsManifest({
      stores: () =>
        ({
          conversations: failingGroup,
          members: failingGroup,
          epochs: failingGroup,
          users: failingGroup,
          messages: failingGroup,
          forks: failingGroup,
        }) as unknown as ConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => recordingRealtime([]),
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    return app;
  }

  const ID = '0197a000-0000-7000-8000-000000000001';
  const cases: [string, string, unknown][] = [
    ['POST', '/conversations', createBody('0197a000-0000-7000-8000-000000000002')],
    ['GET', '/conversations', undefined],
    ['GET', `/conversations/${ID}`, undefined],
    ['GET', `/conversations/${ID}/websocket`, undefined],
    ['DELETE', `/conversations/${ID}`, undefined],
    ['GET', `/conversations/${ID}/members`, undefined],
    [
      'POST',
      `/conversations/${ID}/members`,
      { userId: ID, privilege: 'write', giveFullHistory: true, wrap: B64, expectedEpoch: 1 },
    ],
    [
      'POST',
      `/conversations/${ID}/members/${ID}/remove`,
      { rotation: rotationFor(1, [crypto.getRandomValues(new Uint8Array(32))]) },
    ],
    ['POST', `/conversations/${ID}/leave`, {}],
    ['PATCH', `/conversations/${ID}/membership/mute`, { muted: true }],
    ['PATCH', `/conversations/${ID}/membership/pin`, { pinned: true }],
    ['GET', `/conversations/${ID}/keychain`, undefined],
    ['GET', `/conversations/${ID}/forks`, undefined],
    [
      'POST',
      `/conversations/${ID}/forks`,
      { id: crypto.randomUUID(), fromMessageId: ID, name: 'Alt' },
    ],
    ['PATCH', `/conversations/${ID}/forks/${ID}`, { name: 'Renamed' }],
    [
      'PUT',
      `/conversations/${ID}/forks/${ID}/tip`,
      { tipMessageId: ID, expectedTipMessageId: null },
    ],
    ['DELETE', `/conversations/${ID}/forks/${ID}`, undefined],
  ];

  it.each(cases)('answers 503 to %s %s', async (method, path, body) => {
    const user = await newUser();
    const res = await dispatch({ method, path, cookie: user.cookie, body, app: failingApp() });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAVAILABLE });
  });
});

describe('conversations routes: coverage of remaining refusal arms', () => {
  it('creates an untitled conversation', async () => {
    const owner = await newUser();
    const id = crypto.randomUUID();
    createdConversationIds.push(id);
    const body = createBody(id);
    delete body['title'];
    const res = await send('POST', '/conversations', owner.cookie, body);
    expect(res.status).toBe(200);
    const created: ConversationBody = await res.json();
    expect(created.conversation.title).toBe('');
  });

  it('answers an empty page for a well-formed cursor with the wrong shape', async () => {
    const owner = await newUser();
    await createConversation(owner);
    const cursor = encodeURIComponent(toBase64(new TextEncoder().encode('{"x":1}')));
    const res = await get(`/conversations?cursor=${cursor}`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversations: [], nextCursor: null });
  });

  it('hides the member list from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/members`, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('answers 404 to a non-member removing a member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      outsider.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) }
    );
    expect(res.status).toBe(404);
  });

  it('answers 404 to a non-member pin write', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/pin`, outsider.cookie, {
      pinned: true,
    });
    expect(res.status).toBe(404);
  });

  it('rejects a stale leave rotation with the authoritative epoch', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('POST', `/conversations/${id}/leave`, member.cookie, {
      rotation: rotationFor(2, [owner.publicKey]),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 1 },
    });
  });

  it('rejects a removal whose wrap set does not match the remaining members', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey, member.publicKey]) }
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.WRAP_SET_MISMATCH });
  });

  it('rejects a leave whose wrap set does not match the remaining members', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('POST', `/conversations/${id}/leave`, member.cookie, {
      rotation: rotationFor(1, [owner.publicKey, member.publicKey]),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.WRAP_SET_MISMATCH });
  });

  it('completes a delete even when socket eviction fails, logging the miss', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const failingRealtime: RealtimeBroadcast = {
      ...recordingRealtime([]),
      evict: () => errAsync(unavailableError('injected eviction failure')),
    };
    const manifest = createConversationsManifest({
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => failingRealtime,
      deleteForkMessages: (db) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(db, conversationId, ids),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await dispatch({
      method: 'DELETE',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      app,
    });
    expect(res.status).toBe(200);
    expect(await db.select().from(conversations).where(eq(conversations.id, id))).toHaveLength(0);
  });
});

// --- Shares & links ---------------------------------------------------------

let shareSeq = 1000;

function freshKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/** Seeds an active membership directly (the add-member rotation flow is exercised elsewhere). */
async function seedMember(
  conversationId: string,
  userId: string,
  privilege: 'read' | 'write' | 'admin'
): Promise<void> {
  await db.insert(conversationMembers).values({
    conversationId,
    userId,
    privilege,
    visibleFromEpoch: 1,
    acceptedAt: new Date(),
  });
}

/** A message with a share-suite-local sequence, avoiding collisions across tests. */
async function seedShareMessage(conversationId: string): Promise<string> {
  shareSeq += 1;
  return seedMessage(conversationId, shareSeq);
}

async function getPublic(linkId: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  return createApp().request(
    `/conversations/shared/${linkId}`,
    { method: 'GET', headers },
    testEnv
  );
}

interface LinkBody {
  created: boolean;
  link: {
    id: string;
    displayName: string | null;
    revokedAt: string | null;
    expiresAt: string | null;
  };
}

async function mintLink(
  actor: TestUser,
  conversationId: string,
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return send('POST', `/conversations/${conversationId}/links`, actor.cookie, {
    linkPublicKey: freshKey(),
    ...extra,
  });
}

async function mintLinkBody(
  actor: TestUser,
  conversationId: string,
  extra: Record<string, unknown> = {}
): Promise<LinkBody> {
  const res = await mintLink(actor, conversationId, extra);
  return res.json();
}

/**
 * Fires `fire()` while an uncommitted removal UPDATE holds the actor's
 * conversation_members row lock, then commits the removal. The share/link
 * writes take FOR SHARE on that row, so the request must block until the
 * commit and then observe the removal; an unlocked membership read would
 * instead answer from the pre-removal snapshot and let the write through.
 */
async function raceAgainstRemoval(
  conversationId: string,
  userId: string,
  fire: () => Promise<Response>
): Promise<Response> {
  const raced = await db.transaction(async (tx) => {
    await tx
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, userId)
        )
      );
    const pending = fire();
    const early = await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, 400);
      }),
    ]);
    // With the FOR SHARE lock held by the uncommitted removal above, the
    // guarded write cannot complete before this transaction commits — an
    // early response means the membership read ran unlocked.
    expect(early).toBeNull();
    return { pending };
  });
  return raced.pending;
}

describe('conversations routes: shared links create', () => {
  it('lets the owner mint a link and never echoes the public key', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const res = await mintLink(owner, conv, { displayName: 'My share' });
    expect(res.status).toBe(200);
    const body: LinkBody = await res.json();
    expect(body.created).toBe(true);
    expect(body.link.displayName).toBe('My share');
    expect(body.link.revokedAt).toBeNull();
    // The raw response must not carry link key material.
    expect(JSON.stringify(body)).not.toContain('linkPublicKey');
  });

  it('replays a retried Idempotency-Key without a duplicate row', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const key = crypto.randomUUID();
    const linkPublicKey = freshKey();
    const first = await dispatch({
      method: 'POST',
      path: `/conversations/${conv}/links`,
      cookie: owner.cookie,
      body: { linkPublicKey },
      idempotencyKey: key,
    });
    const second = await dispatch({
      method: 'POST',
      path: `/conversations/${conv}/links`,
      cookie: owner.cookie,
      body: { linkPublicKey },
      idempotencyKey: key,
    });
    expect(await second.json()).toEqual(await first.json());
    const rows = await db.select().from(sharedLinks).where(eq(sharedLinks.conversationId, conv));
    expect(rows).toHaveLength(1);
  });

  it('converges a fresh key reusing the same public key (created:false)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkPublicKey = freshKey();
    const first = await send('POST', `/conversations/${conv}/links`, owner.cookie, {
      linkPublicKey,
    });
    const firstBody: LinkBody = await first.json();
    const second = await send('POST', `/conversations/${conv}/links`, owner.cookie, {
      linkPublicKey,
    });
    const secondBody: LinkBody = await second.json();
    expect(secondBody.created).toBe(false);
    expect(secondBody.link.id).toBe(firstBody.link.id);
  });

  it('forbids a write-privilege member from minting links', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const res = await mintLink(writer, conv);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers not-found to a non-member minting a link', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const res = await mintLink(stranger, conv);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('refuses a mint racing a concurrent member removal instead of inserting', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, admin.userId, 'admin');
    const res = await raceAgainstRemoval(conv, admin.userId, () => mintLink(admin, conv));
    expect(res.status).toBe(404);
    const rows = await db.select().from(sharedLinks).where(eq(sharedLinks.conversationId, conv));
    expect(rows).toHaveLength(0);
  });
});

describe('conversations routes: shared links list', () => {
  it('lists links for an active read-privilege member', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, reader.userId, 'read');
    await mintLink(owner, conv);
    await mintLink(owner, conv);
    const res = await get(`/conversations/${conv}/links`, reader.cookie);
    expect(res.status).toBe(200);
    const body: { links: unknown[] } = await res.json();
    expect(body.links).toHaveLength(2);
  });

  it('answers not-found to a non-member listing links', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const res = await get(`/conversations/${conv}/links`, stranger.cookie);
    expect(res.status).toBe(404);
  });
});

describe('conversations routes: shared links revoke', () => {
  it('revokes a live link with an atomic conditional write', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await send(
      'POST',
      `/conversations/${conv}/links/${linkBody.link.id}/revoke`,
      owner.cookie
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    const rows = await db.select().from(sharedLinks).where(eq(sharedLinks.id, linkBody.link.id));
    expect(rows[0]?.revokedAt).not.toBeNull();
  });

  it('is an idempotent no-op when the link is already revoked', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const path = `/conversations/${conv}/links/${linkBody.link.id}/revoke`;
    await send('POST', path, owner.cookie);
    const again = await send('POST', path, owner.cookie);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ revoked: true });
  });

  it('answers not-found revoking an unknown link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const res = await send(
      'POST',
      `/conversations/${conv}/links/${crypto.randomUUID()}/revoke`,
      owner.cookie
    );
    expect(res.status).toBe(404);
  });

  it('forbids a write-privilege member from revoking', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await send(
      'POST',
      `/conversations/${conv}/links/${linkBody.link.id}/revoke`,
      writer.cookie
    );
    expect(res.status).toBe(403);
  });

  it('answers not-found to a non-member revoking a link', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await send(
      'POST',
      `/conversations/${conv}/links/${linkBody.link.id}/revoke`,
      stranger.cookie
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('revokes an already-expired link as a normal revoke (predicate ignores expiry)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const rows = await db
      .insert(sharedLinks)
      .values({
        conversationId: conv,
        linkPublicKey: crypto.getRandomValues(new Uint8Array(32)),
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: sharedLinks.id });
    const linkId = rows[0]?.id ?? '';
    const res = await send('POST', `/conversations/${conv}/links/${linkId}/revoke`, owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    const after = await db.select().from(sharedLinks).where(eq(sharedLinks.id, linkId));
    expect(after[0]?.revokedAt).not.toBeNull();
  });
});

describe('conversations routes: public share read', () => {
  it('reads shared content over the link with no authentication and leaks nothing else', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv);
    const linkBody: LinkBody = await mintLinkBody(owner, conv, { displayName: 'shared' });
    const shareRes = await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId,
      linkId: linkBody.link.id,
      wrappedContentKey: B64,
    });
    expect(shareRes.status).toBe(200);
    const res = await getPublic(linkBody.link.id);
    expect(res.status).toBe(200);
    const body: { displayName: string; sharedMessages: { messageId: string }[] } = await res.json();
    expect(Object.keys(body)).toEqual(['displayName', 'sharedMessages']);
    expect(body.displayName).toBe('shared');
    expect(body.sharedMessages).toHaveLength(1);
    expect(body.sharedMessages[0]?.messageId).toBe(messageId);
  });

  it('scopes each link to exactly the messages shared through it', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkA: LinkBody = await mintLinkBody(owner, conv);
    const linkB: LinkBody = await mintLinkBody(owner, conv);
    const messageA = await seedShareMessage(conv);
    const messageB = await seedShareMessage(conv);
    await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId: messageA,
      linkId: linkA.link.id,
      wrappedContentKey: B64,
    });
    await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId: messageB,
      linkId: linkB.link.id,
      wrappedContentKey: B64,
    });

    const resA = await getPublic(linkA.link.id);
    const readA: { sharedMessages: { messageId: string }[] } = await resA.json();
    const resB = await getPublic(linkB.link.id);
    const readB: { sharedMessages: { messageId: string }[] } = await resB.json();
    expect(readA.sharedMessages.map((m) => m.messageId)).toEqual([messageA]);
    expect(readB.sharedMessages.map((m) => m.messageId)).toEqual([messageB]);
  });

  it('never surfaces a share minted later into a different link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const firstLink: LinkBody = await mintLinkBody(owner, conv);
    const laterLink: LinkBody = await mintLinkBody(owner, conv);
    const messageId = await seedShareMessage(conv);
    await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId,
      linkId: laterLink.link.id,
      wrappedContentKey: B64,
    });

    const res = await getPublic(firstLink.link.id);
    expect(res.status).toBe(200);
    const body: { sharedMessages: unknown[] } = await res.json();
    expect(body.sharedMessages).toEqual([]);
  });

  it('answers not-found for an unknown link', async () => {
    const res = await getPublic(crypto.randomUUID());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers not-found for a revoked link (lazy enforcement)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    await send('POST', `/conversations/${conv}/links/${linkBody.link.id}/revoke`, owner.cookie);
    const res = await getPublic(linkBody.link.id);
    expect(res.status).toBe(404);
  });

  it('answers not-found for an expired link without any sweep job', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const rows = await db
      .insert(sharedLinks)
      .values({
        conversationId: conv,
        linkPublicKey: crypto.getRandomValues(new Uint8Array(32)),
        displayName: 'expired',
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: sharedLinks.id });
    const res = await getPublic(rows[0]?.id ?? '');
    expect(res.status).toBe(404);
  });

  it('reads a link whose expiry is still in the future', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const rows = await db
      .insert(sharedLinks)
      .values({
        conversationId: conv,
        linkPublicKey: crypto.getRandomValues(new Uint8Array(32)),
        displayName: 'live',
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning({ id: sharedLinks.id });
    const res = await getPublic(rows[0]?.id ?? '');
    expect(res.status).toBe(200);
  });

  it('asserts the public share endpoint has a rate-limit registry entry (enforcement lands at the edge)', () => {
    expect(publicShareReadRateLimit.rateLimitConfig.maxAttempts).toBe(30);
    expect(publicShareReadRateLimit.rateLimitConfig.windowSeconds).toBe(60);
    expect(publicShareReadRateLimit.buildKey('ip')).toContain('share:read:ip');
  });
});

describe('conversations routes: shared messages create + severing', () => {
  it('answers not-found when the message is not in the conversation', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId: crypto.randomUUID(),
      linkId: linkBody.link.id,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
  });

  it('answers not-found to a non-member sharing a message', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await send('POST', `/conversations/${conv}/shares`, stranger.cookie, {
      messageId,
      linkId: linkBody.link.id,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
  });

  it('answers not-found sharing into a nonexistent link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv);
    const res = await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId,
      linkId: crypto.randomUUID(),
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('answers not-found sharing into a revoked link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    await send('POST', `/conversations/${conv}/links/${linkBody.link.id}/revoke`, owner.cookie);
    const res = await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId,
      linkId: linkBody.link.id,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
  });

  it('answers not-found sharing into an expired link', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv);
    const rows = await db
      .insert(sharedLinks)
      .values({
        conversationId: conv,
        linkPublicKey: crypto.getRandomValues(new Uint8Array(32)),
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: sharedLinks.id });
    const res = await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId,
      linkId: rows[0]?.id ?? '',
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
  });

  it('answers not-found sharing into another conversation’s link', async () => {
    const owner = await newUser();
    const convA = await createConversation(owner);
    const convB = await createConversation(owner);
    const messageId = await seedShareMessage(convA);
    const foreignLink: LinkBody = await mintLinkBody(owner, convB);
    const res = await send('POST', `/conversations/${convA}/shares`, owner.cookie, {
      messageId,
      linkId: foreignLink.link.id,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(404);
  });

  it('lets a read-privilege member share a message (membership, not privilege, is the deliberate gate)', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, reader.userId, 'read');
    const messageId = await seedShareMessage(conv);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await send('POST', `/conversations/${conv}/shares`, reader.cookie, {
      messageId,
      linkId: linkBody.link.id,
      wrappedContentKey: B64,
    });
    expect(res.status).toBe(200);
    const body: { shareId: string } = await res.json();
    expect(body.shareId).toBeTruthy();
  });

  it('refuses a share racing a concurrent member removal instead of inserting', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, writer.userId, 'write');
    const messageId = await seedShareMessage(conv);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const res = await raceAgainstRemoval(conv, writer.userId, () =>
      send('POST', `/conversations/${conv}/shares`, writer.cookie, {
        messageId,
        linkId: linkBody.link.id,
        wrappedContentKey: B64,
      })
    );
    expect(res.status).toBe(404);
    const rows = await db
      .select()
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, messageId));
    expect(rows).toHaveLength(0);
  });

  it('severs a shared message when its creator is deleted (FK cascade on createdBy)', async () => {
    const owner = await newUser();
    const creator = await newUser();
    const conv = await createConversation(owner);
    await seedMember(conv, creator.userId, 'write');
    const messageId = await seedShareMessage(conv);
    const linkBody: LinkBody = await mintLinkBody(owner, conv);
    const shareRes = await send('POST', `/conversations/${conv}/shares`, creator.cookie, {
      messageId,
      linkId: linkBody.link.id,
      wrappedContentKey: B64,
    });
    const { shareId }: { shareId: string } = await shareRes.json();
    const before = await db.select().from(sharedMessages).where(eq(sharedMessages.id, shareId));
    expect(before).toHaveLength(1);
    expect(before[0]?.createdBy).toBe(creator.userId);

    // Account deletion clears membership first; then the user row deletion
    // severs the share by FK cascade — the semantics this slice owns.
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conv),
          eq(conversationMembers.userId, creator.userId)
        )
      );
    await db.delete(users).where(eq(users.id, creator.userId));

    const after = await db.select().from(sharedMessages).where(eq(sharedMessages.id, shareId));
    expect(after).toHaveLength(0);
  });
});

async function seedMessageAtEpoch(
  conversationId: string,
  sequenceNumber: number,
  epochNumber: number
): Promise<string> {
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber,
      sequenceNumber,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('epoch message seed failed');
  return id;
}

async function seedTextContentItem(messageId: string, position: number): Promise<string> {
  const rows = await db
    .insert(contentItems)
    .values({ messageId, contentType: 'text', position, encryptedBlob: BYTES })
    .returning({ id: contentItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('content item seed failed');
  return id;
}

async function seedMediaContentItem(messageId: string, position: number): Promise<string> {
  const rows = await db
    .insert(contentItems)
    .values({
      messageId,
      contentType: 'image',
      position,
      storageKey: crypto.randomUUID(),
      mimeType: 'image/png',
      sizeBytes: 42,
    })
    .returning({ id: contentItems.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('media content item seed failed');
  return id;
}

interface MemberKeysBody {
  members: {
    memberId: string;
    userId: string | null;
    linkId: string | null;
    publicKey: string;
    privilege: string;
    visibleFromEpoch: number;
  }[];
}

describe('conversations routes: member public keys', () => {
  it('returns the active-member public-key set to any member ordered by join', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await get(`/conversations/${id}/member-keys`, member.cookie);
    expect(res.status).toBe(200);
    const body: MemberKeysBody = await res.json();
    expect(body.members).toHaveLength(2);
    expect(body.members[0]?.userId).toBe(owner.userId);
    expect(body.members[0]?.publicKey).toBe(toBase64(owner.publicKey));
    expect(body.members[1]?.userId).toBe(member.userId);
    expect(body.members[1]?.publicKey).toBe(toBase64(member.publicKey));
    expect(body.members.every((m) => m.linkId === null)).toBe(true);
  });

  it('includes link members joined to the link public key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const linkPublicKey = crypto.getRandomValues(new Uint8Array(32));
    const linkRows = await db
      .insert(sharedLinks)
      .values({ conversationId: id, linkPublicKey })
      .returning({ id: sharedLinks.id });
    const linkId = linkRows[0]?.id;
    if (linkId === undefined) throw new Error('link seed failed');
    await db.insert(conversationMembers).values({
      conversationId: id,
      linkId,
      privilege: 'read',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });
    const res = await get(`/conversations/${id}/member-keys`, owner.cookie);
    const body: MemberKeysBody = await res.json();
    const linkMember = body.members.find((m) => m.linkId === linkId);
    expect(linkMember?.userId).toBeNull();
    expect(linkMember?.publicKey).toBe(toBase64(linkPublicKey));
  });

  it('serves a read-privilege member (membership, not admin, is the gate)', async () => {
    const owner = await newUser();
    const reader = await newUser();
    const id = await createConversation(owner);
    await seedMember(id, reader.userId, 'read');
    const res = await get(`/conversations/${id}/member-keys`, reader.cookie);
    expect(res.status).toBe(200);
    const body: MemberKeysBody = await res.json();
    expect(body.members.map((m) => m.userId)).toEqual(
      expect.arrayContaining([owner.userId, reader.userId])
    );
  });

  it('hides the key set from a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await get(`/conversations/${id}/member-keys`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('excludes a member who has left', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await seedMember(id, member.userId, 'write');
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, member.userId)
        )
      );
    const res = await get(`/conversations/${id}/member-keys`, owner.cookie);
    const body: MemberKeysBody = await res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.userId).toBe(owner.userId);
  });
});

interface BatchBody {
  keyChains: Record<string, { currentEpoch: number }>;
  missing: string[];
}

async function getBatch(ids: string[], cookie: string): Promise<Response> {
  return get(`/conversations/member-keys/batch?conversationIds=${ids.join(',')}`, cookie);
}

describe('conversations routes: batch keychain', () => {
  it('returns keychains for accessible ids and lists the rest as missing (never 404)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const mine = await createConversation(owner);
    const foreign = await createConversation(other);
    const absent = crypto.randomUUID();
    const res = await getBatch([mine, foreign, absent], owner.cookie);
    expect(res.status).toBe(200);
    const body: BatchBody = await res.json();
    expect(Object.keys(body.keyChains)).toEqual([mine]);
    expect(body.keyChains[mine]?.currentEpoch).toBe(1);
    expect(body.missing).toEqual(expect.arrayContaining([foreign, absent]));
    expect(body.missing).not.toContain(mine);
  });

  it('rejects a batch over the 100-id cap', async () => {
    const owner = await newUser();
    const ids = Array.from({ length: 101 }, () => crypto.randomUUID());
    const res = await getBatch(ids, owner.cookie);
    expect(res.status).toBe(400);
  });
});

interface HistoryBody {
  messages: {
    id: string;
    sequenceNumber: number;
    epochNumber: number;
    wrappedContentKey: string;
    contentItems: {
      id: string;
      contentType: string;
      encryptedBlob: string | null;
      byteLength: number | null;
    }[];
  }[];
  nextCursor: string | null;
}

async function getHistory(conversationId: string, cookie: string, query = ''): Promise<Response> {
  return get(`/conversations/${conversationId}/messages${query}`, cookie);
}

async function historyBody(
  conversationId: string,
  cookie: string,
  query = ''
): Promise<HistoryBody> {
  const res = await getHistory(conversationId, cookie, query);
  const body: HistoryBody = await res.json();
  return body;
}

describe('conversations routes: message history', () => {
  it('returns messages ordered by sequence with their content items for a member', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const first = await seedMessage(id, 1);
    const second = await seedMessage(id, 2);
    await seedTextContentItem(first, 0);
    await seedTextContentItem(second, 0);
    const res = await getHistory(id, owner.cookie);
    expect(res.status).toBe(200);
    const body: HistoryBody = await res.json();
    expect(body.messages.map((m) => m.sequenceNumber)).toEqual([1, 2]);
    expect(body.messages[0]?.wrappedContentKey).toBe(toBase64(BYTES));
    expect(body.messages[0]?.contentItems[0]?.contentType).toBe('text');
    expect(body.messages[0]?.contentItems[0]?.encryptedBlob).toBe(toBase64(BYTES));
  });

  it('carries the content-item id and null bytes for a media item (presign deferred)', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const message = await seedMessage(id, 1);
    const mediaId = await seedMediaContentItem(message, 0);
    const res = await getHistory(id, owner.cookie);
    const body: HistoryBody = await res.json();
    const item = body.messages[0]?.contentItems[0];
    expect(item?.id).toBe(mediaId);
    expect(item?.contentType).toBe('image');
    expect(item?.encryptedBlob).toBeNull();
    expect(item?.byteLength).toBe(42);
    expect(JSON.stringify(body)).not.toContain('http');
  });

  it('denies a non-member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await getHistory(id, outsider.cookie);
    expect(res.status).toBe(404);
  });

  it('hides messages below a late joiner visibility floor', async () => {
    const owner = await newUser();
    const joiner = await newUser();
    const id = await createConversation(owner);
    const early = await seedMessage(id, 1);
    // Adding with rotation advances to epoch 2 and floors the joiner there.
    await send('POST', `/conversations/${id}/members`, owner.cookie, {
      userId: joiner.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: rotationFor(1, [owner.publicKey, joiner.publicKey]),
    });
    const late = await seedMessageAtEpoch(id, 2, 2);
    const ownerBody = await historyBody(id, owner.cookie);
    expect(ownerBody.messages.map((m) => m.id)).toEqual([early, late]);
    const joinerBody = await historyBody(id, joiner.cookie);
    expect(joinerBody.messages.map((m) => m.id)).toEqual([late]);
  });

  it('paginates by sequence with a following cursor', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    await seedMessage(id, 1);
    await seedMessage(id, 2);
    await seedMessage(id, 3);
    const firstPage = await historyBody(id, owner.cookie, '?limit=2');
    expect(firstPage.messages.map((m) => m.sequenceNumber)).toEqual([1, 2]);
    expect(firstPage.nextCursor).toBe('2');
    const secondPage = await historyBody(
      id,
      owner.cookie,
      `?limit=2&cursor=${firstPage.nextCursor ?? ''}`
    );
    expect(secondPage.messages.map((m) => m.sequenceNumber)).toEqual([3]);
    expect(secondPage.nextCursor).toBeNull();
  });
});

interface PublicShareContentBody {
  displayName: string | null;
  sharedMessages: {
    messageId: string;
    contentItems: { id: string; contentType: string; encryptedBlob: string | null }[];
  }[];
}

describe('conversations routes: public share content items', () => {
  it('returns text encryptedBlob inline and media by content-item id', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedShareMessage(conv);
    const textId = await seedTextContentItem(messageId, 0);
    const mediaId = await seedMediaContentItem(messageId, 1);
    const linkBody: LinkBody = await mintLinkBody(owner, conv, { displayName: 'shared' });
    await send('POST', `/conversations/${conv}/shares`, owner.cookie, {
      messageId,
      linkId: linkBody.link.id,
      wrappedContentKey: B64,
    });
    const res = await getPublic(linkBody.link.id);
    expect(res.status).toBe(200);
    const body: PublicShareContentBody = await res.json();
    const items = body.sharedMessages[0]?.contentItems ?? [];
    expect(items.map((item) => item.id)).toEqual([textId, mediaId]);
    expect(items[0]?.encryptedBlob).toBe(toBase64(BYTES));
    expect(items[1]?.encryptedBlob).toBeNull();
    expect(items[1]?.id).toBe(mediaId);
    expect(JSON.stringify(body)).not.toContain('http');
  });
});

async function memberIdOf(conversationId: string, userId: string): Promise<string> {
  const rows = await db
    .select({ id: conversationMembers.id })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.userId, userId)
      )
    );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('member row missing');
  return id;
}

describe('conversations routes: accept invite', () => {
  it('flips a pending membership to accepted', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
    const rows = await db
      .select({ acceptedAt: conversationMembers.acceptedAt })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, id),
          eq(conversationMembers.userId, member.userId)
        )
      );
    expect(rows[0]?.acceptedAt).not.toBeNull();
  });

  it('is idempotent on repeat accept', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    const res = await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });
  });

  it('denies a non-member accept', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('PATCH', `/conversations/${id}/membership/accept`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: decline invite', () => {
  it('marks a pending membership left and broadcasts member:removed', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/membership/decline`,
      cookie: member.cookie,
    });
    expect(res.status).toBe(200);
    const body: { declined: boolean; memberId: string } = await res.json();
    expect(body.declined).toBe(true);
    const rows = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, memberId));
    expect(rows[0]?.leftAt).not.toBeNull();
    const removed = broadcasts.filter((b) => b.event.type === 'member:removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.event).toMatchObject({
      conversationId: id,
      memberId,
      userId: member.userId,
    });
  });

  it('refuses to decline an already-accepted membership', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    await send('PATCH', `/conversations/${id}/membership/accept`, member.cookie);
    const res = await send('POST', `/conversations/${id}/membership/decline`, member.cookie);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('answers not-found for a non-member decline', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const id = await createConversation(owner);
    const res = await send('POST', `/conversations/${id}/membership/decline`, outsider.cookie);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

describe('conversations routes: change privilege', () => {
  it('lets an admin change a lower member privilege and broadcasts it', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const adminMember = await newUser();
    const writer = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminMember, 'admin');
    const writerId = await addFullHistory(owner, id, writer, 'write');
    const res = await dispatch({
      app,
      method: 'PATCH',
      path: `/conversations/${id}/member/${writerId}/privilege`,
      cookie: adminMember.cookie,
      body: { privilege: 'read' },
    });
    expect(res.status).toBe(200);
    const body: { updated: boolean; memberId: string; privilege: string } = await res.json();
    expect(body).toMatchObject({ updated: true, memberId: writerId, privilege: 'read' });
    const rows = await db
      .select({ privilege: conversationMembers.privilege })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, writerId));
    expect(rows[0]?.privilege).toBe('read');
    const changed = broadcasts.filter((b) => b.event.type === 'member:privilege-changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]?.event).toMatchObject({ memberId: writerId, privilege: 'read' });
  });

  it('forbids a non-admin from changing a privilege', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const other = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, writer, 'write');
    const otherId = await addFullHistory(owner, id, other, 'write');
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${otherId}/privilege`,
      writer.cookie,
      { privilege: 'read' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('refuses an admin changing their own privilege', async () => {
    const owner = await newUser();
    const adminMember = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminMember, 'admin');
    const adminId = await memberIdOf(id, adminMember.userId);
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${adminId}/privilege`,
      adminMember.cookie,
      { privilege: 'read' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CANNOT_CHANGE_OWN_PRIVILEGE });
  });

  it('answers not-found for a missing target member', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${crypto.randomUUID()}/privilege`,
      owner.cookie,
      { privilege: 'read' }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('forbids a grant that is not strictly below the caller', async () => {
    const owner = await newUser();
    const adminMember = await newUser();
    const writer = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, adminMember, 'admin');
    const writerId = await addFullHistory(owner, id, writer, 'write');
    const res = await send(
      'PATCH',
      `/conversations/${id}/member/${writerId}/privilege`,
      adminMember.cookie,
      { privilege: 'admin' }
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });
});

describe('conversations routes: update title', () => {
  it('lets the owner update the ciphertext title, round-tripped untouched', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const title = randomB64();
    const res = await send('PATCH', `/conversations/${id}`, owner.cookie, {
      title,
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(200);
    const body: { conversation: { title: string; titleEpochNumber: number } } = await res.json();
    expect(body.conversation.title).toBe(title);
    expect(body.conversation.titleEpochNumber).toBe(1);
  });

  it('forbids a non-owner title update', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    await addFullHistory(owner, id, member);
    const res = await send('PATCH', `/conversations/${id}`, member.cookie, {
      title: randomB64(),
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
  });

  it('answers not-found for a missing conversation', async () => {
    const owner = await newUser();
    const res = await send('PATCH', `/conversations/${crypto.randomUUID()}`, owner.cookie, {
      title: randomB64(),
      titleEpochNumber: 1,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('replays the stored response for a retried Idempotency-Key', async () => {
    const owner = await newUser();
    const id = await createConversation(owner);
    const key = crypto.randomUUID();
    const title = randomB64();
    const first = await dispatch({
      method: 'PATCH',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      body: { title, titleEpochNumber: 1 },
      idempotencyKey: key,
    });
    const second = await dispatch({
      method: 'PATCH',
      path: `/conversations/${id}`,
      cookie: owner.cookie,
      body: { title, titleEpochNumber: 1 },
      idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });
});

describe('conversations routes: membership events', () => {
  it('broadcasts member:added and rotation:complete on a rotation add', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members`,
      cookie: owner.cookie,
      body: {
        userId: target.userId,
        privilege: 'write',
        giveFullHistory: false,
        rotation: rotationFor(1, [owner.publicKey, target.publicKey]),
      },
    });
    expect(res.status).toBe(200);
    const added = broadcasts.filter((b) => b.event.type === 'member:added');
    expect(added).toHaveLength(1);
    expect(added[0]?.event).toMatchObject({
      conversationId: id,
      userId: target.userId,
      privilege: 'write',
    });
    const rotated = broadcasts.filter((b) => b.event.type === 'rotation:complete');
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.event).toMatchObject({ conversationId: id, newEpochNumber: 2 });
  });

  it('broadcasts member:added without rotation:complete on a full-history add', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const target = await newUser();
    const id = await createConversation(owner);
    await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members`,
      cookie: owner.cookie,
      body: {
        userId: target.userId,
        privilege: 'write',
        giveFullHistory: true,
        wrap: randomB64(),
        expectedEpoch: 1,
      },
    });
    expect(broadcasts.filter((b) => b.event.type === 'member:added')).toHaveLength(1);
    expect(broadcasts.filter((b) => b.event.type === 'rotation:complete')).toHaveLength(0);
  });

  it('broadcasts member:removed and rotation:complete on removal', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
    });
    expect(res.status).toBe(200);
    const removed = broadcasts.filter((b) => b.event.type === 'member:removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.event).toMatchObject({ conversationId: id, memberId });
    const rotated = broadcasts.filter((b) => b.event.type === 'rotation:complete');
    expect(rotated).toHaveLength(1);
    expect(rotated[0]?.event).toMatchObject({ newEpochNumber: 2 });
  });

  it('broadcasts member:removed and rotation:complete on a non-owner leave', async () => {
    const broadcasts: BroadcastCall[] = [];
    const app = createApp([], broadcasts);
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/leave`,
      cookie: member.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
    });
    expect(res.status).toBe(200);
    const removed = broadcasts.filter((b) => b.event.type === 'member:removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]?.event).toMatchObject({
      conversationId: id,
      memberId,
      userId: member.userId,
    });
    expect(broadcasts.filter((b) => b.event.type === 'rotation:complete')).toHaveLength(1);
  });

  it('does not fail the mutation when a broadcast errors', async () => {
    const owner = await newUser();
    const member = await newUser();
    const id = await createConversation(owner);
    const memberId = await addFullHistory(owner, id, member);
    const failingRealtime: RealtimeBroadcast = {
      broadcast: () => errAsync(unavailableError('broadcast down')),
      evict: () => okAsync(0),
      presence: () => okAsync([]),
      startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0 }),
      stopRun: () => okAsync(false),
      upgrade: () => okAsync(new Response(null, { status: 200 })),
    };
    const manifest = createConversationsManifest({
      stores: createConversationsStores,
      revoker: createMembershipRevoker,
      realtime: () => failingRealtime,
      deleteForkMessages: (writer) => (conversationId, ids) =>
        deleteForkMessagesWithinTx(writer, conversationId, ids),
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);
    const res = await dispatch({
      app,
      method: 'POST',
      path: `/conversations/${id}/members/${memberId}/remove`,
      cookie: owner.cookie,
      body: { rotation: rotationFor(1, [owner.publicKey]) },
    });
    expect(res.status).toBe(200);
    const rows = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(eq(conversationMembers.id, memberId));
    expect(rows[0]?.leftAt).not.toBeNull();
  });
});
