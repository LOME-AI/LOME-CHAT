import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { and, eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  messages,
  sharedLinks,
  sharedMessages,
  users,
} from '@hushbox/db';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { okAsync } from '../../lib/result/index.js';
import { createConversationsManifest, createConversationsStores } from './index.js';
import { LINK_CREDENTIAL_HEADER } from './domain/index.js';
import { createMembershipRevoker } from './adapters/membership.js';
import { createLinkResolutionAdapter } from '../../adapters/link-resolution.js';
import { createBillingStores } from '../billing/index.js';
import { deleteForkMessagesWithinTx } from '../chat/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { TelemetryEnv } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from './ports/realtime.js';

/**
 * Sharing-family integration coverage that fills the behaviors the broader
 * `routes.integration.test.ts` suite does not yet assert, exercised end-to-end
 * against real local Postgres. Each test targets one sub-area of the family
 * (links, message-shares, link-guest authz, decline, creator-severing) from an
 * angle the existing suite leaves open, and asserts the CURRENT (post-amendment)
 * behavior: standalone share-id-scoped message reads, lazily-enforced link
 * expiry, and FK-cascade severing surfaced at the public read.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for the sharing-family tests');
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

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
let userCounter = 0;
let seq = 0;

const BYTES = new Uint8Array([9, 9, 9]);
const B64 = toBase64(new Uint8Array([1, 2, 3]));

interface TestUser {
  userId: string;
  cookie: string;
  publicKey: Uint8Array;
}

async function newUser(): Promise<TestUser> {
  userCounter += 1;
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}s${String(userCounter)}`;
  const publicKey = crypto.getRandomValues(new Uint8Array(32));
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@sharing-family.test`,
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

function recordingRealtime(): RealtimeBroadcast {
  return {
    broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
    evict: () => okAsync(1),
    presence: () => okAsync([]),
    startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0 }),
    stopRun: () => okAsync(false),
    upgrade: () => okAsync(new Response(null, { status: 200 })),
  };
}

function createApp(): Hono<AppEnv> {
  const manifest = createConversationsManifest({
    stores: createConversationsStores,
    billing: createBillingStores(),
    revoker: createMembershipRevoker,
    realtime: () => recordingRealtime(),
    deleteForkMessages: (writer) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(writer, conversationId, ids),
    linkResolution: (writer) => createLinkResolutionAdapter(writer),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

const app = createApp();

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

/** POSTs a mutation carrying an explicit Idempotency-Key (for replay assertions). */
async function postKeyed(
  path: string,
  cookie: string,
  key: string,
  body: unknown
): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

async function guestGet(path: string, guestKey: string): Promise<Response> {
  return app.request(
    path,
    { method: 'GET', headers: { [LINK_CREDENTIAL_HEADER]: guestKey } },
    testEnv
  );
}

function createConversationBody(id: string): Record<string, unknown> {
  return { id, title: B64, epochPublicKey: B64, confirmationHash: B64, memberWrap: B64 };
}

async function createConversation(owner: TestUser): Promise<string> {
  const id = crypto.randomUUID();
  createdConversationIds.push(id);
  const res = await send('POST', '/conversations', owner.cookie, createConversationBody(id));
  if (res.status !== 200) throw new Error(`conversation create failed: ${String(res.status)}`);
  return id;
}

/** Mints a full-history read-guest link at epoch 1, returning the guest key and link id. */
async function mintGuestLink(
  owner: TestUser,
  conversationId: string
): Promise<{ guestKey: string; linkId: string }> {
  const guestKey = toBase64(crypto.getRandomValues(new Uint8Array(32)));
  const res = await send('POST', `/conversations/${conversationId}/links`, owner.cookie, {
    linkPublicKey: guestKey,
    privilege: 'read',
    giveFullHistory: true,
    expectedEpoch: 1,
    memberWrap: toBase64(crypto.getRandomValues(new Uint8Array(32))),
  });
  if (res.status !== 200) throw new Error(`link mint failed: ${String(res.status)}`);
  const body: { link: { id: string } } = await res.json();
  return { guestKey, linkId: body.link.id };
}

async function seedMessage(conversationId: string): Promise<string> {
  seq += 1;
  const rows = await db
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: seq,
    })
    .returning({ id: messages.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('message seed failed');
  return id;
}

async function publicShareRead(shareId: string): Promise<Response> {
  return app.request(`/conversations/shared/message/${shareId}`, { method: 'GET' }, testEnv);
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

describe('sharing family: shared-link expiry is enforced lazily at the guest read', () => {
  it('refuses an active guest once the link has expired, with no revoke or purge step', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey, linkId } = await mintGuestLink(owner, conv);

    // Live: the unauthenticated guest read of its own conversation succeeds.
    const live = await guestGet(`/conversations/${conv}`, guestKey);
    expect(live.status).toBe(200);

    // Backdate the expiry only — the link stays un-revoked and the guest member
    // row stays active; the read must still refuse purely on the lazy predicate.
    await db
      .update(sharedLinks)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sharedLinks.id, linkId));

    const expired = await guestGet(`/conversations/${conv}`, guestKey);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });
  });
});

describe('sharing family: message-share create is idempotent under a retried key', () => {
  it('replays the same share id for a retried Idempotency-Key without a duplicate row', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const messageId = await seedMessage(conv);
    const key = crypto.randomUUID();
    const body = { messageId, wrappedContentKey: B64 };

    const first = await postKeyed(`/conversations/${conv}/shares`, owner.cookie, key, body);
    const second = await postKeyed(`/conversations/${conv}/shares`, owner.cookie, key, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody: { shareId: string } = await first.json();
    const secondBody: { shareId: string } = await second.json();
    expect(secondBody.shareId).toBe(firstBody.shareId);

    const rows = await db
      .select({ id: sharedMessages.id })
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, messageId));
    expect(rows).toHaveLength(1);
  });
});

describe('sharing family: a link-guest is refused at session-class HTTP routes', () => {
  it('cannot create a message share with only a link credential (authorized only at realtime/media)', async () => {
    const owner = await newUser();
    const conv = await createConversation(owner);
    const { guestKey } = await mintGuestLink(owner, conv);
    const messageId = await seedMessage(conv);

    const res = await app.request(
      `/conversations/${conv}/shares`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          [LINK_CREDENTIAL_HEADER]: guestKey,
        },
        body: JSON.stringify({ messageId, wrappedContentKey: B64 }),
      },
      testEnv
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: ERROR_CODES.UNAUTHORIZED });

    // The guest's attempt wrote nothing.
    const rows = await db
      .select({ id: sharedMessages.id })
      .from(sharedMessages)
      .where(eq(sharedMessages.messageId, messageId));
    expect(rows).toHaveLength(0);
  });
});

describe('sharing family: declining an invite is idempotent on repeat', () => {
  it('marks a pending member left once, then answers not-found for a repeat decline', async () => {
    const owner = await newUser();
    const invitee = await newUser();
    const conv = await createConversation(owner);
    // Seed a pending (unaccepted, not-left) membership directly — the decline
    // transition targets exactly this state.
    await db.insert(conversationMembers).values({
      conversationId: conv,
      userId: invitee.userId,
      privilege: 'read',
      visibleFromEpoch: 1,
      acceptedAt: null,
    });

    const first = await send('POST', `/conversations/${conv}/membership/decline`, invitee.cookie);
    expect(first.status).toBe(200);
    const firstBody: { declined: boolean } = await first.json();
    expect(firstBody.declined).toBe(true);

    const second = await send('POST', `/conversations/${conv}/membership/decline`, invitee.cookie);
    expect(second.status).toBe(404);
    expect(await second.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });

    // Exactly one membership row, left — the repeat wrote no new state.
    const rows = await db
      .select({ leftAt: conversationMembers.leftAt })
      .from(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conv),
          eq(conversationMembers.userId, invitee.userId)
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.leftAt).not.toBeNull();
  });
});

describe('sharing family: creator deletion severs shares at the public read', () => {
  it('makes a severed share unreadable end-to-end (FK cascade on createdBy → 404)', async () => {
    const owner = await newUser();
    const creator = await newUser();
    const conv = await createConversation(owner);
    await db.insert(conversationMembers).values({
      conversationId: conv,
      userId: creator.userId,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });
    const messageId = await seedMessage(conv);
    const created = await send('POST', `/conversations/${conv}/shares`, creator.cookie, {
      messageId,
      wrappedContentKey: B64,
    });
    const { shareId }: { shareId: string } = await created.json();

    // The share reads publicly while the creator exists.
    const before = await publicShareRead(shareId);
    expect(before.status).toBe(200);

    // Account deletion clears membership, then the user-row deletion cascades
    // through createdBy and severs the share.
    await db
      .delete(conversationMembers)
      .where(
        and(
          eq(conversationMembers.conversationId, conv),
          eq(conversationMembers.userId, creator.userId)
        )
      );
    await db.delete(users).where(eq(users.id, creator.userId));

    const after = await publicShareRead(shareId);
    expect(after.status).toBe(404);
    expect(await after.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});
