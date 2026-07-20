import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { budgetsRoute } from './budgets.js';
import type { AppEnv } from '../types.js';
import type { SessionData } from '../lib/session.js';

vi.mock('../services/billing/balance.js', () => ({
  getUserTierInfo: vi.fn(),
}));

vi.mock('../lib/speculative-balance.js', () => ({
  getGroupReservedTotals: vi.fn(),
}));

import { getUserTierInfo } from '../services/billing/balance.js';
import { getGroupReservedTotals } from '../lib/speculative-balance.js';

const mockGetUserTierInfo = vi.mocked(getUserTierInfo);
const mockGetGroupReservedTotals = vi.mocked(getGroupReservedTotals);

const TEST_USER_ID = 'user-budget-123';
const TEST_CONVERSATION_ID = 'conv-budget-456';
const TEST_MEMBER_ID = 'member-budget-789';

function createMockSession(): SessionData {
  return {
    sessionId: `session-${TEST_USER_ID}`,
    userId: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    pending2FA: false,
    pending2FAExpiresAt: 0,
    createdAt: Date.now(),
  };
}

function createMockUser(): AppEnv['Variables']['user'] {
  return {
    id: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    publicKey: new Uint8Array(32),
  };
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query builder chain */

function createQueryChainFactory(
  selectResults: unknown[][],
  indexRef: { value: number }
): () => Record<string, unknown> {
  const createQueryChain = (): Record<string, unknown> => ({
    from: () => createQueryChain(),
    where: () => createQueryChain(),
    leftJoin: () => createQueryChain(),
    orderBy: () => createQueryChain(),
    limit: () => ({
      then: (resolve: (v: unknown[]) => unknown) => {
        const result = selectResults[indexRef.value++] ?? [];
        return Promise.resolve(resolve(result));
      },
    }),
    then: (resolve: (v: unknown[]) => unknown) => {
      const result = selectResults[indexRef.value++] ?? [];
      return Promise.resolve(resolve(result));
    },
  });
  return createQueryChain;
}

interface GetBudgetsMockDbConfig {
  requesterMember?: { id: string; privilege: string } | null;
  memberBudgets?: {
    memberId: string;
    userId: string | null;
    linkId: string | null;
    privilege: string;
    budget: string | null;
    spent: string | null;
  }[];
  totalSpent?: string | null;
  conversationBudget?: string | null;
  conversationOwnerId?: string;
}

/**
 * Mock DB for GET budgets route:
 * 0. Middleware: membership lookup (select→from→where→limit→then)
 * 1. getConversationBudgets query 1: members LEFT JOIN budgets (select→from→leftJoin→where→then)
 * 2. getConversationBudgets query 2: conversationSpending (select→from→where→limit→then)
 * 3. getConversationBudgets query 3: conversation budget lookup (select→from→where→limit→then)
 * 4. conversation owner lookup (select→from→where→limit→then)
 */
function createGetBudgetsMockDb(config: GetBudgetsMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    config.requesterMember
      ? [
          {
            conversationId: TEST_CONVERSATION_ID,
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
    config.memberBudgets ?? [],
    config.totalSpent !== undefined && config.totalSpent !== null
      ? [{ totalSpent: config.totalSpent }]
      : [],
    [{ conversationBudget: config.conversationBudget ?? '0.00' }],
    [{ userId: config.conversationOwnerId ?? 'owner-user-1' }],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  return {
    select: () => createQueryChain(),
  };
}

function createMockRedis(): unknown {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    eval: vi.fn().mockResolvedValue('0'),
  };
}

interface GetTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: GetBudgetsMockDbConfig;
  redis?: unknown;
}

function createGetTestApp(options: GetTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {}, redis = createMockRedis() } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createGetBudgetsMockDb(dbConfig) as AppEnv['Variables']['db']);
    c.set('redis', redis as AppEnv['Variables']['redis']);
    await next();
  });

  app.route('/', budgetsRoute);
  return app;
}

interface PatchBudgetMockDbConfig {
  requesterMember?: { id: string; privilege: string } | null;
}

/**
 * Mock DB for PATCH budget route:
 * 0. Middleware: membership lookup (select→from→where→limit→then)
 * 1. updateMemberBudget: insert→values→onConflictDoUpdate→returning
 */
function createPatchBudgetMockDb(config: PatchBudgetMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    config.requesterMember
      ? [
          {
            conversationId: TEST_CONVERSATION_ID,
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  return {
    select: () => createQueryChain(),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: () => Promise.resolve([{ id: 'budget-1' }]),
        }),
      }),
    }),
  };
}

interface PatchTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: PatchBudgetMockDbConfig;
}

function createPatchTestApp(options: PatchTestAppOptions = {}): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createPatchBudgetMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', budgetsRoute);
  return app;
}

interface PatchConversationBudgetMockDbConfig {
  requesterMember?: { id: string; privilege: string } | null;
}

/**
 * Mock DB for PATCH conversation budget route:
 * 0. Middleware: membership lookup (select→from→where→limit→then)
 * 1. updateConversationBudget: update→set→where
 */
function createPatchConversationBudgetMockDb(config: PatchConversationBudgetMockDbConfig): unknown {
  const indexRef = { value: 0 };
  const selectResults: unknown[][] = [
    config.requesterMember
      ? [
          {
            conversationId: TEST_CONVERSATION_ID,
            id: config.requesterMember.id,
            privilege: config.requesterMember.privilege,
            visibleFromEpoch: 1,
          },
        ]
      : [],
  ];
  const createQueryChain = createQueryChainFactory(selectResults, indexRef);

  return {
    select: () => createQueryChain(),
    update: () => ({
      set: () => ({
        where: () => Promise.resolve(),
      }),
    }),
  };
}

interface PatchConversationBudgetTestAppOptions {
  user?: AppEnv['Variables']['user'] | null;
  dbConfig?: PatchConversationBudgetMockDbConfig;
}

function createPatchConversationBudgetTestApp(
  options: PatchConversationBudgetTestAppOptions = {}
): Hono<AppEnv> {
  const { user = createMockUser(), dbConfig = {} } = options;
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = { NODE_ENV: 'development' } as unknown as AppEnv['Bindings'];
    c.set('user', user);
    c.set('session', user ? createMockSession() : null);
    c.set('sessionData', user ? createMockSession() : null);
    c.set('db', createPatchConversationBudgetMockDb(dbConfig) as AppEnv['Variables']['db']);
    await next();
  });

  app.route('/', budgetsRoute);
  return app;
}

/* eslint-enable unicorn/no-thenable */

describe('budgets route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default mocks for getUserTierInfo and getGroupReservedTotals
    mockGetUserTierInfo.mockResolvedValue({
      tier: 'paid',
      canAccessPremium: true,
      balanceCents: 1000,
      freeAllowanceCents: 0,
    });
    mockGetGroupReservedTotals.mockResolvedValue({
      memberTotal: 0,
      conversationTotal: 0,
      payerTotal: 0,
    });
  });

  describe('GET /:conversationId', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createGetTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createGetTestApp({
        dbConfig: { requesterMember: null },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('allows write privilege to access budgets', async () => {
      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [],
          totalSpent: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
    });

    it('returns budgets for conversation members', async () => {
      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: 'user-1',
              linkId: null,
              privilege: 'admin',
              budget: '10.00',
              spent: '3.00000000',
            },
            {
              memberId: 'member-2',
              userId: 'user-2',
              linkId: null,
              privilege: 'write',
              budget: null,
              spent: null,
            },
          ],
          totalSpent: '5.00000000',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        conversationBudget: string;
        totalSpent: string;
        memberBudgets: {
          memberId: string;
          userId: string | null;
          linkId: string | null;
          privilege: string;
          budget: string;
          spent: string;
        }[];
      }>();
      expect(body.conversationBudget).toBe('0.00');
      expect(body.totalSpent).toBe('5.00000000');
      expect(body.memberBudgets).toHaveLength(2);
      expect(body.memberBudgets[0]?.budget).toBe('10.00');
      expect(body.memberBudgets[0]?.spent).toBe('3.00000000');
      expect(body.memberBudgets[1]?.budget).toBe('0.00');
      expect(body.memberBudgets[1]?.spent).toBe('0');
    });

    it('returns memberBudgetDollars for the requesting member', async () => {
      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: TEST_USER_ID,
              linkId: null,
              privilege: 'write',
              budget: '10.00',
              spent: '3.00000000',
            },
          ],
          totalSpent: '3.00000000',
          conversationBudget: '50.00',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ memberBudgetDollars: number }>();
      expect(body.memberBudgetDollars).toBe(10);
    });

    it('returns memberBudgetDollars 0 when requesting member has no budget row', async () => {
      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: TEST_USER_ID,
              linkId: null,
              privilege: 'write',
              budget: null,
              spent: null,
            },
          ],
          totalSpent: null,
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{ memberBudgetDollars: number }>();
      expect(body.memberBudgetDollars).toBe(0);
    });

    it('excludes conversation owner from memberBudgets response', async () => {
      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
          memberBudgets: [
            {
              memberId: 'member-owner',
              userId: 'owner-user-1',
              linkId: null,
              privilege: 'owner',
              budget: '20.00',
              spent: '5.00000000',
            },
            {
              memberId: 'member-1',
              userId: 'user-1',
              linkId: null,
              privilege: 'admin',
              budget: '10.00',
              spent: '3.00000000',
            },
            {
              memberId: 'member-2',
              userId: 'user-2',
              linkId: null,
              privilege: 'write',
              budget: '5.00',
              spent: '1.00000000',
            },
          ],
          totalSpent: '9.00000000',
          conversationOwnerId: 'owner-user-1',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        memberBudgets: {
          memberId: string;
          userId: string | null;
          privilege: string;
        }[];
      }>();
      // Owner should be filtered out
      expect(body.memberBudgets).toHaveLength(2);
      expect(body.memberBudgets.map((mb) => mb.memberId)).toEqual(['member-1', 'member-2']);
      // Verify no entry has the owner's userId
      expect(body.memberBudgets.every((mb) => mb.userId !== 'owner-user-1')).toBe(true);
    });

    it('returns conversation budget when set', async () => {
      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner' },
          memberBudgets: [],
          totalSpent: null,
          conversationBudget: '50.00',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        conversationBudget: string;
        totalSpent: string;
        memberBudgets: unknown[];
      }>();
      expect(body.conversationBudget).toBe('50.00');
    });

    it('returns empty budgets when no members', async () => {
      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner' },
          memberBudgets: [],
          totalSpent: null,
        },
      });

      mockGetUserTierInfo.mockResolvedValue({
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 1000,
        freeAllowanceCents: 0,
      });
      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 0,
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        totalSpent: string;
        memberBudgets: unknown[];
      }>();
      expect(body.totalSpent).toBe('0');
      expect(body.memberBudgets).toHaveLength(0);
    });

    it('returns effectiveCents and ownerTier when effective budget is positive', async () => {
      mockGetUserTierInfo.mockResolvedValue({
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 5000,
        freeAllowanceCents: 0,
      });
      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 100,
      });

      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: TEST_USER_ID,
              linkId: null,
              privilege: 'write',
              budget: '10.00',
              spent: '2.00000000',
            },
          ],
          totalSpent: '3.00000000',
          conversationBudget: '50.00',
          conversationOwnerId: 'owner-user-1',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        effectiveDollars: number;
        ownerTier: string;
        ownerBalanceDollars: number;
      }>();
      // conversationRemaining = 5000 - 300 - 0 = 4700
      // memberRemaining = 1000 - 200 - 0 = 800
      // ownerRemaining = 5000 - 100 = 4900
      // effective = min(4700, 800, 4900) = 800 cents = $8
      expect(body.effectiveDollars).toBe(8);
      expect(body.ownerTier).toBe('paid');
      expect(body.ownerBalanceDollars).toBe(50);
    });

    it('returns effectiveCents 0 when owner balance is exhausted', async () => {
      mockGetUserTierInfo.mockResolvedValue({
        tier: 'paid',
        canAccessPremium: false,
        balanceCents: 0,
        freeAllowanceCents: 0,
      });
      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 0,
      });

      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: TEST_USER_ID,
              linkId: null,
              privilege: 'write',
              budget: '10.00',
              spent: '2.00000000',
            },
          ],
          totalSpent: '0.00000000',
          conversationOwnerId: 'owner-user-1',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        effectiveDollars: number;
        ownerTier: string;
        ownerBalanceDollars: number;
      }>();
      expect(body.effectiveDollars).toBe(0);
      expect(body.ownerTier).toBe('paid');
      expect(body.ownerBalanceDollars).toBe(0);
    });

    it('returns negative effectiveCents when owner balance is drained by reservations', async () => {
      mockGetUserTierInfo.mockResolvedValue({
        tier: 'paid',
        canAccessPremium: false,
        balanceCents: 100,
        freeAllowanceCents: 0,
      });
      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 150,
      });

      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: TEST_USER_ID,
              linkId: null,
              privilege: 'write',
              budget: null,
              spent: null,
            },
          ],
          totalSpent: null,
          conversationOwnerId: 'owner-user-1',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        effectiveDollars: number;
        ownerTier: string;
        ownerBalanceDollars: number;
      }>();
      // ownerRemaining = 100 - 150 = -50; memberRemaining = 0 - 0 - 0 = 0
      // effective = min(-50, 0) = -50 cents = -$0.50
      expect(body.effectiveDollars).toBe(-0.5);
      expect(body.ownerTier).toBe('paid');
      expect(body.ownerBalanceDollars).toBe(1);
    });

    it('returns effectiveCents 0 when member budget is exhausted', async () => {
      mockGetUserTierInfo.mockResolvedValue({
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 5000,
        freeAllowanceCents: 0,
      });
      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 0,
      });

      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: TEST_USER_ID,
              linkId: null,
              privilege: 'write',
              budget: '5.00',
              spent: '5.00000000',
            },
          ],
          totalSpent: '0.00000000',
          conversationOwnerId: 'owner-user-1',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        effectiveDollars: number;
        ownerTier: string;
        ownerBalanceDollars: number;
      }>();
      // memberRemaining = 500 - 500 - 0 = 0
      // ownerRemaining = 5000 - 0 = 5000
      // effective = min(0, 5000) = 0 cents = $0
      expect(body.effectiveDollars).toBe(0);
      expect(body.ownerTier).toBe('paid');
      expect(body.ownerBalanceDollars).toBe(50);
    });

    it('returns ownerBalanceCents and ownerTier from tier info', async () => {
      mockGetUserTierInfo.mockResolvedValue({
        tier: 'paid',
        canAccessPremium: true,
        balanceCents: 7500,
        freeAllowanceCents: 0,
      });
      mockGetGroupReservedTotals.mockResolvedValue({
        memberTotal: 0,
        conversationTotal: 0,
        payerTotal: 2000,
      });

      const app = createGetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'write' },
          memberBudgets: [
            {
              memberId: 'member-1',
              userId: TEST_USER_ID,
              linkId: null,
              privilege: 'write',
              budget: '50.00',
              spent: '0.00000000',
            },
          ],
          totalSpent: null,
          conversationBudget: '100.00',
          conversationOwnerId: 'owner-user-1',
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}`);

      expect(res.status).toBe(200);
      const body = await res.json<{
        ownerBalanceDollars: number;
        ownerTier: string;
        effectiveDollars: number;
      }>();
      expect(body.ownerBalanceDollars).toBe(75);
      expect(body.ownerTier).toBe('paid');
      // conversationRemaining = 10000 - 0 - 0 = 10000
      // memberRemaining = 5000 - 0 - 0 = 5000
      // ownerRemaining = 7500 - 2000 = 5500
      // effective = min(10000, 5000, 5500) = 5000 cents = $50
      expect(body.effectiveDollars).toBe(50);
    });
  });

  describe('PATCH /:conversationId/member/:memberId', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createPatchTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/member/${TEST_MEMBER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 500 }),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createPatchTestApp({
        dbConfig: { requesterMember: null },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/member/${TEST_MEMBER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 500 }),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 403 when privilege is below admin', async () => {
      const app = createPatchTestApp({
        dbConfig: { requesterMember: { id: 'member-1', privilege: 'write' } },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/member/${TEST_MEMBER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 500 }),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('updates member budget and returns 200', async () => {
      const app = createPatchTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/member/${TEST_MEMBER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 1050 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ updated: boolean }>();
      expect(body.updated).toBe(true);
    });

    it('returns 400 when budgetCents is missing', async () => {
      const app = createPatchTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/member/${TEST_MEMBER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when budgetCents is negative', async () => {
      const app = createPatchTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/member/${TEST_MEMBER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: -100 }),
      });

      expect(res.status).toBe(400);
    });

    it('accepts zero budgetCents', async () => {
      const app = createPatchTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'admin' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/member/${TEST_MEMBER_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 0 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ updated: boolean }>();
      expect(body.updated).toBe(true);
    });
  });

  describe('PATCH /:conversationId/budget', () => {
    it('returns 401 when not authenticated', async () => {
      const app = createPatchConversationBudgetTestApp({ user: null });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 5000 }),
      });

      expect(res.status).toBe(401);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 404 when not a member', async () => {
      const app = createPatchConversationBudgetTestApp({
        dbConfig: { requesterMember: null },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 5000 }),
      });

      expect(res.status).toBe(404);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 403 when privilege is below owner', async () => {
      const app = createPatchConversationBudgetTestApp({
        dbConfig: { requesterMember: { id: 'member-1', privilege: 'admin' } },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 5000 }),
      });

      expect(res.status).toBe(403);
      const body = await res.json<{ code: string }>();
      expect(body.code).toBe('PRIVILEGE_INSUFFICIENT');
    });

    it('returns 200 when owner sets budget', async () => {
      const app = createPatchConversationBudgetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: 5000 }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ updated: boolean }>();
      expect(body.updated).toBe(true);
    });

    it('returns 400 when owner sends null budget', async () => {
      const app = createPatchConversationBudgetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetCents: null }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when budgetCents is missing', async () => {
      const app = createPatchConversationBudgetTestApp({
        dbConfig: {
          requesterMember: { id: 'member-1', privilege: 'owner' },
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/budget`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });
});
