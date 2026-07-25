import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, conversations, createDb, users } from '@hushbox/db';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { okAsync } from '../../lib/result/index.js';
import { createConversationsManifest, createConversationsStores } from './index.js';
import { createMembershipRevoker } from './adapters/membership.js';
import { createLinkResolutionAdapter } from '../../adapters/link-resolution.js';
import { createBillingStores } from '../billing/index.js';
import { deleteForkMessagesWithinTx } from '../chat/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from './ports/realtime.js';

/**
 * The durable read cursor end-to-end against real Postgres: the monotonic
 * write route and the read-state exposure the client's dismissal sync reads.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for the read-cursor tests');
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

const BYTES = new Uint8Array([7, 7, 7]);
const B64 = toBase64(new Uint8Array([1, 2, 3]));
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

interface TestUser {
  userId: string;
  cookie: string;
}

async function newUser(): Promise<TestUser> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@read-cursor.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
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
  return { userId, cookie: `${SESSION_COOKIE_NAME}=${sealed}` };
}

function stubRealtime(): RealtimeBroadcast {
  return {
    broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
    evict: () => okAsync(1),
    presence: () => okAsync([]),
    startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0 }),
    stopRun: () => okAsync(false),
    upgrade: () => okAsync(new Response(null, { status: 200 })),
  };
}

const manifest = createConversationsManifest({
  stores: createConversationsStores,
  billing: createBillingStores(),
  revoker: createMembershipRevoker,
  realtime: () => stubRealtime(),
  deleteForkMessages: (writer) => (conversationId, ids) =>
    deleteForkMessagesWithinTx(writer, conversationId, ids),
  linkResolution: (writer) => createLinkResolutionAdapter(writer),
});
const app = applyPipeline(new Hono<AppEnv>());
app.route(manifest.basePath, manifest.routes);

async function send(
  method: string,
  path: string,
  cookie: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' };
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  return app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    testEnv
  );
}

async function createConversation(owner: TestUser): Promise<string> {
  const id = crypto.randomUUID();
  createdConversationIds.push(id);
  const res = await send('POST', '/conversations', owner.cookie, {
    id,
    title: B64,
    epochPublicKey: B64,
    confirmationHash: B64,
    memberWrap: B64,
  });
  if (res.status !== 200) throw new Error(`conversation create failed: ${String(res.status)}`);
  return id;
}

async function markRead(user: TestUser, conversationId: string, lastReadSeq: number) {
  const res = await send('PATCH', `/conversations/${conversationId}/read`, user.cookie, {
    lastReadSeq,
  });
  const body: Record<string, unknown> = await res.json();
  return { status: res.status, body };
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

describe('read-cursor write route', () => {
  it('advances the caller cursor to the acknowledged sequence', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);

    const marked = await markRead(owner, conversationId, 5);

    expect(marked.status).toBe(200);
    expect(marked.body).toEqual({ lastReadSeq: 5 });
  });

  it('converges on the same cursor when the identical write replays', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);

    await markRead(owner, conversationId, 9);
    const replay = await markRead(owner, conversationId, 9);

    expect(replay.body).toEqual({ lastReadSeq: 9 });
  });

  it('never regresses the cursor when a lower write arrives out of order', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);

    await markRead(owner, conversationId, 20);
    const stale = await markRead(owner, conversationId, 3);

    expect(stale.body).toEqual({ lastReadSeq: 20 });
  });

  it('refuses a caller who is not an active member', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const conversationId = await createConversation(owner);

    const refused = await markRead(outsider, conversationId, 2);

    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('rejects a negative sequence at the boundary', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);

    const rejected = await markRead(owner, conversationId, -1);

    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ code: ERROR_CODES.VALIDATION });
  });
});

describe('read-state exposure', () => {
  it('carries the cursor on the single-conversation membership payload', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);
    await markRead(owner, conversationId, 11);

    const res = await send('GET', `/conversations/${conversationId}`, owner.cookie);
    const body: { membership: { lastReadSeq: number } } = await res.json();

    expect(body.membership.lastReadSeq).toBe(11);
  });

  it('carries the cursor on the conversation list entry', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);
    await markRead(owner, conversationId, 4);

    const res = await send('GET', '/conversations', owner.cookie);
    const body: { conversations: { id: string; lastReadSeq: number }[] } = await res.json();

    expect(body.conversations.find((row) => row.id === conversationId)?.lastReadSeq).toBe(4);
  });

  it('defaults an unread conversation to a zero cursor', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);

    const res = await send('GET', `/conversations/${conversationId}`, owner.cookie);
    const body: { membership: { lastReadSeq: number } } = await res.json();

    expect(body.membership.lastReadSeq).toBe(0);
  });
});
