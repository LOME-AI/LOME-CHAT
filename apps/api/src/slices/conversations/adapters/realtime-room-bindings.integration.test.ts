import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  users,
} from '@hushbox/db';
import { createMembershipRevoker, membershipCacheKey } from './membership.js';
import { createRoomBindings, openRoomSourceDb } from './realtime-room-bindings.js';
import type { CreateRoomRuntime } from './realtime-room-bindings.js';
import type { Bindings } from '../../../lib/context/index.js';

/**
 * A runtime factory double: this suite exercises the verifier the room
 * composes, not the injected runtime, so the executor/binder/referee are stubs
 * (the real runtime is wired by the app root, and needs no OPENROUTER key here).
 */
const fakeRuntime: CreateRoomRuntime = () => ({
  executor: {
    start: () => {
      throw new Error('unused in verifier tests');
    },
  },
  bindHooks: () => ({
    admission: () => Promise.resolve({ admitted: false, code: 'INTERNAL' }),
    settlement: () => Promise.resolve(),
  }),
  claimRun: () => Promise.resolve({ outcome: 'attach' }),
  releaseHold: () => Promise.resolve(),
  heartbeat: () => Promise.resolve('alive'),
  failRun: () => Promise.resolve(),
});

// The realtime barrel transitively imports the workerd-only platform module;
// stubbed in node — the DO class itself is not under test, the composed
// verifier the room receives is.
vi.mock('cloudflare:workers', () => ({
  // Never instantiated here — the stub only satisfies `extends` at load time.
  DurableObject: class {
    constructor(protected readonly ctx: unknown) {}
  },
}));

const NODE_ENV = process.env['NODE_ENV'];
const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!NODE_ENV || !DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('NODE_ENV, DATABASE_URL and UPSTASH_REDIS_* are required for room binding tests');
}

const ENV: Bindings = {
  NODE_ENV,
  ...(process.env['CI'] === undefined ? {} : { CI: process.env['CI'] }),
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
const createdRedisKeys: string[] = [];

async function seedMemberConversation(): Promise<{ userId: string; conversationId: string }> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const userRows = await db
    .insert(users)
    .values({
      email: `${username}@room-bindings.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = userRows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  await db.insert(conversationMembers).values({
    conversationId,
    userId,
    privilege: 'owner',
    visibleFromEpoch: 1,
    acceptedAt: new Date(),
  });
  createdRedisKeys.push(membershipCacheKey.buildKey(conversationId, userId));
  return { userId, conversationId };
}

afterAll(async () => {
  if (createdRedisKeys.length > 0) await redis.del(...createdRedisKeys);
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('openRoomSourceDb', () => {
  it('builds a local-proxy client in dev and a direct client otherwise', async () => {
    const dev = openRoomSourceDb(DATABASE_URL, { isDev: true });
    const production = openRoomSourceDb(DATABASE_URL, { isDev: false });
    expect(dev).toBeDefined();
    expect(production).toBeDefined();
    await dev.$client.end();
    await production.$client.end();
  });
});

describe('createRoomBindings verifier composition (the DO binding site)', () => {
  it('verifies an active member against the real cache and source', async () => {
    const { userId, conversationId } = await seedMemberConversation();
    const bindings = createRoomBindings(ENV, fakeRuntime);
    expect(await bindings.verifier.verify(conversationId, userId)).toBe('member');
  });

  it('answers revoked for a removed member after eviction invalidates the cache', async () => {
    const { userId, conversationId } = await seedMemberConversation();
    expect(await createRoomBindings(ENV, fakeRuntime).verifier.verify(conversationId, userId)).toBe(
      'member'
    );

    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(inArray(conversationMembers.conversationId, [conversationId]));
    const invalidated = await createMembershipRevoker(redis).invalidate(conversationId, userId);
    invalidated._unsafeUnwrap();

    // A fresh DO instance (deploy/eviction) holds no in-memory memo; the
    // composed cache+source path must answer the authoritative revocation.
    expect(await createRoomBindings(ENV, fakeRuntime).verifier.verify(conversationId, userId)).toBe(
      'revoked'
    );
  });
});
