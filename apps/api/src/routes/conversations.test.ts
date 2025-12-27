/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  conversations,
  messages,
  users,
  accounts,
  sessions,
} from '@lome-chat/db';
import { createConversationsRoutes } from './conversations.js';
import { createAuthRoutes } from './auth.js';
import { createAuth } from '../auth/index.js';
import { createMockEmailClient } from '../services/email/index.js';
import { sessionMiddleware } from '../middleware/dependencies.js';
import type { AppEnv } from '../types.js';

// Response types for type-safe JSON parsing
interface SignupResponse {
  user?: { id: string };
}

interface ErrorResponse {
  error: string;
}

interface Conversation {
  id: string;
  title: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
}

interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  model?: string | null;
}

interface ConversationsListResponse {
  conversations: Conversation[];
}

interface ConversationDetailResponse {
  conversation: Conversation;
  messages: Message[];
}

interface CreateConversationResponse {
  conversation: Conversation;
  message?: Message;
}

interface UpdateConversationResponse {
  conversation: Conversation;
}

interface DeleteConversationResponse {
  deleted: boolean;
}

interface CreateMessageResponse {
  message: Message;
}

describe('conversations routes', () => {
  const connectionString =
    process.env['DATABASE_URL'] ?? 'postgres://postgres:postgres@localhost:4444/lome_chat';
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;
  let authCookie: string;

  const TEST_EMAIL = `test-conv-${String(Date.now())}@example.com`;
  const TEST_PASSWORD = 'TestPassword123!';
  const TEST_NAME = 'Test Conv User';

  // Track created IDs for cleanup
  const createdConversationIds: string[] = [];
  const createdMessageIds: string[] = [];

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });

    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-characters-long',
      frontendUrl: 'http://localhost:5173',
    });

    // Create the app with auth and conversation routes
    app = new Hono<AppEnv>();
    // Set db and auth on context for all routes
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('auth', auth);
      await next();
    });
    app.use('*', sessionMiddleware());
    app.route('/api/auth', createAuthRoutes(auth));
    app.route('/conversations', createConversationsRoutes());

    // Create user via HTTP request to auth endpoint
    const signupRes = await app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        name: TEST_NAME,
      }),
    });

    if (!signupRes.ok) {
      throw new Error(`Signup failed: ${await signupRes.text()}`);
    }

    const signupData = (await signupRes.json()) as SignupResponse;
    testUserId = signupData.user?.id ?? '';
    if (!testUserId) {
      throw new Error('Signup failed - no user ID returned');
    }

    // Mark email as verified (bypass email verification for testing)
    await db.update(users).set({ emailVerified: true }).where(eq(users.id, testUserId));

    // Now sign in to get a session cookie
    const signinRes = await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
      }),
    });

    if (!signinRes.ok) {
      throw new Error(`Signin failed: ${await signinRes.text()}`);
    }

    const setCookie = signinRes.headers.get('set-cookie');
    if (setCookie) {
      authCookie = setCookie.split(';')[0] ?? '';
    } else {
      throw new Error('Signin succeeded but no session cookie returned');
    }

    // Create test conversations
    const [conv1] = await db
      .insert(conversations)
      .values({
        id: `test-conv-1-${String(Date.now())}`,
        userId: testUserId,
        title: 'First conversation',
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
      })
      .returning();
    if (conv1) createdConversationIds.push(conv1.id);

    const [conv2] = await db
      .insert(conversations)
      .values({
        id: `test-conv-2-${String(Date.now())}`,
        userId: testUserId,
        title: 'Second conversation',
        createdAt: new Date('2024-01-02'),
        updatedAt: new Date('2024-01-03'),
      })
      .returning();
    if (conv2) createdConversationIds.push(conv2.id);

    // Create test messages
    if (conv1) {
      const [msg1] = await db
        .insert(messages)
        .values({
          conversationId: conv1.id,
          role: 'user',
          content: 'Hello',
        })
        .returning();
      if (msg1) createdMessageIds.push(msg1.id);

      const [msg2] = await db
        .insert(messages)
        .values({
          conversationId: conv1.id,
          role: 'assistant',
          content: 'Hi there!',
          model: 'gpt-4',
        })
        .returning();
      if (msg2) createdMessageIds.push(msg2.id);
    }
  });

  afterAll(async () => {
    // Clean up test data in correct order (due to FK constraints)
    if (createdMessageIds.length > 0) {
      await db.delete(messages).where(inArray(messages.id, createdMessageIds));
    }
    if (createdConversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (testUserId) {
      await db.delete(sessions).where(eq(sessions.userId, testUserId));
      await db.delete(accounts).where(eq(accounts.userId, testUserId));
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  describe('GET /conversations', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/conversations');

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Unauthorized');
    });

    it('returns list of conversations for authenticated user', async () => {
      const res = await app.request('/conversations', {
        headers: {
          Cookie: authCookie,
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationsListResponse;
      expect(json.conversations).toBeDefined();
      expect(Array.isArray(json.conversations)).toBe(true);
      expect(json.conversations.length).toBeGreaterThanOrEqual(2);

      // Verify conversations are ordered by updatedAt DESC
      const conv1 = json.conversations.find((c) => c.title === 'First conversation');
      const conv2 = json.conversations.find((c) => c.title === 'Second conversation');
      expect(conv1).toBeDefined();
      expect(conv2).toBeDefined();

      // Second conversation should come first (newer updatedAt)
      const conv1Index = json.conversations.findIndex((c) => c.title === 'First conversation');
      const conv2Index = json.conversations.findIndex((c) => c.title === 'Second conversation');
      expect(conv2Index).toBeLessThan(conv1Index);
    });
  });

  describe('GET /conversations/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`);

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/conversations/non-existent-id', {
        headers: {
          Cookie: authCookie,
        },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('returns conversation with messages for authenticated user', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        headers: {
          Cookie: authCookie,
        },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationDetailResponse;

      expect(json.conversation).toBeDefined();
      expect(json.conversation.id).toBe(convId);
      expect(json.conversation.title).toBe('First conversation');

      expect(json.messages).toBeDefined();
      expect(Array.isArray(json.messages)).toBe(true);
      expect(json.messages.length).toBe(2);

      // Verify message structure
      const userMsg = json.messages.find((m) => m.role === 'user');
      const assistantMsg = json.messages.find((m) => m.role === 'assistant');
      expect(userMsg?.content).toBe('Hello');
      expect(assistantMsg?.content).toBe('Hi there!');
      expect(assistantMsg?.model).toBe('gpt-4');
    });
  });

  describe('POST /conversations', () => {
    it('returns 401 when not authenticated', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Unauthorized');
    });

    it('creates conversation with "New Conversation" title by default', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateConversationResponse;
      expect(json.conversation).toBeDefined();
      expect(json.conversation.title).toBe('New Conversation');
      expect(json.conversation.userId).toBe(testUserId);
      expect(json.message).toBeUndefined();

      // Track for cleanup
      createdConversationIds.push(json.conversation.id);
    });

    it('creates conversation with provided title', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'My Chat' }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateConversationResponse;
      expect(json.conversation.title).toBe('My Chat');

      // Track for cleanup
      createdConversationIds.push(json.conversation.id);
    });

    it('creates conversation with first message and explicit title', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Chat with message',
          firstMessage: { content: 'Hello AI!' },
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateConversationResponse;
      expect(json.conversation.title).toBe('Chat with message');
      expect(json.message).toBeDefined();
      expect(json.message?.content).toBe('Hello AI!');
      expect(json.message?.role).toBe('user');

      // Track for cleanup
      createdConversationIds.push(json.conversation.id);
      if (json.message) createdMessageIds.push(json.message.id);
    });

    it('auto-generates title from first message content when no title provided', async () => {
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          firstMessage: { content: 'What is the capital of France?' },
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateConversationResponse;
      expect(json.conversation.title).toBe('What is the capital of France?');
      expect(json.message).toBeDefined();
      expect(json.message?.content).toBe('What is the capital of France?');

      // Track for cleanup
      createdConversationIds.push(json.conversation.id);
      if (json.message) createdMessageIds.push(json.message.id);
    });

    it('truncates auto-generated title to 50 characters', async () => {
      const longMessage =
        'This is a very long message that should be truncated when used as the conversation title because it exceeds 50 characters';
      const res = await app.request('/conversations', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          firstMessage: { content: longMessage },
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateConversationResponse;
      expect(json.conversation.title).toBe('This is a very long message that should be truncat...');
      expect(json.conversation.title.length).toBeLessThanOrEqual(53); // 50 chars + "..."

      // Track for cleanup
      createdConversationIds.push(json.conversation.id);
      if (json.message) createdMessageIds.push(json.message.id);
    });
  });

  describe('DELETE /conversations/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/conversations/non-existent-id', {
        method: 'DELETE',
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('deletes conversation and returns success', async () => {
      // Create a conversation to delete
      const createRes = await app.request('/conversations', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'To be deleted' }),
      });
      const createJson = (await createRes.json()) as CreateConversationResponse;
      const convId = createJson.conversation.id;

      // Delete it
      const res = await app.request(`/conversations/${convId}`, {
        method: 'DELETE',
        headers: { Cookie: authCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as DeleteConversationResponse;
      expect(json.deleted).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/conversations/${convId}`, {
        headers: { Cookie: authCookie },
      });
      expect(getRes.status).toBe(404);
    });
  });

  describe('PATCH /conversations/:id', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'New title' }),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/conversations/non-existent-id', {
        method: 'PATCH',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'New title' }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('returns 400 for empty title', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for title exceeding max length', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const longTitle = 'a'.repeat(256);
      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: longTitle }),
      });

      expect(res.status).toBe(400);
    });

    it('updates conversation title', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Updated title' }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as UpdateConversationResponse;
      expect(json.conversation.title).toBe('Updated title');
      expect(json.conversation.id).toBe(convId);
    });
  });

  describe('POST /conversations/:id/messages', () => {
    it('returns 401 when not authenticated', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'user', content: 'Hello' }),
      });

      expect(res.status).toBe(401);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Unauthorized');
    });

    it('returns 404 for non-existent conversation', async () => {
      const res = await app.request('/conversations/non-existent-id/messages', {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'user', content: 'Hello' }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('returns 400 for invalid role', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'invalid', content: 'Hello' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for empty content', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'user', content: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('creates message with user role', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'user', content: 'Test message' }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateMessageResponse;
      expect(json.message).toBeDefined();
      expect(json.message.role).toBe('user');
      expect(json.message.content).toBe('Test message');
      expect(json.message.conversationId).toBe(convId);

      // Track for cleanup
      createdMessageIds.push(json.message.id);
    });

    it('creates message with model field', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');
      const res = await app.request(`/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          Cookie: authCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          role: 'assistant',
          content: 'I am an AI',
          model: 'claude-3',
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as CreateMessageResponse;
      expect(json.message.role).toBe('assistant');
      expect(json.message.model).toBe('claude-3');

      // Track for cleanup
      createdMessageIds.push(json.message.id);
    });
  });

  describe('Cross-user authorization', () => {
    let otherUserId: string;
    let otherUserCookie: string;
    const OTHER_EMAIL = `test-other-${String(Date.now())}@example.com`;
    const OTHER_PASSWORD = 'OtherPassword123!';

    beforeAll(async () => {
      // Create another user (user B)
      const signupRes = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: OTHER_EMAIL,
          password: OTHER_PASSWORD,
          name: 'Other User',
        }),
      });

      if (!signupRes.ok) {
        throw new Error(`Other user signup failed: ${await signupRes.text()}`);
      }

      const signupData = (await signupRes.json()) as SignupResponse;
      otherUserId = signupData.user?.id ?? '';
      if (!otherUserId) {
        throw new Error('Other user signup failed - no user ID returned');
      }

      // Mark email as verified
      await db.update(users).set({ emailVerified: true }).where(eq(users.id, otherUserId));

      // Sign in as user B
      const signinRes = await app.request('/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: OTHER_EMAIL,
          password: OTHER_PASSWORD,
        }),
      });

      if (!signinRes.ok) {
        throw new Error(`Other user signin failed: ${await signinRes.text()}`);
      }

      const setCookie = signinRes.headers.get('set-cookie');
      if (setCookie) {
        otherUserCookie = setCookie.split(';')[0] ?? '';
      } else {
        throw new Error('Other user signin succeeded but no session cookie returned');
      }
    });

    afterAll(async () => {
      // Clean up user B
      if (otherUserId) {
        await db.delete(sessions).where(eq(sessions.userId, otherUserId));
        await db.delete(accounts).where(eq(accounts.userId, otherUserId));
        await db.delete(users).where(eq(users.id, otherUserId));
      }
    });

    it('returns 404 when user B tries to GET user A conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');

      const res = await app.request(`/conversations/${convId}`, {
        headers: { Cookie: otherUserCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('returns 404 when user B tries to DELETE user A conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');

      const res = await app.request(`/conversations/${convId}`, {
        method: 'DELETE',
        headers: { Cookie: otherUserCookie },
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('returns 404 when user B tries to PATCH user A conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');

      const res = await app.request(`/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          Cookie: otherUserCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Hacked title' }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('returns 404 when user B tries to POST message to user A conversation', async () => {
      const convId = createdConversationIds[0];
      if (!convId) throw new Error('Test setup failed: no conversation created');

      const res = await app.request(`/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          Cookie: otherUserCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ role: 'user', content: 'Unauthorized message' }),
      });

      expect(res.status).toBe(404);
      const json = (await res.json()) as ErrorResponse;
      expect(json.error).toBe('Conversation not found');
    });

    it('user B only sees their own conversations in list', async () => {
      // User B should not see user A's conversations
      const res = await app.request('/conversations', {
        headers: { Cookie: otherUserCookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as ConversationsListResponse;

      // User B has no conversations, should be empty
      // (or only their own if they created any)
      const userAConvIds = createdConversationIds;
      const hasUserAConversations = json.conversations.some((c) => userAConvIds.includes(c.id));
      expect(hasUserAConversations).toBe(false);
    });
  });
});
