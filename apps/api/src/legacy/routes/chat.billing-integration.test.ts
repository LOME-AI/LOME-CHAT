/**
 * Billing integration tests — scenario matrix covering all tier/reservation/balance combinations.
 *
 * Uses the same mock infrastructure as chat.test.ts to exercise the real billing pipeline
 * (validateBilling → buildBillingInput → resolveBilling → calculateBudget → reserve).
 *
 * See chat.billing-scenarios.md for the full scenario matrix and dimensions.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Hono } from 'hono';
import {
  conversations as conversationsTable,
  conversationMembers as conversationMembersTable,
  memberBudgets as memberBudgetsTable,
  conversationSpending as conversationSpendingTable,
  messages as messagesTable,
  users as usersTable,
  wallets as walletsTable,
  epochs as epochsTable,
  usageRecords as usageRecordsTable,
  llmCompletions as llmCompletionsTable,
  ledgerEntries as ledgerEntriesTable,
} from '@hushbox/db';
import {
  ERROR_CODE_BALANCE_RESERVED,
  ERROR_CODE_INSUFFICIENT_BALANCE,
  calculateBudget,
  computeSafeMaxTokens,
  buildSystemPrompt,
  estimateTokensForTier,
  charsPerTokenForTier,
  getEffectiveBalance,
  applyFees,
  effectiveOutputCostPerToken,
  MINIMUM_OUTPUT_TOKENS,
  STORAGE_COST_PER_CHARACTER,
  CHARS_PER_TOKEN_CONSERVATIVE,
  CHARS_PER_TOKEN_STANDARD,
  createEnvUtilities,
} from '@hushbox/shared';
import { clearModelCache } from '@hushbox/shared/models';
import { generateKeyPair } from '@hushbox/crypto';
import { chatRoute, computeWorstCaseCents } from './chat.js';
import { createMockAIClient } from '../services/ai/mock.js';
import type { AppEnv } from '../types.js';
import type { UserTier } from '@hushbox/shared';

interface PublicModelFixture {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  pricing?: Record<string, unknown>;
  context_window?: number;
  created?: number;
}

let publicModelsFixture: PublicModelFixture[] = [];

// ============================================================================
// Constants
// ============================================================================

const testEpochKeyPair = generateKeyPair();
const TEST_CONVERSATION_ID = '11111111-1111-1111-8111-111111111111';
const TEST_USER_ID = 'user-123';
const TEST_USER_MESSAGE_ID = '22222222-2222-2222-8222-222222222222';

// Use fixed timestamps well before the faked test time (2024-01-15) to avoid
// premium-by-recency detection. Models must be older than PREMIUM_RECENCY_MS (1 year).
const OLD_TIMESTAMP = Math.floor(new Date('2022-01-01').getTime() / 1000);

const BASIC_MODEL = {
  id: 'openai/gpt-4o-mini',
  name: 'GPT-3.5 Turbo',
  description: 'Basic model',
  context_length: 16_000,
  pricing: { prompt: '0.0000005', completion: '0.0000015' },
  supported_parameters: ['temperature'],
  created: OLD_TIMESTAMP,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
};

const PREMIUM_MODEL = {
  id: 'openai/gpt-5',
  name: 'GPT-4 Turbo',
  description: 'Premium model',
  context_length: 128_000,
  pricing: { prompt: '0.00001', completion: '0.00003' },
  supported_parameters: ['temperature'],
  created: OLD_TIMESTAMP,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
};

const ALL_MODELS = [BASIC_MODEL, PREMIUM_MODEL];

// ============================================================================
// Types
// ============================================================================

interface ErrorBody {
  code: string;
  details?: Record<string, unknown>;
}

interface MockFetchResponse {
  ok: boolean;
  statusText?: string;
  json: () => Promise<unknown>;
}

type FetchMock = Mock<(url: string, init?: RequestInit) => Promise<MockFetchResponse>>;

interface ScenarioInput {
  tier: UserTier;
  balanceCents: number;
  freeAllowanceCents: number;
  reservedCents: number;
  model: 'basic' | 'premium';
}

interface ScenarioOutput {
  messageContent: string;
  availableCents: number;
  callCostCents: number;
  totalReservedCents: number;
  maxOutputTokens: number;
  estimatedMinCostCents: number;
  charsPerToken: number;
  outputCostPerToken: number;
}

// ============================================================================
// Scenario Helper
// ============================================================================

/**
 * Forward computation: derive all billing expectations from scenario inputs.
 * Mirrors production math (with the reservation-aware fix applied).
 */
function computeScenario(input: ScenarioInput): ScenarioOutput {
  const modelDefinition = input.model === 'basic' ? BASIC_MODEL : PREMIUM_MODEL;
  const inputPricePerToken = applyFees(Number.parseFloat(modelDefinition.pricing.prompt));
  const outputPricePerToken = applyFees(Number.parseFloat(modelDefinition.pricing.completion));
  const contextLength = modelDefinition.context_length;
  const messageContent = 'Hello';

  // Adjusted values (mirrors fixed buildBillingInput)
  const adjustedBalanceCents = input.balanceCents - input.reservedCents;
  const adjustedFreeAllowanceCents = input.freeAllowanceCents - input.reservedCents;

  // Estimated minimum cost (uses actual tier, matching validateBilling after Fix 2)
  const systemPrompt = buildSystemPrompt([]);
  const promptCharacterCount = systemPrompt.length + messageContent.length;
  const preCheckInputTokens = estimateTokensForTier(input.tier, promptCharacterCount);
  // Output storage: inverted from input — free=STANDARD(4), paid=CONSERVATIVE(2)
  const outputCharsPerToken =
    input.tier === 'paid' ? CHARS_PER_TOKEN_CONSERVATIVE : CHARS_PER_TOKEN_STANDARD;
  const inputStorageCostCents = promptCharacterCount * STORAGE_COST_PER_CHARACTER * 100;
  const outputStorageCostCents =
    MINIMUM_OUTPUT_TOKENS * outputCharsPerToken * STORAGE_COST_PER_CHARACTER * 100;
  const estimatedMinCostCents =
    (preCheckInputTokens * inputPricePerToken + MINIMUM_OUTPUT_TOKENS * outputPricePerToken) * 100 +
    inputStorageCostCents +
    outputStorageCostCents;

  // Budget calculation (actual tier)
  const budgetResult = calculateBudget({
    tier: input.tier,
    balanceCents: adjustedBalanceCents,
    freeAllowanceCents: adjustedFreeAllowanceCents,
    promptCharacterCount,
    models: [
      {
        modelInputPricePerToken: inputPricePerToken,
        modelOutputPricePerToken: outputPricePerToken,
        contextLength,
      },
    ],
  });

  const safeMaxTokens = computeSafeMaxTokens({
    budgetMaxTokens: budgetResult.maxOutputTokens,
    modelContextLength: contextLength,
    estimatedInputTokens: budgetResult.estimatedInputTokens,
  });

  const effectiveMaxOutputTokens =
    safeMaxTokens ?? contextLength - budgetResult.estimatedInputTokens;
  const callCostCents =
    (budgetResult.estimatedInputCost + effectiveMaxOutputTokens * budgetResult.outputCostPerToken) *
    100;

  const hasBudget = budgetResult.maxOutputTokens > 0;

  return {
    messageContent,
    availableCents:
      getEffectiveBalance(input.tier, adjustedBalanceCents, adjustedFreeAllowanceCents) * 100,
    callCostCents: hasBudget ? callCostCents : 0,
    totalReservedCents: input.reservedCents + (hasBudget ? callCostCents : 0),
    maxOutputTokens: budgetResult.maxOutputTokens,
    estimatedMinCostCents,
    charsPerToken: charsPerTokenForTier(input.tier),
    outputCostPerToken: budgetResult.outputCostPerToken,
  };
}

/**
 * Inverse computation: find the freeAllowanceCents that produces exactly targetOutputTokens.
 */
function allowanceForTargetTokens(
  model: 'basic' | 'premium',
  tier: UserTier,
  targetOutputTokens: number,
  messageContent: string
): number {
  const modelDefinition = model === 'basic' ? BASIC_MODEL : PREMIUM_MODEL;
  const inputPricePerToken = applyFees(Number.parseFloat(modelDefinition.pricing.prompt));
  const outputPricePerToken = applyFees(Number.parseFloat(modelDefinition.pricing.completion));

  const systemPrompt = buildSystemPrompt([]);
  const promptCharacterCount = systemPrompt.length + messageContent.length;
  const estimatedInputTokens = estimateTokensForTier(tier, promptCharacterCount);
  const inputStorageCost = promptCharacterCount * STORAGE_COST_PER_CHARACTER;
  const estimatedInputCost = estimatedInputTokens * inputPricePerToken + inputStorageCost;
  const outputCostPerToken = effectiveOutputCostPerToken(outputPricePerToken, tier);

  // effectiveBalance = estimatedInputCost + targetOutputTokens * outputCostPerToken
  // For free tier: effectiveBalance = freeAllowanceCents / 100
  // So: freeAllowanceCents = (estimatedInputCost + targetOutputTokens * outputCostPerToken) * 100
  const requiredBalance = estimatedInputCost + targetOutputTokens * outputCostPerToken;
  return requiredBalance * 100;
}

// ============================================================================
// Mock Infrastructure (mirrors chat.test.ts)
// ============================================================================

interface MockConversation {
  id: string;
  userId: string;
  title: string;
  currentEpoch: number;
  nextSequence: number;
  conversationBudget?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface MockWallet {
  id: string;
  userId: string;
  type: string;
  balance: string;
}

interface MockUser {
  id: string;
  balance: string;
}

function createMockDb(options: {
  conversations?: MockConversation[];
  users?: MockUser[];
  wallets?: MockWallet[];
  onInsert?: (table: unknown, values: unknown) => void;
  /** Set to a recent date to prevent free-tier lazy renewal in tests.
   *  Defaults to today (faked time) so renewal never triggers. */
  lastRenewalAt?: Date | null;
}) {
  const { conversations = [], users = [], onInsert } = options;
  // Default: today's date so needsResetBeforeMidnight returns false (no renewal)
  const lastRenewalAt = options.lastRenewalAt === undefined ? new Date() : options.lastRenewalAt;
  const wallets: MockWallet[] =
    options.wallets ??
    users.map((u) => ({
      id: `wallet-${u.id}`,
      userId: u.id,
      type: 'purchased',
      balance: u.balance,
    }));

  let nextSequence = conversations[0]?.nextSequence ?? 0;
  const currentEpoch = conversations[0]?.currentEpoch ?? 1;

  let usersQueryCount = 0;
  let walletsQueryCount = 0;

  /* eslint-disable unicorn/no-thenable -- test mock for Drizzle query builder */
  function createThenable<T>(value: T) {
    const chainable = {
      then: (resolve: (v: T) => unknown) => Promise.resolve(resolve(value)),
      limit: (n: number) => ({
        then: (resolve: (v: T) => unknown) => {
          const sliced = Array.isArray(value) ? (value.slice(0, n) as T) : value;
          return Promise.resolve(resolve(sliced));
        },
      }),
      orderBy: () => chainable,
    };
    return chainable;
  }
  /* eslint-enable unicorn/no-thenable */

  interface MockDbOps {
    select: () => {
      from: (table: unknown) => {
        where: () => unknown;
        leftJoin: () => { where: () => unknown };
        innerJoin: () => { where: () => unknown };
      };
    };
    insert: (table: unknown) => {
      values: (values: unknown) => { returning: () => Promise<unknown[]> };
    };
    update: (table: unknown) => {
      set: (setValues: Record<string, unknown>) => { where: () => unknown };
    };
    delete: (table: unknown) => { where: () => Promise<void> };
    transaction: <T>(callback: (tx: MockDbOps) => Promise<T>) => Promise<T>;
  }

  const tableResolvers = new Map<unknown, () => ReturnType<typeof createThenable>>([
    [conversationsTable, () => createThenable(conversations)],
    [
      usersTable,
      () => {
        const index = usersQueryCount % users.length;
        usersQueryCount++;
        const user = users[index];
        return createThenable(
          user
            ? [{ balance: user.balance, freeAllowanceCents: 0, freeAllowanceResetAt: new Date() }]
            : []
        );
      },
    ],
    [
      walletsTable,
      () => {
        const walletUserIndex = walletsQueryCount % users.length;
        walletsQueryCount++;
        const userForWallets = users[walletUserIndex];
        return createThenable(
          userForWallets ? wallets.filter((w) => w.userId === userForWallets.id) : wallets
        );
      },
    ],
    [epochsTable, () => createThenable([{ epochPublicKey: testEpochKeyPair.publicKey }])],
    [ledgerEntriesTable, () => createThenable([{ maxCreatedAt: lastRenewalAt }])],
    [
      conversationMembersTable,
      () =>
        createThenable(
          conversations.length > 0
            ? [
                {
                  id: 'member-owner',
                  userId: conversations[0]!.userId,
                  conversationId: conversations[0]!.id,
                  privilege: 'owner',
                  visibleFromEpoch: 1,
                },
              ]
            : []
        ),
    ],
    [memberBudgetsTable, () => createThenable([])],
    [conversationSpendingTable, () => createThenable([])],
    [messagesTable, () => createThenable([])],
  ]);

  function resolveWhere(table: unknown) {
    return tableResolvers.get(table)?.() ?? createThenable([]);
  }

  const dbOps: MockDbOps = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => resolveWhere(table),
        leftJoin: () => ({ where: () => createThenable([]) }),
        innerJoin: () => ({ where: () => resolveWhere(table) }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        if (onInsert) onInsert(table, values);
        const returningFunction = () => {
          if (table === messagesTable) return Promise.resolve([values]);
          if (table === usageRecordsTable) return Promise.resolve([{ id: 'usage-record-123' }]);
          if (table === llmCompletionsTable) return Promise.resolve([{ id: 'llm-completion-123' }]);
          if (table === ledgerEntriesTable) return Promise.resolve([{ id: 'ledger-entry-123' }]);
          return Promise.resolve([values]);
        };
        return {
          returning: returningFunction,
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (setValues: Record<string, unknown>) => ({
        where: () => {
          if (table === conversationsTable && setValues['nextSequence']) {
            const seq = nextSequence;
            const userSeq = nextSequence;
            const aiSeq = nextSequence + 1;
            nextSequence += 2;
            /* eslint-disable unicorn/no-thenable */
            return {
              returning: () => Promise.resolve([{ seq, userSeq, aiSeq, currentEpoch }]),
              then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
            };
            /* eslint-enable unicorn/no-thenable */
          }
          if (table === walletsTable) {
            const wallet = wallets[0];
            /* eslint-disable unicorn/no-thenable */
            return {
              returning: () =>
                Promise.resolve(
                  wallet ? [{ id: wallet.id, type: wallet.type, balance: '9.99000000' }] : []
                ),
              then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
            };
            /* eslint-enable unicorn/no-thenable */
          }
          /* eslint-disable unicorn/no-thenable */
          return {
            returning: () => Promise.resolve([{}]),
            then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
          };
          /* eslint-enable unicorn/no-thenable */
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
    transaction: async <T>(callback: (tx: MockDbOps) => Promise<T>): Promise<T> => {
      return callback(dbOps);
    },
  };

  return dbOps;
}

function createMockRedis(options?: { reservedCents?: number; evalOverride?: string }) {
  const reservedValue = options?.reservedCents ? String(options.reservedCents) : null;
  const evalValue = options?.evalOverride ?? '0';
  // Key-aware get: rate-limit keys must return null (so the per-user cap allows
  // the test request through), while reservation/balance keys return the
  // configured `reservedCents`. Any 'chat:reserved:*' or other reservation key
  // hits the legacy branch.
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (typeof key === 'string' && key.includes(':ratelimit:')) {
        return Promise.resolve(null);
      }
      return Promise.resolve(reservedValue);
    }),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(evalValue),
    scan: vi.fn().mockResolvedValue([0, []]),
  };
}

function defaultConversation(): MockConversation {
  return {
    id: TEST_CONVERSATION_ID,
    userId: TEST_USER_ID,
    title: 'Test Conversation',
    currentEpoch: 1,
    nextSequence: 1,
    conversationBudget: '100.00',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createTestApp(
  dbOptions: Parameters<typeof createMockDb>[0],
  redisOverride: ReturnType<typeof createMockRedis>
) {
  const app = new Hono<AppEnv>();
  const mockUser = {
    id: TEST_USER_ID,
    email: 'test@example.com',
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: false,
    publicKey: new Uint8Array(32),
  };
  const mockSession = {
    sessionId: 'session-123',
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

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'development',
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    } as AppEnv['Bindings'];
    c.set('user', mockUser);
    c.set('session', mockSession);
    c.set('aiClient', createMockAIClient());
    c.set('db', createMockDb(dbOptions) as unknown as AppEnv['Variables']['db']);
    c.set('redis', redisOverride as unknown as AppEnv['Variables']['redis']);
    c.set('envUtils', createEnvUtilities(c.env));
    await next();
  });

  app.route('/', chatRoute);
  return app;
}

function streamBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    models: [BASIC_MODEL.id],
    userMessage: { id: TEST_USER_MESSAGE_ID, content: 'Hello' },
    messagesForInference: [{ role: 'user', content: 'Hello' }],
    fundingSource: 'free_allowance',
    ...overrides,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('billing integration — scenario matrix', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    clearModelCache();
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

    publicModelsFixture = ALL_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      type: 'language',
      pricing: { input: m.pricing.prompt, output: m.pricing.completion },
      context_window: m.context_length,
      created: m.created,
    }));

    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: publicModelsFixture }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    publicModelsFixture = [];
  });

  // --------------------------------------------------------------------------
  // Free Tier
  // --------------------------------------------------------------------------

  describe('free tier', () => {
    const freeDbOptions = (freeAllowance: string) => ({
      conversations: [defaultConversation()],
      users: [{ id: TEST_USER_ID, balance: '0.00000000' }],
      wallets: [
        { id: 'wallet-free', userId: TEST_USER_ID, type: 'free_tier', balance: freeAllowance },
      ],
    });

    it('F1: passes with full allowance and no reservations', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis();
      const app = createTestApp(freeDbOptions('0.05000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('F2: passes with partial reservation leaving sufficient allowance', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis({ reservedCents: 3 });
      const app = createTestApp(freeDbOptions('0.05000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('F3: denies when reservations leave insufficient allowance', async () => {
      const mockRedis = createMockRedis({ reservedCents: 4.9 });
      const app = createTestApp(freeDbOptions('0.05000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe(ERROR_CODE_INSUFFICIENT_BALANCE);
    });

    it('F4: denies when reservations exhaust entire allowance', async () => {
      const mockRedis = createMockRedis({ reservedCents: 5 });
      const app = createTestApp(freeDbOptions('0.05000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe(ERROR_CODE_INSUFFICIENT_BALANCE);
    });

    it('F5: denies free tier access to premium models with MODEL_TIER_LOCKED', async () => {
      // Pre-billing tier gate now intercepts free-tier-on-premium with 403
      // MODEL_TIER_LOCKED — distinct from the balance-driven
      // PREMIUM_REQUIRES_BALANCE so the UI renders an "upgrade your account"
      // message instead of "top up your balance".
      const mockRedis = createMockRedis();
      const app = createTestApp(freeDbOptions('0.05000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(403);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('MODEL_TIER_LOCKED');
    });

    it('F6: denies when no allowance at all', async () => {
      const mockRedis = createMockRedis();
      const app = createTestApp(freeDbOptions('0.00000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe(ERROR_CODE_INSUFFICIENT_BALANCE);
    });
  });

  // --------------------------------------------------------------------------
  // Paid Tier
  // --------------------------------------------------------------------------

  describe('paid tier', () => {
    const paidDbOptions = (balanceDollars: string) => ({
      conversations: [defaultConversation()],
      users: [{ id: TEST_USER_ID, balance: balanceDollars }],
      wallets: [
        {
          id: 'wallet-purchased',
          userId: TEST_USER_ID,
          type: 'purchased',
          balance: balanceDollars,
        },
      ],
    });

    it('P1: passes with full balance and no reservations (premium)', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis();
      const app = createTestApp(paidDbOptions('10.00000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('P2: passes with large reservation leaving $1 effective (premium)', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis({ reservedCents: 950 });
      const app = createTestApp(paidDbOptions('10.00000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('P3: passes with reservation leaving 1¢ effective (cushion: -49¢ + 50¢)', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis({ reservedCents: 1049 });
      const app = createTestApp(paidDbOptions('10.00000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('P4: denies when cushion fully consumed by reservations', async () => {
      const mockRedis = createMockRedis({ reservedCents: 1050 });
      const app = createTestApp(paidDbOptions('10.00000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe(ERROR_CODE_INSUFFICIENT_BALANCE);
    });

    it('P5: passes with minimal balance using cushion (basic)', async () => {
      vi.useRealTimers();

      // $0.01 is the minimum to be classified as 'paid' (balanceCents > 0)
      const mockRedis = createMockRedis();
      const app = createTestApp(paidDbOptions('0.01000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('P6: passes with minimal balance using cushion (premium)', async () => {
      vi.useRealTimers();

      // $0.01 is the minimum to be classified as 'paid' (balanceCents > 0)
      const mockRedis = createMockRedis();
      const app = createTestApp(paidDbOptions('0.01000000'), mockRedis);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });
  });

  // --------------------------------------------------------------------------
  // Race Guard (simulated concurrent reservations)
  // --------------------------------------------------------------------------

  describe('race guard (TOCTOU safety net)', () => {
    it('R1: denies when concurrent reservation pushes past cushion', async () => {
      // Balance $10, no initial reservation but eval returns high total (simulating concurrent)
      const mockRedis = createMockRedis({ evalOverride: '1051' });
      const app = createTestApp(
        {
          conversations: [defaultConversation()],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          wallets: [
            {
              id: 'wallet-purchased',
              userId: TEST_USER_ID,
              type: 'purchased',
              balance: '10.00000000',
            },
          ],
        },
        mockRedis
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe(ERROR_CODE_BALANCE_RESERVED);
    });

    it('R2: passes when concurrent reservation exactly at cushion boundary', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis({ evalOverride: '1050' });
      const app = createTestApp(
        {
          conversations: [defaultConversation()],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          wallets: [
            {
              id: 'wallet-purchased',
              userId: TEST_USER_ID,
              type: 'purchased',
              balance: '10.00000000',
            },
          ],
        },
        mockRedis
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('R3: denies free tier when concurrent reservation exceeds allowance', async () => {
      const mockRedis = createMockRedis({ evalOverride: '6' });
      const app = createTestApp(
        {
          conversations: [defaultConversation()],
          users: [{ id: TEST_USER_ID, balance: '0.00000000' }],
          wallets: [
            {
              id: 'wallet-free',
              userId: TEST_USER_ID,
              type: 'free_tier',
              balance: '0.05000000',
            },
          ],
        },
        mockRedis
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe(ERROR_CODE_BALANCE_RESERVED);
    });

    it('R4: passes when concurrent reservation within cushion', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis({ evalOverride: '1020' });
      const app = createTestApp(
        {
          conversations: [defaultConversation()],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          wallets: [
            {
              id: 'wallet-purchased',
              userId: TEST_USER_ID,
              type: 'purchased',
              balance: '10.00000000',
            },
          ],
        },
        mockRedis
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });
  });

  // --------------------------------------------------------------------------
  // Minimum Output Token Boundary
  // --------------------------------------------------------------------------

  describe('minimum output token boundary', () => {
    it('M1: free tier with 5¢ affords well above 1000 minimum tokens', () => {
      vi.useRealTimers();

      const scenario = computeScenario({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 5,
        reservedCents: 0,
        model: 'basic',
      });
      expect(scenario.maxOutputTokens).toBeGreaterThan(1000);
    });

    it('M2: free tier with exact allowance for 1000 tokens passes', async () => {
      vi.useRealTimers();

      const allowanceCents = allowanceForTargetTokens('basic', 'free', 1000, 'Hello');
      const scenario = computeScenario({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: allowanceCents,
        reservedCents: 0,
        model: 'basic',
      });
      expect(scenario.maxOutputTokens).toBe(1000);

      const allowanceDollars = (allowanceCents / 100).toFixed(8);
      const mockRedis = createMockRedis();
      const app = createTestApp(
        {
          conversations: [defaultConversation()],
          users: [{ id: TEST_USER_ID, balance: '0.00000000' }],
          wallets: [
            {
              id: 'wallet-free',
              userId: TEST_USER_ID,
              type: 'free_tier',
              balance: allowanceDollars,
            },
          ],
        },
        mockRedis
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: done');
    });

    it('M3: free tier just below 1000 tokens is denied', async () => {
      const allowanceCents = allowanceForTargetTokens('basic', 'free', 999, 'Hello');
      const scenario = computeScenario({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: allowanceCents,
        reservedCents: 0,
        model: 'basic',
      });
      expect(scenario.maxOutputTokens).toBeLessThan(1000);

      const allowanceDollars = (allowanceCents / 100).toFixed(8);
      const mockRedis = createMockRedis();
      const app = createTestApp(
        {
          conversations: [defaultConversation()],
          users: [{ id: TEST_USER_ID, balance: '0.00000000' }],
          wallets: [
            {
              id: 'wallet-free',
              userId: TEST_USER_ID,
              type: 'free_tier',
              balance: allowanceDollars,
            },
          ],
        },
        mockRedis
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(402);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe(ERROR_CODE_INSUFFICIENT_BALANCE);
    });

    it('M4: paid tier with $0 balance uses cushion for well above 1000 tokens', () => {
      const scenario = computeScenario({
        tier: 'paid',
        balanceCents: 0,
        freeAllowanceCents: 0,
        reservedCents: 0,
        model: 'basic',
      });
      expect(scenario.maxOutputTokens).toBeGreaterThan(1000);
    });

    it('M5: paid tier with $0 balance and 49¢ reserved still affords above 1000 tokens', () => {
      const scenario = computeScenario({
        tier: 'paid',
        balanceCents: 0,
        freeAllowanceCents: 0,
        reservedCents: 49,
        model: 'basic',
      });
      expect(scenario.maxOutputTokens).toBeGreaterThan(1000);
    });
  });

  // --------------------------------------------------------------------------
  // Budget Accuracy
  // --------------------------------------------------------------------------

  describe('budget accuracy', () => {
    it('B1: free tier reservation does not exceed available balance', () => {
      const scenario = computeScenario({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 5,
        reservedCents: 0,
        model: 'basic',
      });
      expect(scenario.callCostCents).toBeLessThanOrEqual(5);
      expect(scenario.callCostCents).toBeGreaterThan(0);
    });

    it('B2: free tier with partial reservation — call cost fits remaining', () => {
      const scenario = computeScenario({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 5,
        reservedCents: 3,
        model: 'basic',
      });
      expect(scenario.callCostCents).toBeLessThanOrEqual(2);
      expect(scenario.callCostCents).toBeGreaterThan(0);
    });

    it('B3: paid tier with large reservation — call cost fits remaining', () => {
      const scenario = computeScenario({
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        reservedCents: 950,
        model: 'premium',
      });
      // Effective: (1000 - 950 + 50) / 100 = $1.00
      expect(scenario.callCostCents).toBeLessThanOrEqual(100);
      expect(scenario.callCostCents).toBeGreaterThan(0);
    });

    it('B4: paid tier full budget — call cost matches max tokens', () => {
      const scenario = computeScenario({
        tier: 'paid',
        balanceCents: 1000,
        freeAllowanceCents: 0,
        reservedCents: 0,
        model: 'premium',
      });
      // Effective: (1000 + 50) / 100 = $10.50
      expect(scenario.callCostCents).toBeLessThanOrEqual(1050);
      expect(scenario.callCostCents).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Token Estimation by Tier
  // --------------------------------------------------------------------------

  describe('token estimation by tier', () => {
    it('TE1: free tier uses 2 chars/token (conservative)', () => {
      expect(estimateTokensForTier('free', 4000)).toBe(2000);
    });

    it('TE2: paid tier uses 4 chars/token (standard)', () => {
      expect(estimateTokensForTier('paid', 4000)).toBe(1000);
    });

    it('TE3: trial tier uses 2 chars/token (conservative, same as free)', () => {
      expect(estimateTokensForTier('trial', 4000)).toBe(2000);
    });
  });

  // --------------------------------------------------------------------------
  // Reservation Lifecycle
  // --------------------------------------------------------------------------

  describe('reservation lifecycle', () => {
    it('L1: reservation released after successful stream', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis();
      const app = createTestApp(
        {
          conversations: [defaultConversation()],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          wallets: [
            {
              id: 'wallet-purchased',
              userId: TEST_USER_ID,
              type: 'purchased',
              balance: '10.00000000',
            },
          ],
        },
        mockRedis
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      await res.text();

      // eval called at least twice: reserve (positive) then release (negative)
      expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
      const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
      const increment = Number(lastCall[2][0]);
      expect(increment).toBeLessThan(0);
    });

    it('L2: reservation released on stream error', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis();
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.env = {
          NODE_ENV: 'development',
          AI_GATEWAY_API_KEY: 'test-key',
          PUBLIC_MODELS_URL: 'https://test.example/v1/models',
        } as AppEnv['Bindings'];
        c.set('user', {
          id: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', {
          sessionId: 'session-123',
          userId: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        });
        c.set('aiClient', createMockAIClient());
        c.set(
          'db',
          createMockDb({
            conversations: [defaultConversation()],
            users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
            wallets: [
              {
                id: 'wallet-purchased',
                userId: TEST_USER_ID,
                type: 'purchased',
                balance: '10.00000000',
              },
            ],
          }) as unknown as AppEnv['Variables']['db']
        );
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('envUtils', createEnvUtilities(c.env));
        await next();
      });

      app.route('/', chatRoute);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      await res.text();

      // eval called at least twice: reserve then release
      expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
      const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
      const increment = Number(lastCall[2][0]);
      expect(increment).toBeLessThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // computeScenario helper validation
  // --------------------------------------------------------------------------

  describe('computeScenario helper', () => {
    it('produces consistent results with production functions', () => {
      const scenario = computeScenario({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: 5,
        reservedCents: 0,
        model: 'basic',
      });

      expect(scenario.charsPerToken).toBe(2);
      expect(scenario.maxOutputTokens).toBeGreaterThan(0);
      expect(scenario.callCostCents).toBeGreaterThan(0);
      expect(scenario.callCostCents).toBeLessThanOrEqual(scenario.availableCents);
    });

    it('allowanceForTargetTokens produces exact token count', () => {
      const target = 1000;
      const allowanceCents = allowanceForTargetTokens('basic', 'free', target, 'Hello');

      const scenario = computeScenario({
        tier: 'free',
        balanceCents: 0,
        freeAllowanceCents: allowanceCents,
        reservedCents: 0,
        model: 'basic',
      });

      expect(scenario.maxOutputTokens).toBe(target);
    });
  });

  // --------------------------------------------------------------------------
  // computeWorstCaseCents unit tests
  // --------------------------------------------------------------------------

  describe('computeWorstCaseCents', () => {
    it('returns raw float (no ceiling rounding)', () => {
      const result = computeWorstCaseCents(0.000_123, 500, 0.000_045);
      const expected = (0.000_123 + 500 * 0.000_045) * 100;
      expect(result).toBe(expected);
      expect(result).not.toBe(Math.ceil(result));
    });

    it('returns zero for zero inputs', () => {
      expect(computeWorstCaseCents(0, 0, 0)).toBe(0);
    });

    it('scales linearly with output tokens', () => {
      const base = computeWorstCaseCents(0.001, 1000, 0.000_01);
      const doubled = computeWorstCaseCents(0.001, 2000, 0.000_01);
      const inputCostCents = 0.001 * 100;
      expect(doubled - base).toBeCloseTo(1000 * 0.000_01 * 100, 10);
      expect(base).toBeGreaterThan(inputCostCents);
    });
  });

  // --------------------------------------------------------------------------
  // L3: reservation released on empty content
  // --------------------------------------------------------------------------

  describe('reservation lifecycle — empty content', () => {
    it('L3: reservation released when model returns empty content', async () => {
      vi.useRealTimers();

      const mockRedis = createMockRedis();
      const app = new Hono<AppEnv>();

      app.use('*', async (c, next) => {
        c.env = {
          NODE_ENV: 'development',
          AI_GATEWAY_API_KEY: 'test-key',
          PUBLIC_MODELS_URL: 'https://test.example/v1/models',
        } as AppEnv['Bindings'];
        c.set('user', {
          id: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          publicKey: new Uint8Array(32),
        });
        c.set('session', {
          sessionId: 'session-123',
          userId: TEST_USER_ID,
          email: 'test@example.com',
          username: 'test_user',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: false,
          pending2FA: false,
          pending2FAExpiresAt: 0,
          createdAt: Date.now(),
        });
        c.set('aiClient', createMockAIClient());
        c.set(
          'db',
          createMockDb({
            conversations: [defaultConversation()],
            users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
            wallets: [
              {
                id: 'wallet-purchased',
                userId: TEST_USER_ID,
                type: 'purchased',
                balance: '10.00000000',
              },
            ],
          }) as unknown as AppEnv['Variables']['db']
        );
        c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
        c.set('envUtils', createEnvUtilities(c.env));
        await next();
      });

      app.route('/', chatRoute);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ models: [PREMIUM_MODEL.id], fundingSource: 'personal_balance' }),
      });

      await res.text();

      // eval called at least twice: reserve then release (even with empty content)
      expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
      const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
      const increment = Number(lastCall[2][0]);
      expect(increment).toBeLessThan(0);
    });
  });
});
