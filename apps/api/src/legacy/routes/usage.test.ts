/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion -- json() returns any, assertions provide documentation */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import {
  createDb,
  LOCAL_NEON_DEV_CONFIG,
  users,
  wallets,
  ledgerEntries,
  usageRecords,
  llmCompletions,
  conversations,
  conversationSpending,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { usageRoute } from './usage.js';
import type {
  UsageSummaryResponse,
  SpendingOverTimeResponse,
  CostByModelResponse,
  TokenUsageOverTimeResponse,
  SpendingByConversationResponse,
  BalanceHistoryResponse,
  UsageModelsResponse,
} from '@hushbox/shared';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

function getAuthHeaders(userId: string): Record<string, string> {
  return { 'X-Test-User-Id': userId };
}

async function insertReturningFirst<T>(query: Promise<T[]>): Promise<T> {
  const [row] = await query;
  if (!row) throw new Error('Insert returned no rows');
  return row;
}

describe('usage routes', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;
  let app: Hono<AppEnv>;
  let testUserId: string;

  const testSuffix = String(Date.now()).slice(-8);
  const TEST_EMAIL = `test-usage-${testSuffix}@example.com`;
  const TEST_USERNAME = `tu_${testSuffix}`;

  // Track created IDs for cleanup
  const createdUsageRecordIds: string[] = [];
  const createdConversationIds: string[] = [];
  let testWalletId: string;
  const createdLedgerEntryIds: string[] = [];

  beforeAll(async () => {
    db = createDb({ connectionString, neonDev: LOCAL_NEON_DEV_CONFIG });

    // Create test user
    const userData = userFactory.build({
      email: TEST_EMAIL,
      username: TEST_USERNAME,
      emailVerified: true,
    });
    const createdUser = await insertReturningFirst(db.insert(users).values(userData).returning());
    testUserId = createdUser.id;

    // Create wallet
    const createdWallet = await insertReturningFirst(
      db
        .insert(wallets)
        .values({ userId: testUserId, type: 'purchased', balance: '50.00000000', priority: 0 })
        .returning()
    );
    testWalletId = createdWallet.id;

    // Create a conversation with spending (title is encrypted bytea)
    const conv = await insertReturningFirst(
      db
        .insert(conversations)
        .values({ userId: testUserId, title: new Uint8Array([116, 101, 115, 116]) })
        .returning()
    );
    createdConversationIds.push(conv.id);

    await db.insert(conversationSpending).values({
      conversationId: conv.id,
      totalSpent: '5.00000000',
    });

    // Create usage records with llm completions
    for (let index = 0; index < 3; index++) {
      const ur = await insertReturningFirst(
        db
          .insert(usageRecords)
          .values({
            userId: testUserId,
            type: 'chat',
            status: 'completed',
            cost: '1.00000000',
            sourceType: 'conversation',
            sourceId: conv.id,
            createdAt: new Date(`2026-03-${String(20 + index).padStart(2, '0')}T12:00:00Z`),
          })
          .returning()
      );
      createdUsageRecordIds.push(ur.id);

      await db.insert(llmCompletions).values({
        usageRecordId: ur.id,
        model: index < 2 ? 'anthropic/claude-opus-4.6' : 'openai/gpt-4o',
        provider: index < 2 ? 'anthropic' : 'openai',
        inputTokens: 1000 * (index + 1),
        outputTokens: 500 * (index + 1),
        cachedTokens: 100 * (index + 1),
      });
    }

    // Create a ledger entry (requires usageRecordId due to check constraint)
    const le = await insertReturningFirst(
      db
        .insert(ledgerEntries)
        .values({
          walletId: testWalletId,
          amount: '-1.00000000',
          balanceAfter: '49.00000000',
          entryType: 'usage_charge',
          usageRecordId: createdUsageRecordIds[0],
          createdAt: new Date('2026-03-21T12:00:00Z'),
        })
        .returning()
    );
    createdLedgerEntryIds.push(le.id);

    // Set up mock app
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('envUtils', {
        isCI: false,
        isE2E: false,
        isLocalDev: false,
        isDevServer: false,
        isDev: false,
        isProduction: false,
        requiresRealServices: false,
      });
      const testUserIdHeader = c.req.header('X-Test-User-Id');
      if (testUserIdHeader) {
        const sessionData: SessionData = {
          sessionId: `test-session-${testUserIdHeader}`,
          userId: testUserIdHeader,
          email: TEST_EMAIL,
          username: TEST_USERNAME,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        };
        c.set('user', {
          id: testUserIdHeader,
          email: TEST_EMAIL,
          username: TEST_USERNAME,
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', sessionData);
        c.set('sessionData', sessionData);
      }
      await next();
    });
    app.route('/usage', usageRoute);
  });

  afterAll(async () => {
    // Clean up in reverse dependency order
    if (createdLedgerEntryIds.length > 0) {
      await db.delete(ledgerEntries).where(inArray(ledgerEntries.id, createdLedgerEntryIds));
    }
    if (testWalletId) {
      await db.delete(wallets).where(eq(wallets.id, testWalletId));
    }
    // conversation_spending cascades from conversations
    if (createdConversationIds.length > 0) {
      // llm_completions cascade from usage_records
      if (createdUsageRecordIds.length > 0) {
        await db.delete(usageRecords).where(inArray(usageRecords.id, createdUsageRecordIds));
      }
      await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
    }
    if (testUserId) {
      await db.delete(users).where(eq(users.id, testUserId));
    }
  });

  // ============================================================
  // Authentication
  // ============================================================

  describe('authentication', () => {
    it('returns 401 for unauthenticated request to /usage/summary', async () => {
      const res = await app.request('/usage/summary?startDate=2026-01-01&endDate=2026-03-27');
      expect(res.status).toBe(401);
    });

    it('returns 401 for unauthenticated request to /usage/models', async () => {
      const res = await app.request('/usage/models');
      expect(res.status).toBe(401);
    });
  });

  // ============================================================
  // GET /usage/summary
  // ============================================================

  describe('GET /usage/summary', () => {
    it('returns aggregated usage summary', async () => {
      const res = await app.request('/usage/summary?startDate=2026-03-01&endDate=2026-03-31', {
        headers: getAuthHeaders(testUserId),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as UsageSummaryResponse;
      expect(Number.parseFloat(body.totalSpent)).toBe(3);
      expect(body.messageCount).toBe(3);
      expect(body.totalInputTokens).toBe(6000); // 1000+2000+3000
      expect(body.totalOutputTokens).toBe(3000); // 500+1000+1500
      expect(body.totalCachedTokens).toBe(600); // 100+200+300
    });

    it('returns zeros for date range with no data', async () => {
      const res = await app.request('/usage/summary?startDate=2020-01-01&endDate=2020-01-31', {
        headers: getAuthHeaders(testUserId),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as UsageSummaryResponse;
      expect(body.totalSpent).toBe('0');
      expect(body.messageCount).toBe(0);
    });

    it('does not show other users data', async () => {
      const res = await app.request('/usage/summary?startDate=2026-03-01&endDate=2026-03-31', {
        headers: getAuthHeaders('nonexistent-user-id'),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as UsageSummaryResponse;
      expect(body.messageCount).toBe(0);
    });
  });

  // ============================================================
  // GET /usage/spending-over-time
  // ============================================================

  describe('GET /usage/spending-over-time', () => {
    it('returns spending grouped by day and model', async () => {
      const res = await app.request(
        '/usage/spending-over-time?startDate=2026-03-01&endDate=2026-03-31',
        { headers: getAuthHeaders(testUserId) }
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as SpendingOverTimeResponse;
      expect(body.data.length).toBeGreaterThan(0);

      const models = new Set(body.data.map((d) => d.model));
      expect(models.has('anthropic/claude-opus-4.6')).toBe(true);
      expect(models.has('openai/gpt-4o')).toBe(true);
    });

    it('filters by model', async () => {
      const res = await app.request(
        '/usage/spending-over-time?startDate=2026-03-01&endDate=2026-03-31&model=openai/gpt-4o',
        { headers: getAuthHeaders(testUserId) }
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as SpendingOverTimeResponse;
      for (const point of body.data) {
        expect(point.model).toBe('openai/gpt-4o');
      }
    });
  });

  // ============================================================
  // GET /usage/cost-by-model
  // ============================================================

  describe('GET /usage/cost-by-model', () => {
    it('returns cost breakdown by model sorted descending', async () => {
      const res = await app.request(
        '/usage/cost-by-model?startDate=2026-03-01&endDate=2026-03-31',
        { headers: getAuthHeaders(testUserId) }
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as CostByModelResponse;
      expect(body.data.length).toBe(2);
      // Claude has 2 records ($2 total), GPT-4o has 1 record ($1 total)
      expect(body.data[0]?.model).toBe('anthropic/claude-opus-4.6');
      expect(Number.parseFloat(body.data[0]?.totalCost ?? '0')).toBe(2);
    });
  });

  // ============================================================
  // GET /usage/token-usage-over-time
  // ============================================================

  describe('GET /usage/token-usage-over-time', () => {
    it('returns token counts grouped by day', async () => {
      const res = await app.request(
        '/usage/token-usage-over-time?startDate=2026-03-01&endDate=2026-03-31',
        { headers: getAuthHeaders(testUserId) }
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as TokenUsageOverTimeResponse;
      expect(body.data.length).toBeGreaterThan(0);

      const totalInput = body.data.reduce((sum, d) => sum + d.inputTokens, 0);
      expect(totalInput).toBe(6000);
    });
  });

  // ============================================================
  // GET /usage/spending-by-conversation
  // ============================================================

  describe('GET /usage/spending-by-conversation', () => {
    it('returns top conversations by spending', async () => {
      const res = await app.request(
        '/usage/spending-by-conversation?startDate=2026-03-01&endDate=2026-03-31',
        { headers: getAuthHeaders(testUserId) }
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as SpendingByConversationResponse;
      expect(body.data.length).toBe(1);
      expect(Number.parseFloat(body.data[0]?.totalSpent ?? '0')).toBe(3);
    });

    it('does not show other users conversations', async () => {
      const res = await app.request(
        '/usage/spending-by-conversation?startDate=2026-03-01&endDate=2026-03-31',
        { headers: getAuthHeaders('nonexistent-user-id') }
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as SpendingByConversationResponse;
      expect(body.data.length).toBe(0);
    });
  });

  // ============================================================
  // GET /usage/balance-history
  // ============================================================

  describe('GET /usage/balance-history', () => {
    it('returns balance history entries', async () => {
      const res = await app.request(
        '/usage/balance-history?startDate=2026-03-01&endDate=2026-03-31',
        { headers: getAuthHeaders(testUserId) }
      );
      expect(res.status).toBe(200);

      const body = (await res.json()) as BalanceHistoryResponse;
      expect(body.data.length).toBe(1);
      expect(body.data[0]?.entryType).toBe('usage_charge');
    });
  });

  // ============================================================
  // GET /usage/models
  // ============================================================

  describe('GET /usage/models', () => {
    it('returns distinct models used by the user', async () => {
      const res = await app.request('/usage/models', {
        headers: getAuthHeaders(testUserId),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as UsageModelsResponse;
      expect(body.models).toContain('anthropic/claude-opus-4.6');
      expect(body.models).toContain('openai/gpt-4o');
      expect(body.models.length).toBe(2);
    });

    it('returns empty for user with no usage', async () => {
      const res = await app.request('/usage/models', {
        headers: getAuthHeaders('nonexistent-user-id'),
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as UsageModelsResponse;
      expect(body.models.length).toBe(0);
    });
  });
});
