import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  messages,
  users,
} from '@hushbox/db';
import { toBase64 } from '@hushbox/shared';
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
import type { ConversationEventNotification } from './ports/index.js';
import type { RealtimeBroadcast } from './ports/realtime.js';

/**
 * The membership event sources: which conversation mutations fire the
 * best-effort notification capability, with which actor and target set, and the
 * guarantee that a failing capability can never touch the committed mutation.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for the membership-event tests');
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

const BYTES = new Uint8Array([5, 5, 5]);
const B64 = toBase64(new Uint8Array([1, 2, 3]));
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

interface TestUser {
  userId: string;
  cookie: string;
  publicKey: string;
}

async function newUser(): Promise<TestUser> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@membership-events.test`,
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
  return {
    userId,
    cookie: `${SESSION_COOKIE_NAME}=${sealed}`,
    publicKey: toBase64(publicKey),
  };
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

const notifications: ConversationEventNotification[] = [];
let notifyThrows = false;

function createApp(): Hono<AppEnv> {
  const manifest = createConversationsManifest({
    stores: createConversationsStores,
    billing: createBillingStores(),
    revoker: createMembershipRevoker,
    realtime: () => stubRealtime(),
    deleteForkMessages: (writer) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(writer, conversationId, ids),
    linkResolution: (writer) => createLinkResolutionAdapter(writer),
    notifyConversationEvent: () => (notification) => {
      notifications.push(notification);
      if (notifyThrows) throw new Error('push capability blew up');
      return Promise.resolve();
    },
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

const app = createApp();

/**
 * Requests carry a collecting ExecutionContext, then the collected tasks are
 * awaited AFTER the response — the `waitUntil` semantics the route relies on.
 */
async function send(
  method: string,
  path: string,
  cookie: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' };
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  const tasks: Promise<unknown>[] = [];
  const executionCtx: ExecutionContext = {
    waitUntil: (task: Promise<unknown>) => {
      tasks.push(task);
    },
    passThroughOnException: () => {
      /* no-op in tests */
    },
    props: {},
  };
  const response = await app.request(
    path,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    testEnv,
    executionCtx
  );
  await Promise.all(tasks);
  return response;
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

let messageSequence = 0;

async function seedMessage(conversationId: string): Promise<string> {
  messageSequence += 1;
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: messageSequence,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('message seed failed');
  return id;
}

async function addMember(
  owner: TestUser,
  conversationId: string,
  invitee: TestUser
): Promise<Response> {
  return send('POST', `/conversations/${conversationId}/members`, owner.cookie, {
    userId: invitee.userId,
    privilege: 'write',
    giveFullHistory: true,
    expectedEpoch: 1,
    wrap: B64,
  });
}

beforeEach(() => {
  notifications.length = 0;
  notifyThrows = false;
});

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('membership event sources', () => {
  it('notifies the added member alone when a user joins a conversation', async () => {
    const owner = await newUser();
    const invitee = await newUser();
    const conversationId = await createConversation(owner);

    const res = await addMember(owner, conversationId, invitee);

    expect(res.status).toBe(200);
    expect(notifications).toEqual([
      {
        conversationId,
        actorUserId: owner.userId,
        recipientUserIds: [invitee.userId],
        presentUserIds: [],
      },
    ]);
  });

  it('notifies every member when a fork is created', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);
    notifications.length = 0;

    const fromMessageId = await seedMessage(conversationId);
    const res = await send('POST', `/conversations/${conversationId}/forks`, owner.cookie, {
      id: crypto.randomUUID(),
      fromMessageId,
      name: 'Branch',
    });

    expect(res.status).toBe(200);
    expect(notifications).toEqual([
      { conversationId, actorUserId: owner.userId, presentUserIds: [] },
    ]);
  });

  it('notifies every member when a conversation is shared by link', async () => {
    const owner = await newUser();
    const conversationId = await createConversation(owner);
    notifications.length = 0;

    const res = await send('POST', `/conversations/${conversationId}/links`, owner.cookie, {
      linkPublicKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
      privilege: 'read',
      giveFullHistory: true,
      expectedEpoch: 1,
      memberWrap: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    });

    expect(res.status).toBe(200);
    expect(notifications).toEqual([
      { conversationId, actorUserId: owner.userId, presentUserIds: [] },
    ]);
  });

  it('fires no notification when the mutation itself is refused', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const invitee = await newUser();
    const conversationId = await createConversation(owner);
    notifications.length = 0;

    const res = await addMember(outsider, conversationId, invitee);

    expect(res.status).not.toBe(200);
    expect(notifications).toEqual([]);
  });
});

describe('membership notification is best-effort', () => {
  it('commits the membership and answers 200 when the capability throws', async () => {
    const owner = await newUser();
    const invitee = await newUser();
    const conversationId = await createConversation(owner);
    notifyThrows = true;

    const res = await addMember(owner, conversationId, invitee);

    expect(res.status).toBe(200);
    const seated = await db
      .select({ id: conversationMembers.id })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conversationId),
          eq(conversationMembers.userId, invitee.userId),
          isNull(conversationMembers.leftAt)
        )
      );
    expect(seated).toHaveLength(1);
  });
});
