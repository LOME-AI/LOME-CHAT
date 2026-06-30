/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  messages,
  contentItems,
  users,
  epochs,
  epochMembers,
  conversationMembers,
  conversationForks,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { forksRoute } from './forks.js';
import type { ForkResponse } from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

interface ErrorResponse {
  code: string;
  details?: Record<string, unknown>;
}

interface CreateForkResponse {
  forks: ForkResponse[];
  isNew: boolean;
}

interface DeleteForkResponse {
  remainingForks: { id: string; name: string; tipMessageId: string | null }[];
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

function toBytes(string_: string): Uint8Array {
  return new TextEncoder().encode(string_);
}

function placeholderBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = index % 256;
  }
  return bytes;
}

const mockUserStore = new Map<string, { email: string; username: string; publicKey: Uint8Array }>();

function createTestApp(db: ReturnType<typeof createDb>): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);

    const testUserId = c.req.header('X-Test-User-Id');
    if (testUserId) {
      const userInfo = mockUserStore.get(testUserId);
      if (userInfo) {
        const sessionData: SessionData = {
          sessionId: `session-${testUserId}`,
          userId: testUserId,
          email: userInfo.email,
          username: userInfo.username,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('user', {
          id: testUserId,
          email: userInfo.email,
          username: userInfo.username,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: userInfo.publicKey,
        });
        c.set('session', sessionData);
        c.set('sessionData', sessionData);
      }
    } else {
      c.set('user', null);
      c.set('session', null);
      c.set('sessionData', null);
    }
    await next();
  });
  app.route('/forks', forksRoute);
  return app;
}

async function createTestUser(
  db: ReturnType<typeof createDb>,
  email: string,
  username: string
): Promise<string> {
  const userData = userFactory.build({ email, username, emailVerified: true });
  const [user] = await db.insert(users).values(userData).returning();
  if (!user) throw new Error('Failed to create test user');
  mockUserStore.set(user.id, { email, username, publicKey: user.publicKey });
  return user.id;
}

function getAuthHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

describe('fork routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let ownerId: string;
  let memberId: string;
  let convId: string;
  let msgId1: string;
  let msgId2: string;
  let msgId3: string;

  const RUN_ID = String(Date.now());
  const cleanupConvIds: string[] = [];
  const cleanupUserIds: string[] = [];

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    app = createTestApp(db);

    ownerId = await createTestUser(db, `fork-owner-${RUN_ID}@test.com`, `fo_${RUN_ID}`);
    memberId = await createTestUser(db, `fork-member-${RUN_ID}@test.com`, `fm_${RUN_ID}`);
    cleanupUserIds.push(ownerId, memberId);

    // Generate proper UUIDs for message IDs (schema validates z.uuid())
    msgId1 = crypto.randomUUID();
    msgId2 = crypto.randomUUID();
    msgId3 = crypto.randomUUID();

    convId = crypto.randomUUID();
    cleanupConvIds.push(convId);

    await db.insert(conversations).values({
      id: convId,
      userId: ownerId,
      title: toBytes('Fork test conversation'),
      titleEpochNumber: 1,
      currentEpoch: 1,
      nextSequence: 4,
    });

    const [epoch] = await db
      .insert(epochs)
      .values({
        conversationId: convId,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
      })
      .returning();

    if (epoch) {
      const ownerInfo = mockUserStore.get(ownerId);
      if (ownerInfo) {
        await db.insert(epochMembers).values({
          epochId: epoch.id,
          memberPublicKey: ownerInfo.publicKey,
          wrap: placeholderBytes(48),
          visibleFromEpoch: 1,
        });
      }
    }

    await db.insert(conversationMembers).values({
      conversationId: convId,
      userId: ownerId,
      privilege: 'owner',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    await db.insert(conversationMembers).values({
      conversationId: convId,
      userId: memberId,
      privilege: 'write',
      visibleFromEpoch: 1,
      acceptedAt: new Date(),
    });

    // Create messages: m1 (user) → m2 (ai) → m3 (user) under the wrap-once envelope model.
    await db.insert(messages).values([
      {
        id: msgId1,
        conversationId: convId,
        wrappedContentKey: placeholderBytes(81),
        senderType: 'user',
        senderId: ownerId,
        epochNumber: 1,
        sequenceNumber: 1,
        parentMessageId: null,
      },
      {
        id: msgId2,
        conversationId: convId,
        wrappedContentKey: placeholderBytes(81),
        senderType: 'ai',
        epochNumber: 1,
        sequenceNumber: 2,
        parentMessageId: msgId1,
      },
      {
        id: msgId3,
        conversationId: convId,
        wrappedContentKey: placeholderBytes(81),
        senderType: 'user',
        senderId: ownerId,
        epochNumber: 1,
        sequenceNumber: 3,
        parentMessageId: msgId2,
      },
    ]);
    await db.insert(contentItems).values([
      {
        messageId: msgId1,
        contentType: 'text',
        position: 0,
        encryptedBlob: toBytes('message-1'),
        isSmartModel: false,
      },
      {
        messageId: msgId2,
        contentType: 'text',
        position: 0,
        encryptedBlob: toBytes('message-2'),
        modelName: 'test-model',
        isSmartModel: false,
      },
      {
        messageId: msgId3,
        contentType: 'text',
        position: 0,
        encryptedBlob: toBytes('message-3'),
        isSmartModel: false,
      },
    ]);
  });

  afterAll(async () => {
    // Clean up forks first (FK to messages), then messages cascade with conversations
    for (const cId of cleanupConvIds) {
      await db.delete(conversationForks).where(eq(conversationForks.conversationId, cId));
    }
    if (cleanupConvIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, cleanupConvIds));
    }
    if (cleanupUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, cleanupUserIds));
    }
  });

  describe('POST /forks/:conversationId', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request(`/forks/${convId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          fromMessageId: msgId2,
        }),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 for non-member', async () => {
      const nonMemberId = await createTestUser(
        db,
        `fork-nonmember-${RUN_ID}@test.com`,
        `fnm_${RUN_ID}`
      );
      cleanupUserIds.push(nonMemberId);

      const res = await app.request(`/forks/${convId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(nonMemberId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          fromMessageId: msgId2,
        }),
      });

      expect(res.status).toBe(404);
    });

    it('creates fork with Main + Fork 1 when no forks exist', async () => {
      const forkId = crypto.randomUUID();

      const res = await app.request(`/forks/${convId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(ownerId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: forkId,
          fromMessageId: msgId2,
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateForkResponse;
      expect(json.isNew).toBe(true);
      expect(json.forks).toHaveLength(2);

      const names = json.forks.map((f) => f.name);
      expect(names).toContain('Main');
      expect(names).toContain('Fork 1');

      // Main tip = latest message (msgId3)
      const mainFork = json.forks.find((f) => f.name === 'Main');
      expect(mainFork?.tipMessageId).toBe(msgId3);

      // Fork 1 tip = fromMessageId (msgId2)
      const fork1 = json.forks.find((f) => f.name === 'Fork 1');
      expect(fork1?.tipMessageId).toBe(msgId2);
      expect(fork1?.id).toBe(forkId);
    });

    it('returns existing forks idempotently when same fork ID provided', async () => {
      const forks = await db
        .select({ id: conversationForks.id })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));

      const existingForkId = forks[0]?.id;
      if (!existingForkId) throw new Error('Expected fork to exist from previous test');

      const res = await app.request(`/forks/${convId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(ownerId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: existingForkId,
          fromMessageId: msgId1,
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as CreateForkResponse;
      expect(json.isNew).toBe(false);
      expect(json.forks).toHaveLength(2);
    });

    it('creates fork with custom name', async () => {
      const forkId = crypto.randomUUID();

      const res = await app.request(`/forks/${convId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(ownerId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: forkId,
          fromMessageId: msgId1,
          name: 'My Branch',
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateForkResponse;
      expect(json.isNew).toBe(true);
      const customFork = json.forks.find((f) => f.name === 'My Branch');
      expect(customFork).toBeDefined();
      expect(customFork?.id).toBe(forkId);
    });

    it('write member can create fork', async () => {
      const forkId = crypto.randomUUID();

      const res = await app.request(`/forks/${convId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(memberId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: forkId,
          fromMessageId: msgId2,
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateForkResponse;
      expect(json.isNew).toBe(true);
    });

    it('returns error for duplicate fork name', async () => {
      const res = await app.request(`/forks/${convId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(ownerId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          fromMessageId: msgId1,
          name: 'Main',
        }),
      });

      expect(res.status).toBe(409);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('FORK_NAME_TAKEN');
    });
  });

  describe('PATCH /forks/:conversationId/:forkId', () => {
    it('returns 401 when not authenticated', async () => {
      const forks = await db
        .select({ id: conversationForks.id })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));
      const forkId = forks[0]?.id;
      if (!forkId) throw new Error('No fork found');

      const res = await app.request(`/forks/${convId}/${forkId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(401);
    });

    it('renames fork successfully', async () => {
      const forks = await db
        .select({ id: conversationForks.id, name: conversationForks.name })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));
      const myBranch = forks.find((f) => f.name === 'My Branch');
      if (!myBranch) throw new Error('Expected My Branch fork');

      const res = await app.request(`/forks/${convId}/${myBranch.id}`, {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders(ownerId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Renamed Branch' }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { renamed: boolean };
      expect(json.renamed).toBe(true);

      // Verify in DB
      const [updated] = await db
        .select({ name: conversationForks.name })
        .from(conversationForks)
        .where(eq(conversationForks.id, myBranch.id));
      expect(updated?.name).toBe('Renamed Branch');
    });

    it('returns 409 for duplicate name on rename', async () => {
      const forks = await db
        .select({ id: conversationForks.id, name: conversationForks.name })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));
      const nonMainFork = forks.find((f) => f.name !== 'Main');
      if (!nonMainFork) throw new Error('Expected non-Main fork');

      const res = await app.request(`/forks/${convId}/${nonMainFork.id}`, {
        method: 'PATCH',
        headers: {
          ...getAuthHeaders(ownerId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Main' }),
      });

      expect(res.status).toBe(409);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('FORK_NAME_TAKEN');
    });
  });

  describe('DELETE /forks/:conversationId/:forkId', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request(`/forks/${convId}/some-fork-id`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
    });

    it('deletes fork and returns remaining forks', async () => {
      // Find a non-Main fork to delete
      const forks = await db
        .select({ id: conversationForks.id, name: conversationForks.name })
        .from(conversationForks)
        .where(eq(conversationForks.conversationId, convId));
      const toDelete = forks.find((f) => f.name === 'Renamed Branch');
      if (!toDelete) throw new Error('Expected Renamed Branch fork');

      const res = await app.request(`/forks/${convId}/${toDelete.id}`, {
        method: 'DELETE',
        headers: getAuthHeaders(ownerId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as DeleteForkResponse;
      const names = json.remainingForks.map((f) => f.name);
      expect(names).not.toContain('Renamed Branch');
    });

    it('returns 200 idempotently when fork already deleted', async () => {
      const nonexistentId = crypto.randomUUID();

      const res = await app.request(`/forks/${convId}/${nonexistentId}`, {
        method: 'DELETE',
        headers: getAuthHeaders(ownerId),
      });

      expect(res.status).toBe(200);
    });
  });

  describe('solo conversation owner (with conversationMembers row)', () => {
    let soloConvId: string;
    let soloMsgId: string;

    beforeAll(async () => {
      soloConvId = crypto.randomUUID();
      soloMsgId = crypto.randomUUID();
      cleanupConvIds.push(soloConvId);

      await db.insert(conversations).values({
        id: soloConvId,
        userId: ownerId,
        title: toBytes('Solo fork test'),
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 2,
      });

      const [epoch] = await db
        .insert(epochs)
        .values({
          conversationId: soloConvId,
          epochNumber: 1,
          epochPublicKey: placeholderBytes(32),
          confirmationHash: placeholderBytes(32),
        })
        .returning();

      if (epoch) {
        const ownerInfo = mockUserStore.get(ownerId);
        if (ownerInfo) {
          await db.insert(epochMembers).values({
            epochId: epoch.id,
            memberPublicKey: ownerInfo.publicKey,
            wrap: placeholderBytes(48),
            visibleFromEpoch: 1,
          });
        }
      }

      // Owner has a conversationMembers row (standard path)
      await db.insert(conversationMembers).values({
        conversationId: soloConvId,
        userId: ownerId,
        privilege: 'owner',
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
      });

      await db.insert(messages).values({
        id: soloMsgId,
        conversationId: soloConvId,
        wrappedContentKey: placeholderBytes(81),
        senderType: 'user',
        senderId: ownerId,
        epochNumber: 1,
        sequenceNumber: 1,
        parentMessageId: null,
      });
      await db.insert(contentItems).values({
        messageId: soloMsgId,
        contentType: 'text',
        position: 0,
        encryptedBlob: toBytes('solo message'),
        isSmartModel: false,
      });
    });

    it('allows owner to create fork via conversationMembers row', async () => {
      const forkId = crypto.randomUUID();

      const res = await app.request(`/forks/${soloConvId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(ownerId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: forkId,
          fromMessageId: soloMsgId,
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateForkResponse;
      expect(json.isNew).toBe(true);
      expect(json.forks).toHaveLength(2);

      const names = json.forks.map((f) => f.name);
      expect(names).toContain('Main');
      expect(names).toContain('Fork 1');
    });

    it('rejects non-owner non-member on solo conversation', async () => {
      const res = await app.request(`/forks/${soloConvId}`, {
        method: 'POST',
        headers: {
          ...getAuthHeaders(memberId),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: crypto.randomUUID(),
          fromMessageId: soloMsgId,
        }),
      });

      expect(res.status).toBe(404);
    });
  });
});
