import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import { ERROR_CODES, fromBase64, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createRedisMembershipCache } from './adapters/membership.js';
import { createConversationsManifest, createConversationsStores } from './index.js';
import { createMembershipRevoker } from './adapters/membership.js';
import { Redis } from '@upstash/redis';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from './ports/realtime.js';

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

function recordingRealtime(evicted: EvictedCall[]): RealtimeBroadcast {
  return {
    broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
    evict: (conversationId, principalId) => {
      evicted.push({ conversationId, principalId });
      return okAsync(1);
    },
    presence: () => okAsync([]),
    startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0 }),
    stopRun: () => okAsync(false),
  };
}

function createApp(evicted: EvictedCall[] = []): Hono<AppEnv> {
  const manifest = createConversationsManifest({
    stores: createConversationsStores,
    revoker: createMembershipRevoker,
    realtime: () => recordingRealtime(evicted),
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

async function send(
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
  options: SendOptions = {}
): Promise<Response> {
  const app = options.app ?? createApp();
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' };
  if (options.idempotencyKey !== null && method !== 'GET') {
    headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();
  }
  return app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    options.env ?? testEnv
  );
}

const get = (path: string, cookie: string, options: SendOptions = {}): Promise<Response> =>
  send('GET', path, cookie, undefined, options);

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
    ['PATCH', `/conversations/${ID}/membership/mute`],
    ['PATCH', `/conversations/${ID}/membership/pin`],
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
    const res = await send('POST', '/conversations', cookie, createBody(crypto.randomUUID()), {
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
    const body = (await res.json()) as { conversation: Record<string, unknown>; created: boolean };
    expect(body.created).toBe(true);
    expect(body.conversation['id']).toBe(id);
    expect(body.conversation['title']).toBe(B64);
    expect(body.conversation['currentEpoch']).toBe(1);
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
    const first = await send('POST', '/conversations', owner.cookie, createBody(id), {
      idempotencyKey: key,
    });
    const second = await send('POST', '/conversations', owner.cookie, createBody(id), {
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
    const body = (await res.json()) as { created: boolean };
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
    const body = (await res.json()) as {
      conversations: Record<string, unknown>[];
      nextCursor: string | null;
    };
    const row = body.conversations.find((c) => c['id'] === id);
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
    const body = (await res.json()) as { conversations: { id: string }[] };
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
    const firstBody = (await first.json()) as {
      conversations: { id: string }[];
      nextCursor: string | null;
    };
    expect(firstBody.conversations).toHaveLength(2);
    expect(firstBody.nextCursor).not.toBeNull();
    const second = await get(
      `/conversations?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      owner.cookie
    );
    const secondBody = (await second.json()) as { conversations: { id: string }[] };
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
    const body = (await res.json()) as {
      conversation: { id: string };
      membership: Record<string, unknown>;
    };
    expect(body.conversation.id).toBe(id);
    expect(body.membership).toMatchObject({
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
    });
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
    const res = await send('DELETE', `/conversations/${id}`, owner.cookie, undefined, {
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
  privilege = 'write',
  options: SendOptions = {}
): Promise<string> {
  const res = await send(
    'POST',
    `/conversations/${conversationId}/members`,
    owner.cookie,
    { userId: target.userId, privilege, giveFullHistory: true, wrap: randomB64(), expectedEpoch: 1 },
    options
  );
  if (res.status !== 200) throw new Error(`member add failed: ${String(res.status)}`);
  const body = (await res.json()) as { member: { id: string } };
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
    const body = (await res.json()) as { members: { userId: string; privilege: string }[] };
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
    const body = (await res.json()) as { member: Record<string, unknown>; newEpochNumber: null };
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
    const body = (await res.json()) as { member: Record<string, unknown>; newEpochNumber: number };
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
    expect(await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch1Id))).toHaveLength(0);
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
    });
    const app = applyPipeline(new Hono<AppEnv>());
    app.route(manifest.basePath, manifest.routes);

    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) },
      { app }
    );
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
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const conversationRow = await db.select().from(conversations).where(eq(conversations.id, id));
    expect(conversationRow[0]?.currentEpoch).toBe(2);
    const allEpochs = await epochRows(id);
    expect(allEpochs.map((e) => e.epochNumber)).toEqual([1, 2]);
    const epoch2Id = allEpochs[1]?.id;
    if (epoch2Id === undefined) throw new Error('epoch 2 missing');
    expect(await db.select().from(epochMembers).where(eq(epochMembers.epochId, epoch2Id))).toHaveLength(2);
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
    const res = await send('POST', `/conversations/${id}/members/${memberId}/remove`, owner.cookie, {
      rotation: rotationFor(1, [owner.publicKey]),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { removed: boolean; newEpochNumber: number };
    expect(body.removed).toBe(true);
    expect(body.newEpochNumber).toBe(2);
    const rows = await db
      .select()
      .from(conversationMembers)
      .where(
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, member.userId))
      );
    expect(rows[0]?.leftAt).not.toBeNull();
  });

  it('evicts the removed member: cache deleted, socket eviction invoked, reads revoked', async () => {
    const { owner, member, id, memberId } = await removalSetup();
    const cache = createRedisMembershipCache(redis);
    await cache.set(id, member.userId, 'member', 30);
    const evicted: EvictedCall[] = [];
    const res = await send(
      'POST',
      `/conversations/${id}/members/${memberId}/remove`,
      owner.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) },
      { app: createApp(evicted) }
    );
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
        and(eq(conversationMembers.conversationId, id), eq(conversationMembers.userId, owner.userId))
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
    const res = await send(
      'POST',
      `/conversations/${id}/leave`,
      member.cookie,
      { rotation: rotationFor(1, [owner.publicKey]) },
      { app: createApp(evicted) }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { left: boolean; newEpochNumber: number };
    expect(body.left).toBe(true);
    expect(body.newEpochNumber).toBe(2);
    expect(evicted).toEqual([{ conversationId: id, principalId: member.userId }]);
    const list = await get('/conversations', member.cookie);
    const listBody = (await list.json()) as { conversations: { id: string }[] };
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
    const res = await send('POST', `/conversations/${id}/leave`, owner.cookie, {}, {
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
    const body = (await list.json()) as { conversations: { id: string; pinned: boolean }[] };
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
    const body = (await res.json()) as {
      wraps: { epochNumber: number; visibleFromEpoch: number }[];
      chainLinks: { epochNumber: number }[];
      currentEpoch: number;
    };
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
    const body = (await res.json()) as {
      wraps: { epochNumber: number }[];
      chainLinks: { epochNumber: number }[];
    };
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
