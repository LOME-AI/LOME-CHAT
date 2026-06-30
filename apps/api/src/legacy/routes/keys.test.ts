/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  users,
  epochs,
  epochMembers,
  conversationMembers,
  sharedLinks,
} from '@hushbox/db';
import { userFactory, sharedLinkFactory } from '@hushbox/db/factories';
import { fromBase64 } from '@hushbox/shared';
import { keysRoute } from './keys.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

interface ErrorResponse {
  code: string;
  details?: Record<string, unknown>;
}

interface KeyChainResponseBody {
  wraps: {
    epochNumber: number;
    wrap: string;
    confirmationHash: string;
    visibleFromEpoch: number;
  }[];
  chainLinks: {
    epochNumber: number;
    chainLink: string;
    confirmationHash: string;
  }[];
  currentEpoch: number;
}

interface BatchKeysResponse {
  keys: Record<string, KeyChainResponseBody>;
  missing: string[];
}

interface MemberKeysResponse {
  members: {
    memberId: string;
    userId: string | null;
    linkId: string | null;
    publicKey: string;
    privilege: string;
    visibleFromEpoch: number;
  }[];
}

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

/** Create placeholder bytes for epoch crypto fields. */
function placeholderBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = index % 256;
  }
  return bytes;
}

const mockUserStore = new Map<string, { email: string; username: string; publicKey: Uint8Array }>();

function createTestAppWithAuth(db: ReturnType<typeof createDb>): Hono<AppEnv> {
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
  app.route('/keys', keysRoute);

  return app;
}

interface CreateTestUserOptions {
  db: ReturnType<typeof createDb>;
  email: string;
  username: string;
}

async function createTestUser(options: CreateTestUserOptions): Promise<string> {
  const { db, email, username } = options;

  const userData = userFactory.build({
    email,
    username,
    emailVerified: true,
  });
  const [user] = await db.insert(users).values(userData).returning();
  if (!user) throw new Error('Failed to create test user');

  mockUserStore.set(user.id, { email, username, publicKey: user.publicKey });

  return user.id;
}

function getAuthHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

describe('keys routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;
  let otherUserId: string;
  let readMemberUserId: string;
  let nonMemberUserId: string;

  const RUN_ID = String(Date.now()).slice(-8);
  const TEST_EMAIL = `test-keys-${RUN_ID}@example.com`;
  const TEST_USERNAME = `tk_${RUN_ID}`;
  const OTHER_EMAIL = `test-keys-other-${RUN_ID}@example.com`;
  const OTHER_USERNAME = `tko_${RUN_ID}`;
  const READ_EMAIL = `test-keys-read-${RUN_ID}@example.com`;
  const READ_USERNAME = `tkr_${RUN_ID}`;
  const NON_MEMBER_EMAIL = `test-keys-nonmember-${RUN_ID}@example.com`;
  const NON_MEMBER_USERNAME = `tkn_${RUN_ID}`;

  const createdConversationIds: string[] = [];
  let conversationWithChainId: string;

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });
    app = createTestAppWithAuth(db);

    testUserId = await createTestUser({ db, email: TEST_EMAIL, username: TEST_USERNAME });
    otherUserId = await createTestUser({ db, email: OTHER_EMAIL, username: OTHER_USERNAME });
    readMemberUserId = await createTestUser({
      db,
      email: READ_EMAIL,
      username: READ_USERNAME,
    });
    nonMemberUserId = await createTestUser({
      db,
      email: NON_MEMBER_EMAIL,
      username: NON_MEMBER_USERNAME,
    });

    // --- Conversation 1: single epoch (no chain link) ---
    const conv1Id = `test-keys-conv1-${String(Date.now())}`;
    const [conv1] = await db
      .insert(conversations)
      .values({
        id: conv1Id,
        userId: testUserId,
        title: new TextEncoder().encode('Keys test conversation'),
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 1,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      })
      .returning();
    if (!conv1) throw new Error('Failed to create test conversation 1');
    createdConversationIds.push(conv1.id);

    // Epoch 1 (no chain link for first epoch)
    const [epoch1] = await db
      .insert(epochs)
      .values({
        conversationId: conv1.id,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
        chainLink: null,
      })
      .returning();
    if (!epoch1) throw new Error('Failed to create epoch 1');

    const testUserInfo = mockUserStore.get(testUserId);
    if (!testUserInfo) throw new Error('Test user not found in mock store');

    await db.insert(epochMembers).values({
      epochId: epoch1.id,
      memberPublicKey: testUserInfo.publicKey,
      wrap: placeholderBytes(48),
      visibleFromEpoch: 1,
    });

    await db.insert(conversationMembers).values({
      conversationId: conv1.id,
      userId: testUserId,
      privilege: 'owner',
      visibleFromEpoch: 1,
    });

    // --- Conversation 2: two epochs (with chain link on epoch 2) + two members ---
    const conv2Id = `test-keys-conv2-${String(Date.now())}`;
    const [conv2] = await db
      .insert(conversations)
      .values({
        id: conv2Id,
        userId: testUserId,
        title: new TextEncoder().encode('Keys test conversation with chain'),
        titleEpochNumber: 1,
        currentEpoch: 2,
        nextSequence: 1,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      })
      .returning();
    if (!conv2) throw new Error('Failed to create test conversation 2');
    createdConversationIds.push(conv2.id);
    conversationWithChainId = conv2.id;

    // Epoch 1 for conv2 (no chain link)
    const [conv2Epoch1] = await db
      .insert(epochs)
      .values({
        conversationId: conv2.id,
        epochNumber: 1,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
        chainLink: null,
      })
      .returning();
    if (!conv2Epoch1) throw new Error('Failed to create conv2 epoch 1');

    // Epoch 2 for conv2 (has chain link)
    const [conv2Epoch2] = await db
      .insert(epochs)
      .values({
        conversationId: conv2.id,
        epochNumber: 2,
        epochPublicKey: placeholderBytes(32),
        confirmationHash: placeholderBytes(32),
        chainLink: placeholderBytes(64),
      })
      .returning();
    if (!conv2Epoch2) throw new Error('Failed to create conv2 epoch 2');

    await db.insert(epochMembers).values({
      epochId: conv2Epoch1.id,
      memberPublicKey: testUserInfo.publicKey,
      wrap: placeholderBytes(48),
      visibleFromEpoch: 1,
    });
    await db.insert(epochMembers).values({
      epochId: conv2Epoch2.id,
      memberPublicKey: testUserInfo.publicKey,
      wrap: placeholderBytes(48),
      visibleFromEpoch: 1,
    });

    // Other user as a write member on conv2
    const otherUserInfo = mockUserStore.get(otherUserId);
    if (!otherUserInfo) throw new Error('Other user not found in mock store');

    // Epoch 1 wrap for otherUser — simulates stale wrap that should be filtered by visibleFromEpoch
    await db.insert(epochMembers).values({
      epochId: conv2Epoch1.id,
      memberPublicKey: otherUserInfo.publicKey,
      wrap: placeholderBytes(48),
      visibleFromEpoch: 2,
    });

    await db.insert(epochMembers).values({
      epochId: conv2Epoch2.id,
      memberPublicKey: otherUserInfo.publicKey,
      wrap: placeholderBytes(48),
      visibleFromEpoch: 2,
    });

    // Conversation members for conv2
    await db.insert(conversationMembers).values({
      conversationId: conv2.id,
      userId: testUserId,
      privilege: 'owner',
      visibleFromEpoch: 1,
    });
    await db.insert(conversationMembers).values({
      conversationId: conv2.id,
      userId: otherUserId,
      privilege: 'write',
      visibleFromEpoch: 2,
    });

    // Read-only member — covers the lowest-privilege case for /member-keys
    // access (used by the leave-rotation flow).
    await db.insert(conversationMembers).values({
      conversationId: conv2.id,
      userId: readMemberUserId,
      privilege: 'read',
      visibleFromEpoch: 2,
    });

    // Shared link member on conv2 (link member has no userId, has linkId)
    const linkData = sharedLinkFactory.build({
      conversationId: conv2.id,
    });
    const [link] = await db.insert(sharedLinks).values(linkData).returning();
    if (!link) throw new Error('Failed to create shared link');

    await db.insert(conversationMembers).values({
      conversationId: conv2.id,
      linkId: link.id,
      privilege: 'read',
      visibleFromEpoch: 2,
    });

    // Epoch member for link member on epoch 2
    await db.insert(epochMembers).values({
      epochId: conv2Epoch2.id,
      memberPublicKey: link.linkPublicKey,
      wrap: placeholderBytes(48),
      visibleFromEpoch: 2,
    });

    // Add a left member to conv2 (to verify they are excluded from member-keys)
    await db.insert(conversationMembers).values({
      conversationId: conv2.id,
      userId: nonMemberUserId,
      privilege: 'write',
      visibleFromEpoch: 1,
      leftAt: new Date('2024-06-01'),
    });
  });

  afterAll(async () => {
    // Conversations cascade delete epochs, epoch_members, conversation_members
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    const userIds = [testUserId, otherUserId, readMemberUserId, nonMemberUserId].filter(Boolean);
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  describe('GET /keys/:conversationId', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed');
      const res = await app.request(`/keys/${convId}`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when user is not a member of the conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed');
      const res = await app.request(`/keys/${convId}`, {
        headers: getAuthHeaders(nonMemberUserId),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns key chain with wraps and empty chainLinks for epoch 1', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed');
      const res = await app.request(`/keys/${convId}`, {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as KeyChainResponseBody;

      // Single epoch, so one wrap
      expect(json.wraps).toHaveLength(1);
      const wrap0 = json.wraps[0]!;
      expect(wrap0.epochNumber).toBe(1);
      expect(wrap0.visibleFromEpoch).toBe(1);

      // Wrap should be base64 encoded
      expect(typeof wrap0.wrap).toBe('string');
      const wrapBytes = fromBase64(wrap0.wrap);
      expect(wrapBytes.length).toBe(48);

      // Confirmation hash should be base64 encoded
      expect(typeof wrap0.confirmationHash).toBe('string');
      const hashBytes = fromBase64(wrap0.confirmationHash);
      expect(hashBytes.length).toBe(32);

      // No chain links for epoch 1 (first epoch has no chain link)
      expect(json.chainLinks).toHaveLength(0);

      // Current epoch
      expect(json.currentEpoch).toBe(1);
    });

    it('returns wraps and chain links for multi-epoch conversation', async () => {
      const res = await app.request(`/keys/${conversationWithChainId}`, {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as KeyChainResponseBody;

      // Two epochs, so two wraps for testUser
      expect(json.wraps).toHaveLength(2);
      const wrap0 = json.wraps[0]!;
      const wrap1 = json.wraps[1]!;
      expect(wrap0.epochNumber).toBe(1);
      expect(wrap1.epochNumber).toBe(2);

      // Both wraps are base64 encoded
      expect(typeof wrap0.wrap).toBe('string');
      expect(typeof wrap1.wrap).toBe('string');

      // Wraps include confirmationHash
      expect(typeof wrap0.confirmationHash).toBe('string');
      expect(typeof wrap1.confirmationHash).toBe('string');
      const hashBytes = fromBase64(wrap0.confirmationHash);
      expect(hashBytes.length).toBe(32);

      // One chain link (epoch 2 has a chain link)
      expect(json.chainLinks).toHaveLength(1);
      const chainLink0 = json.chainLinks[0]!;
      expect(chainLink0.epochNumber).toBe(2);
      expect(typeof chainLink0.chainLink).toBe('string');
      const chainLinkBytes = fromBase64(chainLink0.chainLink);
      expect(chainLinkBytes.length).toBe(64);

      // Chain link includes confirmationHash
      expect(typeof chainLink0.confirmationHash).toBe('string');
      const chainHashBytes = fromBase64(chainLink0.confirmationHash);
      expect(chainHashBytes.length).toBe(32);

      // Current epoch is 2
      expect(json.currentEpoch).toBe(2);
    });

    it('excludes wraps for epochs before visibleFromEpoch', async () => {
      // otherUser has wraps on both epochs 1 and 2, but visibleFromEpoch=2
      // Should only receive epoch 2 wrap
      const res = await app.request(`/keys/${conversationWithChainId}`, {
        headers: getAuthHeaders(otherUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as KeyChainResponseBody;

      // Only epoch 2 wrap should be returned (epoch 1 filtered by visibleFromEpoch)
      expect(json.wraps).toHaveLength(1);
      expect(json.wraps[0]!.epochNumber).toBe(2);
      expect(json.wraps[0]!.visibleFromEpoch).toBe(2);

      // Chain link for epoch 2 excluded (2 > 2 = false) — it connects to epoch 1, before visibility boundary
      expect(json.chainLinks).toHaveLength(0);
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/keys/non-existent-conversation-id', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });
  });

  describe('GET /keys/:conversationId/member-keys', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed');
      const res = await app.request(`/keys/${convId}/member-keys`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when user is not a member', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed');
      const res = await app.request(`/keys/${convId}/member-keys`, {
        headers: getAuthHeaders(nonMemberUserId),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('allows write-privileged members to fetch keys (needed for leave rotation)', async () => {
      // otherUserId is set up as a 'write' member of conversationWithChainId.
      // A non-owner leave generates a rotation, which requires this endpoint
      // — so locking it to admin+ would prevent regular members from leaving.
      const res = await app.request(`/keys/${conversationWithChainId}/member-keys`, {
        headers: getAuthHeaders(otherUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as MemberKeysResponse;
      expect(json.members.length).toBeGreaterThan(0);
    });

    it('allows read-privileged members to fetch keys (lowest tier can still leave)', async () => {
      // readMemberUserId is set up as a 'read' member of conversationWithChainId.
      // Read is the lowest privilege level; if this passes, every member of
      // the conversation can perform their own leave-with-rotation.
      const res = await app.request(`/keys/${conversationWithChainId}/member-keys`, {
        headers: getAuthHeaders(readMemberUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as MemberKeysResponse;
      expect(json.members.length).toBeGreaterThan(0);
    });

    it('returns member public keys with base64 encoding', async () => {
      const res = await app.request(`/keys/${conversationWithChainId}/member-keys`, {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as MemberKeysResponse;

      // Conv2 has 4 active members: testUser (owner) + otherUser (write) +
      // readMember (read) + link member.
      expect(json.members).toHaveLength(4);

      // Verify each member has expected fields
      for (const member of json.members) {
        expect(typeof member.memberId).toBe('string');
        expect(typeof member.publicKey).toBe('string');
        expect(typeof member.privilege).toBe('string');
        expect(typeof member.visibleFromEpoch).toBe('number');

        // publicKey should be valid base64
        const keyBytes = fromBase64(member.publicKey);
        expect(keyBytes.length).toBeGreaterThan(0);
      }

      // Verify correct user IDs are present (user members)
      const userMembers = json.members.filter((m) => m.userId !== null);
      const memberUserIds = userMembers.map((m) => m.userId);
      expect(memberUserIds).toContain(testUserId);
      expect(memberUserIds).toContain(otherUserId);

      // Verify privileges
      const ownerMember = json.members.find((m) => m.userId === testUserId);
      expect(ownerMember?.privilege).toBe('owner');
      const writeMember = json.members.find((m) => m.userId === otherUserId);
      expect(writeMember?.privilege).toBe('write');
    });

    it('returns only active members (excludes left members)', async () => {
      const res = await app.request(`/keys/${conversationWithChainId}/member-keys`, {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as MemberKeysResponse;

      // nonMemberUser left the conversation, so they should not appear
      const memberUserIds = json.members.map((m) => m.userId).filter(Boolean);
      expect(memberUserIds).not.toContain(nonMemberUserId);
    });

    it('includes link members alongside user members', async () => {
      const res = await app.request(`/keys/${conversationWithChainId}/member-keys`, {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as MemberKeysResponse;

      // Conv2 has 3 user members (owner/write/read) + 1 link member = 4
      // active members.
      expect(json.members).toHaveLength(4);

      // Find the link member (userId is null, linkId is not null)
      const linkMember = json.members.find((m) => m.userId === null);
      expect(linkMember).toBeDefined();
      expect(linkMember!.linkId).not.toBeNull();
      expect(typeof linkMember!.publicKey).toBe('string');
      expect(linkMember!.privilege).toBe('read');

      // publicKey should be valid base64
      const keyBytes = fromBase64(linkMember!.publicKey);
      expect(keyBytes.length).toBeGreaterThan(0);
    });

    it('returns memberId, linkId, and visibleFromEpoch for all members', async () => {
      const res = await app.request(`/keys/${conversationWithChainId}/member-keys`, {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as MemberKeysResponse;

      for (const member of json.members) {
        expect(typeof member.memberId).toBe('string');
        expect(typeof member.visibleFromEpoch).toBe('number');
        // Every member has either userId or linkId, not both
        const hasUserId = member.userId !== null;
        const hasLinkId = member.linkId !== null;
        expect(hasUserId || hasLinkId).toBe(true);
        expect(hasUserId && hasLinkId).toBe(false);
      }

      // User members have correct visibleFromEpoch
      const ownerMember = json.members.find((m) => m.userId === testUserId);
      expect(ownerMember!.visibleFromEpoch).toBe(1);
      const writeMember = json.members.find((m) => m.userId === otherUserId);
      expect(writeMember!.visibleFromEpoch).toBe(2);

      // Link member has correct visibleFromEpoch
      const linkMember = json.members.find((m) => m.userId === null);
      expect(linkMember!.visibleFromEpoch).toBe(2);
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/keys/non-existent-conversation-id/member-keys', {
        headers: getAuthHeaders(testUserId),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('CONVERSATION_NOT_FOUND');
    });
  });

  describe('POST /keys/batch', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationIds: [createdConversationIds[0]] }),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns key chains for multiple conversations in one call', async () => {
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(testUserId),
        },
        body: JSON.stringify({ conversationIds: createdConversationIds }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as BatchKeysResponse;

      // Both conversations should be present
      expect(Object.keys(json.keys)).toHaveLength(2);
      // No missing entries when caller has access to all ids
      expect(json.missing).toEqual([]);

      // Conv1: single epoch
      const conv1Id = createdConversationIds[0]!;
      const conv1Keys = json.keys[conv1Id]!;
      expect(conv1Keys.wraps).toHaveLength(1);
      expect(conv1Keys.wraps[0]!.epochNumber).toBe(1);
      expect(conv1Keys.chainLinks).toHaveLength(0);
      expect(conv1Keys.currentEpoch).toBe(1);

      // Conv2: two epochs with chain link
      const conv2Keys = json.keys[conversationWithChainId]!;
      expect(conv2Keys.wraps).toHaveLength(2);
      expect(conv2Keys.chainLinks).toHaveLength(1);
      expect(conv2Keys.currentEpoch).toBe(2);
    });

    it('returns 200 with empty keys and all ids as missing when user is not a member of any requested conversation', async () => {
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(nonMemberUserId),
        },
        body: JSON.stringify({ conversationIds: createdConversationIds }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as BatchKeysResponse;
      expect(json.keys).toEqual({});
      expect([...json.missing].toSorted((a, b) => a.localeCompare(b))).toEqual(
        [...createdConversationIds].toSorted((a, b) => a.localeCompare(b))
      );
    });

    it('returns accessible keys and lists unauthorized ids in missing when user is member of only some requested conversations', async () => {
      // otherUser is a member of conv2 only — partial-success contract avoids
      // the membership-vs-cache race condition that produced 404s in the
      // /api/keys/batch frontend hook under WebSocket-driven epoch changes.
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(otherUserId),
        },
        body: JSON.stringify({ conversationIds: createdConversationIds }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as BatchKeysResponse;

      expect(Object.keys(json.keys)).toEqual([conversationWithChainId]);
      expect(json.missing).toEqual([createdConversationIds[0]]);
    });

    it('returns keys when user requests only conversations they are a member of', async () => {
      // otherUser is a member of conv2 only — requesting just conv2 succeeds
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(otherUserId),
        },
        body: JSON.stringify({ conversationIds: [conversationWithChainId] }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as BatchKeysResponse;

      // Only conv2 should be returned
      expect(Object.keys(json.keys)).toHaveLength(1);
      expect(json.keys[conversationWithChainId]).toBeDefined();
      expect(json.missing).toEqual([]);

      // otherUser has visibleFromEpoch=2, so only epoch 2 wrap
      const conv2Keys = json.keys[conversationWithChainId]!;
      expect(conv2Keys.wraps).toHaveLength(1);
      expect(conv2Keys.wraps[0]!.epochNumber).toBe(2);
    });

    it('returns 200 with id reported as missing for a non-existent conversation ID', async () => {
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(testUserId),
        },
        body: JSON.stringify({ conversationIds: ['non-existent-id'] }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as BatchKeysResponse;
      expect(json.keys).toEqual({});
      expect(json.missing).toEqual(['non-existent-id']);
    });

    it('rejects request with more than 100 conversation IDs', async () => {
      const tooManyIds = Array.from({ length: 101 }, (_, index) => `conv-${String(index)}`);
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(testUserId),
        },
        body: JSON.stringify({ conversationIds: tooManyIds }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects request with empty conversationIds array', async () => {
      const res = await app.request('/keys/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(testUserId),
        },
        body: JSON.stringify({ conversationIds: [] }),
      });

      expect(res.status).toBe(400);
    });
  });
});
