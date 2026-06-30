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
  ERROR_CODE_BILLING_MISMATCH,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  FEATURE_FLAGS,
  createEnvUtilities,
} from '@hushbox/shared';
import { clearModelCache } from '@hushbox/shared/models';
import { generateKeyPair } from '@hushbox/crypto';
import { chatRoute, lookupMediaModels } from './chat.js';
import { createMockAIClient } from '../services/ai/mock.js';
import type { AppEnv } from '../types.js';
import type { InferenceEvent } from '../services/ai/types.js';
import type { MediaStorage } from '../services/storage/index.js';

/**
 * Public `/v1/models` fixture shape. `publicModelsFixture` (module-scoped
 * below) is the per-test seed for the `fetch` mock so chat tests can swap the
 * served catalog without rebuilding every fetch handler. Both mock and real
 * AIClient source the catalog from `fetchModels`, which parses this shape.
 * `pricing` is `Record<string, unknown>` so video/image-specific variants
 * (`video_duration_pricing`, `image_dimension_quality_pricing`) fit without
 * cast gymnastics.
 */
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

/** Type-safe JSON response parser for test assertions. */
async function jsonBody<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** Inline MediaStorage stub for tests that don't exercise the storage path. */
function stubMediaStorage(): MediaStorage {
  return {
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    list: () => Promise.resolve({ objects: [] }),
    mintDownloadUrl: () =>
      Promise.resolve({ url: 'data:,', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
  };
}

/** Detect classifier system prompt without coupling to its exact wording. */
function classifierSystemPromptDetected(request: { messages?: unknown[] }): boolean {
  const messages = request.messages ?? [];
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const candidate = m as { role?: string; content?: unknown };
    if (candidate.role !== 'system') continue;
    if (typeof candidate.content !== 'string') continue;
    if (candidate.content.startsWith('[HUSHBOX_CLASSIFIER]')) return true;
  }
  return false;
}

// Generate a valid X25519 key pair so epoch encryption in saveChatTurn works.
const testEpochKeyPair = generateKeyPair();

const TEST_CONVERSATION_ID = '11111111-1111-1111-8111-111111111111';
const TEST_USER_ID = 'user-123';
const TEST_USER_MESSAGE_ID = '22222222-2222-2222-8222-222222222222';

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

/** Build a valid stream request body with all required fields. */
function streamBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    models: ['openai/gpt-5'],
    userMessage: {
      id: TEST_USER_MESSAGE_ID,
      content: 'Hello',
    },
    messagesForInference: [{ role: 'user', content: 'Hello' }],
    fundingSource: 'personal_balance',
    ...overrides,
  });
}

const mockModels = [
  {
    id: 'openai/gpt-5',
    name: 'GPT-5',
    description: 'Premium model',
    modality: 'text' as const,
    context_length: 128_000,
    // Dual-shape: `prompt`/`completion` for the ZDR /endpoints/zdr endpoint
    // (consumed by zdr filtering); `input`/`output` for the public /v1/models
    // endpoint (consumed by `fetchModels` and surfaced as `RawModel.pricing`
    // → `ModelInfo.pricing.inputPerToken/outputPerToken`). Both shapes are
    // required because each downstream parser reads its own key names.
    pricing: { prompt: '0.00001', completion: '0.00003', input: '0.00001', output: '0.00003' },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    description: 'Fast text model',
    modality: 'text' as const,
    context_length: 200_000,
    pricing: {
      prompt: '0.000003',
      completion: '0.000015',
      input: '0.000003',
      output: '0.000015',
    },
    supported_parameters: ['temperature'],
    created: Math.floor(Date.now() / 1000),
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  },
];

/**
 * Media model fixtures in public `/v1/models` shape — appended to the default
 * catalog so multi-modality tests can resolve image/video/audio models without
 * each test having to seed `publicModelsFixture` manually. The video entry
 * uses `video_duration_pricing` so `fetchModels` populates
 * `per_second_by_resolution` correctly.
 */
const MEDIA_MODEL_FIXTURES: PublicModelFixture[] = [
  {
    id: 'google/imagen-4.0-generate-001',
    name: 'Imagen 4',
    description: 'High-quality image generation',
    type: 'image',
    pricing: { image: '0.04' },
  },
  {
    id: 'google/imagen-4.0-fast-generate-001',
    name: 'Imagen 4 Fast',
    description: 'Fast image generation',
    type: 'image',
    pricing: { image: '0.04' },
  },
  {
    id: 'google/veo-3.1-generate-001',
    name: 'Veo 3.1',
    description: 'Video generation with audio',
    type: 'video',
    pricing: {
      video_duration_pricing: [
        { resolution: '720p', audio: true, cost_per_second: '0.4' },
        { resolution: '1080p', audio: true, cost_per_second: '0.4' },
      ],
    },
  },
  {
    id: 'openai/tts-1',
    name: 'TTS-1',
    description: 'Text-to-speech audio',
    type: 'audio',
    pricing: { input: '0', output: '0' },
  },
];

/**
 * Create a mock database for testing.
 * Supports the epoch-based saveChatTurn transaction pattern.
 */
interface MockConversationMember {
  id: string;
  userId: string;
  conversationId: string;
  privilege: string;
  visibleFromEpoch: number;
}

interface MockMemberBudget {
  budget: string;
  spent: string;
}

interface MockConversationSpending {
  totalSpent: string;
}

function defaultConversationMemberRows(
  conversations: MockConversation[]
): MockConversationMember[] {
  return [
    {
      id: 'member-owner',
      userId: conversations[0]?.userId ?? 'unknown',
      conversationId: conversations[0]?.id ?? 'unknown',
      privilege: 'owner',
      visibleFromEpoch: 1,
    },
  ];
}

function defaultWalletsForUsers(users: MockUser[]): MockWallet[] {
  return users.map((u) => ({
    id: `wallet-${u.id}`,
    userId: u.id,
    type: 'purchased',
    balance: u.balance,
  }));
}

/* eslint-disable unicorn/no-thenable -- test mock for Drizzle query builder which uses .then() */
function createThenable<T>(value: T) {
  return {
    then: (resolve: (v: T) => unknown) => Promise.resolve(resolve(value)),
    limit: (n: number) => ({
      then: (resolve: (v: T) => unknown) => {
        const sliced = Array.isArray(value) ? (value.slice(0, n) as T) : value;
        return Promise.resolve(resolve(sliced));
      },
    }),
    orderBy: () => createThenable(value),
  };
}
/* eslint-enable unicorn/no-thenable */

const INSERT_RETURNING_FIXTURES = new Map<unknown, unknown[]>([
  [usageRecordsTable, [{ id: 'usage-record-123' }]],
  [llmCompletionsTable, [{ id: 'llm-completion-123' }]],
  [ledgerEntriesTable, [{ id: 'ledger-entry-123' }]],
]);

function buildInsertReturning(table: unknown, values: unknown): Promise<unknown[]> {
  const fixture = INSERT_RETURNING_FIXTURES.get(table);
  if (fixture !== undefined) return Promise.resolve(fixture);
  if (table === messagesTable) return Promise.resolve([values]);
  return Promise.resolve([values]);
}

interface MockDbState {
  nextSequence: number;
  currentEpoch: number;
}

/* eslint-disable unicorn/no-thenable -- mock Drizzle query result chains end in .then() */
function buildUpdateChain(
  table: unknown,
  setValues: Record<string, unknown>,
  state: MockDbState,
  wallets: MockWallet[]
) {
  if (table === conversationsTable && setValues['nextSequence']) {
    // saveChatTurn (increments by 2) / saveUserOnlyMessage (increments by 1)
    const seq = state.nextSequence;
    const userSeq = state.nextSequence;
    const aiSeq = state.nextSequence + 1;
    state.nextSequence += 2;
    return {
      returning: () => Promise.resolve([{ seq, userSeq, aiSeq, currentEpoch: state.currentEpoch }]),
      then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
    };
  }
  if (table === walletsTable) {
    // chargeForUsage: deduct from wallet
    const wallet = wallets[0];
    return {
      returning: () =>
        Promise.resolve(
          wallet ? [{ id: wallet.id, type: wallet.type, balance: '9.99000000' }] : []
        ),
      then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
    };
  }
  return {
    returning: () => Promise.resolve([{}]),
    then: (resolve: (v?: unknown) => unknown) => Promise.resolve(resolve()),
  };
}
/* eslint-enable unicorn/no-thenable */

/**
 * Joins conversationMemberRows with memberBudgetRows (1:1 by index) to model
 * the shape returned by `getConversationBudgets`.
 */
function joinConversationMembersWithBudgets(
  rows: Pick<MockDbRows, 'conversationMemberRows' | 'memberBudgetRows'>
): {
  memberId: string;
  userId: string | null;
  linkId: null;
  privilege: string;
  budget: string | null;
  spent: string | null;
}[] {
  return rows.conversationMemberRows.map((cm, index) => {
    const mb = rows.memberBudgetRows[index];
    return {
      memberId: cm.id,
      userId: cm.userId,
      linkId: null,
      privilege: cm.privilege,
      budget: mb?.budget ?? null,
      spent: mb?.spent ?? null,
    };
  });
}

// Build db operations object with nested transaction support.
// chargeForUsage calls db.transaction() on the passed-in tx,
// so the mock ops object itself must support .transaction().
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

interface MockDbRows {
  conversations: MockConversation[];
  users: MockUser[];
  wallets: MockWallet[];
  conversationMemberRows: MockConversationMember[];
  memberBudgetRows: MockMemberBudget[];
  conversationSpendingRows: MockConversationSpending[];
}

/**
 * Map-based dispatch: resolves a where() call based on the table being
 * queried. Shared between direct `.from(table).where()` and
 * `.from(table).leftJoin().where()` paths. The closures share counters via
 * the returned mutable state so multi-user fixtures can cycle through
 * `users[]` round-robin.
 */
function buildTableResolvers(
  rows: MockDbRows
): Map<unknown, () => ReturnType<typeof createThenable>> {
  // Counter-based multi-user support: cycles through users array per query.
  // getUserTierInfo queries wallets (not users) to compute balance,
  // so wallets needs its own independent cycling counter.
  let usersQueryCount = 0;
  let walletsQueryCount = 0;
  return new Map<unknown, () => ReturnType<typeof createThenable>>([
    [conversationsTable, () => createThenable(rows.conversations)],
    [
      usersTable,
      () => {
        const lastQueriedUserIndex = usersQueryCount % rows.users.length;
        usersQueryCount++;
        const user = rows.users[lastQueriedUserIndex];
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
        const walletUserIndex = walletsQueryCount % rows.users.length;
        walletsQueryCount++;
        const userForWallets = rows.users[walletUserIndex];
        return createThenable(
          userForWallets ? rows.wallets.filter((w) => w.userId === userForWallets.id) : rows.wallets
        );
      },
    ],
    [epochsTable, () => createThenable([{ epochPublicKey: testEpochKeyPair.publicKey }])],
    [ledgerEntriesTable, () => createThenable([{ maxCreatedAt: null }])],
    [conversationMembersTable, () => createThenable(rows.conversationMemberRows)],
    [memberBudgetsTable, () => createThenable(rows.memberBudgetRows)],
    [conversationSpendingTable, () => createThenable(rows.conversationSpendingRows)],
  ]);
}

interface CreateMockDbOptions {
  conversations?: MockConversation[];
  users?: MockUser[];
  wallets?: MockWallet[];
  onInsert?: (table: unknown, values: unknown) => void;
  conversationMemberRows?: MockConversationMember[];
  memberBudgetRows?: MockMemberBudget[];
  conversationSpendingRows?: MockConversationSpending[];
}

/**
 * Materializes the rows the mock will serve, applying defaults for every
 * undefined option. Keeps the dispatch builder (`createMockDb`) free of
 * fallback branches.
 */
function normalizeMockDbRows(options: CreateMockDbOptions): MockDbRows {
  const conversations = options.conversations ?? [];
  const users = options.users ?? [];
  return {
    conversations,
    users,
    wallets: options.wallets ?? defaultWalletsForUsers(users),
    conversationMemberRows:
      options.conversationMemberRows ?? defaultConversationMemberRows(conversations),
    memberBudgetRows: options.memberBudgetRows ?? [],
    conversationSpendingRows: options.conversationSpendingRows ?? [],
  };
}

function createMockDb(options: CreateMockDbOptions) {
  const rows = normalizeMockDbRows(options);
  const onInsert = options.onInsert;
  const state: MockDbState = {
    nextSequence: rows.conversations[0]?.nextSequence ?? 0,
    currentEpoch: rows.conversations[0]?.currentEpoch ?? 1,
  };
  const tableResolvers = buildTableResolvers(rows);

  function resolveWhere(table: unknown) {
    return tableResolvers.get(table)?.() ?? createThenable([]);
  }

  const dbOps: MockDbOps = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => resolveWhere(table),
        // leftJoin support: getConversationBudgets joins conversationMembers with memberBudgets
        leftJoin: () => ({
          where: () => createThenable(joinConversationMembersWithBudgets(rows)),
        }),
        // innerJoin support: submitRotation joins conversationMembers with users/sharedLinks
        innerJoin: () => ({
          where: () => resolveWhere(table),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        onInsert?.(table, values);
        return {
          returning: () => buildInsertReturning(table, values),
          // updateGroupSpending uses insert().values().onConflictDoUpdate()
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (setValues: Record<string, unknown>) => ({
        where: () => buildUpdateChain(table, setValues, state, rows.wallets),
      }),
    }),
    // delete support: submitRotation deletes old epochMembers
    delete: () => ({
      where: () => Promise.resolve(),
    }),
    // Nested transaction support: reuses same ops (mimics Drizzle savepoint behavior)
    transaction: async <T>(callback: (tx: MockDbOps) => Promise<T>): Promise<T> => {
      return callback(dbOps);
    },
  };

  return dbOps;
}

function createMockRedis(evalReturnValue = '0') {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(evalReturnValue),
    scan: vi.fn().mockResolvedValue([0, []]),
  };
}

function createTestApp(
  dbOptions?: Parameters<typeof createMockDb>[0],
  redisOverride?: ReturnType<typeof createMockRedis>,
  // Pre-seeds `linkGuest` on context before requirePrivilege runs. When the
  // session user is set (this helper's default), requirePrivilege's auth
  // path doesn't touch the linkGuest slot, so the preset survives into the
  // handler. Lets a focused tier-gate test exercise the
  // `!linkGuest && callerId === ownerId` predicate without standing up the
  // full sharedLinks → conversationMembers mock chain. Existing callers that
  // pass `undefined` here (slot-3 was previously an unused placeholder) keep
  // working unchanged.
  linkGuestOverride?: { linkId: string; publicKey: Uint8Array } | null,
  aiClientOverride?: AppEnv['Variables']['aiClient']
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

  const defaultDbOptions = {
    conversations: [
      {
        id: TEST_CONVERSATION_ID,
        userId: TEST_USER_ID,
        title: 'Test Conversation',
        currentEpoch: 1,
        nextSequence: 1,
        conversationBudget: '100.00',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    users: [
      {
        id: TEST_USER_ID,
        balance: '10.00000000',
      },
    ],
  };

  const mockRedis = redisOverride ?? createMockRedis();

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'development',
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    } as AppEnv['Bindings'];
    c.set('user', mockUser);
    c.set('session', mockSession);
    c.set('aiClient', aiClientOverride ?? createMockAIClient());
    c.set('mediaStorage', stubMediaStorage());
    c.set(
      'db',
      createMockDb(dbOptions ?? defaultDbOptions) as unknown as AppEnv['Variables']['db']
    );
    c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
    c.set('envUtils', createEnvUtilities(c.env));
    if (linkGuestOverride !== undefined && linkGuestOverride !== null) {
      c.set('linkGuest', linkGuestOverride);
    }
    await next();
  });

  app.route('/', chatRoute);
  return app;
}

function createUnauthenticatedTestApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.env = {
      NODE_ENV: 'development',
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    } as AppEnv['Bindings'];
    c.set('user', null);
    c.set('session', null);
    c.set('aiClient', createMockAIClient());
    c.set('db', createMockDb({}) as unknown as AppEnv['Variables']['db']);
    c.set('envUtils', createEnvUtilities(c.env));
    await next();
  });

  app.route('/', chatRoute);
  return app;
}

describe('chat routes', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    clearModelCache();
    fetchMock = vi.fn() as FetchMock;
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));

    publicModelsFixture = [
      ...mockModels.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        type: 'language',
        pricing: { input: m.pricing.prompt, output: m.pricing.completion },
        context_window: m.context_length,
        created: m.created,
      })),
      ...MEDIA_MODEL_FIXTURES,
    ];

    fetchMock.mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: publicModelsFixture }),
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    publicModelsFixture = [];
  });

  describe('POST /stream', () => {
    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(401);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when required body fields are missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: ['openai/gpt-5'] }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 when models is missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('streams SSE response for valid request', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    });

    it('returns start event with assistantMessageId', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('"assistantMessageId"');
    });

    it('returns token events with content', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: token');
      expect(text).toContain('"content"');
    });

    it('returns done event with epoch metadata', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: done');
      expect(text).toContain('"userSequence"');
      expect(text).toContain('"aiSequence"');
      expect(text).toContain('"epochNumber"');
      expect(text).toContain('"cost"');
      expect(text).toContain('"userMessageId"');
      expect(text).toContain('"assistantMessageId"');
    });

    it('returns error event when stream fails', async () => {
      vi.useRealTimers();

      const app = new Hono<AppEnv>();
      const failingAi = createMockAIClient({ failingModels: ['openai/gpt-5'] });

      const mockDb = createMockDb({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '10.00000000',
          },
        ],
      });

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
        c.set('aiClient', failingAi);
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        c.set('envUtils', createEnvUtilities(c.env));
        await next();
      });
      app.route('/', chatRoute);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('unavailable');
    });

    it('returns 404 when conversation not found', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 404 when conversation belongs to another user', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: 'other-user',
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        conversationMemberRows: [],
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 403 MODEL_TIER_LOCKED when free-tier user picks a premium model', async () => {
      // Premium model + zero balance → free tier → MODEL_TIER_LOCKED gate
      // fires before billing reservation. Distinct from the balance-only
      // PREMIUM_REQUIRES_BALANCE case (which is for paid users with $0).
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '0.00000000',
          },
        ],
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(403);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('MODEL_TIER_LOCKED');
      expect(body.details?.['modelId']).toBe('openai/gpt-5');
    });

    it('returns 403 MODEL_TIER_LOCKED for premium model when balance is negative', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '-5.00000000',
          },
        ],
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      expect(res.status).toBe(403);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('MODEL_TIER_LOCKED');
      expect(body.details?.['modelId']).toBe('openai/gpt-5');
    });

    it('skips MODEL_TIER_LOCKED when caller is a link guest (predicate at chat.ts:1152)', async () => {
      // The tier gate fires only when `!linkGuest && callerId === ownerId`.
      // With the same fixture as the free-tier test above (zero balance,
      // premium model — which DOES return MODEL_TIER_LOCKED for a direct-
      // billing caller), pre-seeding linkGuest on context must flip the
      // predicate to false and let the request fall through to
      // resolveGuestBillingContext. This pins both halves of the predicate:
      // changing it to `callerId === ownerId` (dropping the linkGuest term)
      // would re-fire MODEL_TIER_LOCKED here and the test catches the
      // regression.
      const app = createTestApp(
        {
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            {
              id: TEST_USER_ID,
              balance: '0.00000000',
            },
          ],
        },
        undefined,
        { linkId: 'link-test-1', publicKey: new Uint8Array(32) }
      );

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      // The tier gate is the assertion under test. Whatever the downstream
      // billing path returns is irrelevant here — the predicate must NOT
      // surface as MODEL_TIER_LOCKED for a link-guest caller.
      const body: ErrorBody = await res.json();
      expect(body.code).not.toBe('MODEL_TIER_LOCKED');
    });

    it('returns 400 when last message is not from user', async () => {
      const app = createTestApp();

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({
          messagesForInference: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('LAST_MESSAGE_NOT_USER');
    });

    it('returns 400 when messagesForInference is empty', async () => {
      const app = createTestApp();

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({ messagesForInference: [] }),
      });

      // Zod schema requires at least 1 message (.min(1))
      expect(res.status).toBe(400);
    });

    it('saves messages via saveChatTurn after stream completes', async () => {
      vi.useRealTimers();

      const insertedMessages: unknown[] = [];

      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [
          {
            id: TEST_USER_ID,
            balance: '10.00000000',
          },
        ],
        onInsert: (table, values) => {
          if (table === messagesTable) {
            insertedMessages.push(values);
          }
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody(),
      });

      // Consume the stream to trigger the insert
      await res.text();

      // saveChatTurn inserts user + assistant messages
      expect(insertedMessages.length).toBe(2);

      const userMsg = insertedMessages[0] as Record<string, unknown>;
      expect(userMsg).toMatchObject({
        conversationId: TEST_CONVERSATION_ID,
        senderType: 'user',
        epochNumber: 1,
      });

      const aiMsg = insertedMessages[1] as Record<string, unknown>;
      expect(aiMsg).toMatchObject({
        conversationId: TEST_CONVERSATION_ID,
        senderType: 'ai',
      });
    });

    it('includes userMessageId in start event', async () => {
      vi.useRealTimers();
      const knownId = '44444444-4444-4444-8444-444444444444';
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: streamBody({
          userMessage: { id: knownId, content: 'Test message' },
        }),
      });

      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain(`"userMessageId":"${knownId}"`);
    });

    describe('cost calculation routing', () => {
      it('uses inline cost from stream for billing', async () => {
        vi.useRealTimers();

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });

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
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          c.set('envUtils', createEnvUtilities(c.env));
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        const body = await res.text();

        expect(res.status).toBe(200);
        expect(body).toContain('event: done');
      });
    });

    describe('client disconnect handling', () => {
      it('saves complete message when SSE write fails mid-stream', async () => {
        vi.useRealTimers();

        const insertedMessages: unknown[] = [];

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          onInsert: (table, values) => {
            if (table === messagesTable) {
              insertedMessages.push(values);
            }
          },
        });

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
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          c.set('envUtils', createEnvUtilities(c.env));
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text().catch(() => {
          // Intentionally ignore - we only care about verifying the message was inserted
        });

        // saveChatTurn inserts both user and assistant messages
        expect(insertedMessages.length).toBe(2);

        const aiMsg = insertedMessages[1] as Record<string, unknown>;
        expect(aiMsg).toMatchObject({
          conversationId: TEST_CONVERSATION_ID,
          senderType: 'ai',
        });
      });

      it('triggers billing even when client disconnects', async () => {
        vi.useRealTimers();

        const insertedMessages: unknown[] = [];
        let usageRecordInserted = false;

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          onInsert: (table, values) => {
            if (table === messagesTable) {
              insertedMessages.push(values);
            }
            if (table === usageRecordsTable) {
              usageRecordInserted = true;
            }
          },
        });

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
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          c.set('envUtils', createEnvUtilities(c.env));
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // Give billing time to fire (it's async/fire-and-forget)
        await new Promise((resolve) => setTimeout(resolve, 50));

        // saveChatTurn inserts both messages
        expect(insertedMessages.length).toBe(2);
        // chargeForUsage inserts usage record inside the transaction
        expect(usageRecordInserted).toBe(true);
      });
    });

    describe('concurrent requests', () => {
      it('handles multiple simultaneous stream requests independently', async () => {
        vi.useRealTimers();

        const app = createTestApp();

        // Start two concurrent stream requests
        const [res1, res2] = await Promise.all([
          app.request(`/${TEST_CONVERSATION_ID}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody(),
          }),
          app.request(`/${TEST_CONVERSATION_ID}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody(),
          }),
        ]);

        // Both should succeed (200 status)
        expect(res1.status).toBe(200);
        expect(res2.status).toBe(200);

        // Both should return SSE content
        const [text1, text2] = await Promise.all([res1.text(), res2.text()]);

        expect(text1).toContain('event: start');
        expect(text1).toContain('event: done');
        expect(text2).toContain('event: start');
        expect(text2).toContain('event: done');
      });
    });

    describe('speculative balance reservation', () => {
      it('creates reservation via Redis eval on successful validation', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        expect(mockRedis.eval).toHaveBeenCalled();
      });

      it('returns 402 with balance reserved error when reservations exceed balance', async () => {
        const mockRedis = createMockRedis();
        mockRedis.get.mockResolvedValue(null);
        // First eval (reserve) returns a value > balance, triggering final check failure
        // Balance is $10 (1000 cents). We simulate reservation returning a huge total.
        mockRedis.eval.mockResolvedValueOnce('99999');

        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(402);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BALANCE_RESERVED);
      });

      it('allows request within 50-cent negative balance cushion', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis();
        mockRedis.get.mockResolvedValue(null);
        // Balance is $10 (1000 cents). Reservation returns 1040 total.
        // finalEffective = 1000 - 1040 = -40 cents, which is > -50 cents cushion.
        mockRedis.eval.mockResolvedValueOnce('1040');

        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('allows free tier user with free_allowance funding through race guard', async () => {
        vi.useRealTimers();

        // Override fetchMock: two models so the cheap one falls below the 75th-percentile premium threshold
        const cheapModel = {
          id: 'openai/gpt-4o-mini',
          name: 'GPT-3.5 Turbo',
          description: 'Basic model',
          context_length: 16_000,
          pricing: {
            prompt: '0.0000005',
            completion: '0.0000015',
            input: '0.0000005',
            output: '0.0000015',
          },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 60 * 60,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        };
        const expensiveModel = {
          ...mockModels[0],
          created: Math.floor(Date.now() / 1000) - 2 * 365 * 24 * 60 * 60,
        };
        const allModels = [cheapModel, expensiveModel];
        fetchMock.mockImplementation((url: string) => {
          const zdrEndpoints = allModels.map((m) => ({
            model_id: m.id,
            model_name: m.name,
            provider_name: 'Provider',
            context_length: m.context_length,
            pricing: m.pricing,
          }));
          if (url.includes('/endpoints/zdr')) {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ data: zdrEndpoints }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: allModels }),
          });
        });

        const mockRedis = createMockRedis('5');
        // Free tier: balance $0, free_tier wallet with $0.05 allowance
        const app = createTestApp(
          {
            conversations: [
              {
                id: TEST_CONVERSATION_ID,
                userId: TEST_USER_ID,
                title: 'Test Conversation',
                currentEpoch: 1,
                nextSequence: 1,
                conversationBudget: '100.00',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
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
          body: streamBody({ models: ['openai/gpt-4o-mini'], fundingSource: 'free_allowance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('releases reservation after successful stream', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // eval called at least twice: once for reserve, once for release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        // Last eval call should be release (negative increment)
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });

      it('releases reservation on stream error', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });

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
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
          c.set('envUtils', createEnvUtilities(c.env));
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // eval should be called for reserve + release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });

      it('releases reservation on empty content', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');

        const app = new Hono<AppEnv>();

        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });

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
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', mockRedis as unknown as AppEnv['Variables']['redis']);
          c.set('envUtils', createEnvUtilities(c.env));
          await next();
        });
        app.route('/', chatRoute);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        await res.text();

        // eval should be called for reserve + release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });

      it('proceeds normally when no existing reservations (Redis returns 0)', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('0.01');
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });
    });

    describe('broadcast integration', () => {
      /** Create a Hono app with a mock CONVERSATION_ROOM DO namespace for broadcast testing. */
      function createBroadcastApp(options: {
        conversations: MockConversation[];
        users: MockUser[];
        aiClientOverride?: AppEnv['Variables']['aiClient'];
      }): {
        app: ReturnType<typeof createTestApp>;
        mockStub: { fetch: Mock };
        broadcastBodies: unknown[];
      } {
        const broadcastBodies: unknown[] = [];
        const doId = { toString: () => 'mock-do-id' };
        const mockStub = {
          fetch: vi.fn().mockImplementation(async (req: Request) => {
            const pathname = new URL(req.url).pathname;
            // GET /presence is the active-viewer query used by push dispatch;
            // it carries no body and returns the userId list.
            if (pathname === '/presence' && req.method === 'GET') {
              return Response.json(
                { userIds: [] },
                { headers: { 'Content-Type': 'application/json' } }
              );
            }
            const body: unknown = await req.json();
            broadcastBodies.push(body);
            return Response.json({ sent: 1 }, { headers: { 'Content-Type': 'application/json' } });
          }),
        };
        const mockNamespace = {
          idFromName: vi.fn().mockReturnValue(doId),
          get: vi.fn().mockReturnValue(mockStub),
        };

        const app = new Hono<AppEnv>();
        const mockDb = createMockDb({
          ...options,
        });

        app.use('*', async (c, next) => {
          c.env = {
            NODE_ENV: 'development',
            AI_GATEWAY_API_KEY: 'test-key',
            PUBLIC_MODELS_URL: 'https://test.example/v1/models',
            CONVERSATION_ROOM: mockNamespace,
          } as unknown as AppEnv['Bindings'];
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
          c.set('aiClient', options.aiClientOverride ?? createMockAIClient());
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          c.set('envUtils', createEnvUtilities(c.env));
          await next();
        });
        app.route('/', chatRoute);

        return { app, mockStub, broadcastBodies };
      }

      it('broadcasts message:new, message:stream, and message:complete events', async () => {
        vi.useRealTimers();
        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        // `broadcastBodies` only records POST /broadcast (the mock skips the
        // GET /presence call that push dispatch also makes). 3 broadcasts:
        // message:new, message:stream, message:complete.
        expect(broadcastBodies).toHaveLength(3);
        const eventTypes = broadcastBodies.map((b) => (b as Record<string, unknown>)['type']);
        expect(eventTypes).toContain('message:new');
        expect(eventTypes).toContain('message:stream');
        expect(eventTypes).toContain('message:complete');
      });

      it('sends early message:new broadcast with content', async () => {
        vi.useRealTimers();
        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const messageNew = broadcastBodies.find(
          (b) => (b as Record<string, unknown>)['type'] === 'message:new'
        ) as Record<string, unknown>;
        expect(messageNew).toBeDefined();
        expect(messageNew['senderType']).toBe('user');
        expect(messageNew['senderId']).toBe(TEST_USER_ID);
        expect(messageNew['content']).toBe('Hello');
        expect(messageNew['conversationId']).toBe(TEST_CONVERSATION_ID);
      });

      it('broadcastAndFinish only sends message:complete (no duplicate message:new)', async () => {
        vi.useRealTimers();
        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const messageNewEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:new'
        );
        expect(messageNewEvents).toHaveLength(1);
        const messageCompleteEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:complete'
        );
        expect(messageCompleteEvents).toHaveLength(1);
      });

      it('broadcasts the resolved model id (not "smart-model") in message:complete for Smart Model selections', async () => {
        vi.useRealTimers();
        // Sync the public-endpoint catalog with the smart-model fixture so eligibility resolves.
        publicModelsFixture = [
          {
            id: 'openai/gpt-5',
            name: 'GPT-5',
            description: 'A capable model',
            type: 'language',
            pricing: { input: '0.00001', output: '0.00003' },
          },
          {
            id: 'openai/gpt-4o-mini',
            name: 'GPT-4o Mini',
            description: 'A cheap model',
            type: 'language',
            pricing: { input: '0.000001', output: '0.000003' },
          },
        ];
        // Pick the cheap model from the fixture as the classifier resolution so the
        // assertion can avoid hardcoding any specific id.
        const expectedResolvedId = 'openai/gpt-4o-mini';
        const aiClient = createMockAIClient({
          classifierResolution: expectedResolvedId,
        });

        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          aiClientOverride: aiClient,
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['smart-model'] }),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));

        const messageCompleteEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:complete'
        );
        expect(messageCompleteEvents.length).toBeGreaterThanOrEqual(1);
        for (const event of messageCompleteEvents) {
          const payload = event as Record<string, unknown>;
          expect(payload['modelName']).toBe(expectedResolvedId);
          expect(payload['modelName']).not.toBe('smart-model');
        }
      });

      it('flushes remaining token buffer as message:stream after stream ends', async () => {
        vi.useRealTimers();
        const { app, broadcastBodies } = createBroadcastApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const streamEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:stream'
        );
        expect(streamEvents.length).toBeGreaterThanOrEqual(1);
        const allTokens = streamEvents
          .map((e) => (e as Record<string, unknown>)['token'] as string)
          .join('');
        expect(allTokens).toBe(`Echo:\nHello\n\n` + '```json\n{\n  "ok": true\n}\n```');
      });

      it('does not broadcast message:stream when no DO binding is present', async () => {
        vi.useRealTimers();
        const app = createTestApp();
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('broadcasts token content during streaming via Durable Object', async () => {
        vi.useRealTimers();
        const broadcastBodies: unknown[] = [];
        const doId = { toString: () => 'mock-do-id' };
        const mockStub = {
          fetch: vi.fn().mockImplementation(async (req: Request) => {
            const pathname = new URL(req.url).pathname;
            // GET /presence is the active-viewer query used by push dispatch;
            // it carries no body and returns the userId list.
            if (pathname === '/presence' && req.method === 'GET') {
              return Response.json(
                { userIds: [] },
                { headers: { 'Content-Type': 'application/json' } }
              );
            }
            const body: unknown = await req.json();
            broadcastBodies.push(body);
            return Response.json({ sent: 1 }, { headers: { 'Content-Type': 'application/json' } });
          }),
        };
        const mockNamespace = {
          idFromName: vi.fn().mockReturnValue(doId),
          get: vi.fn().mockReturnValue(mockStub),
        };
        const app = new Hono<AppEnv>();
        const mockDb = createMockDb({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 1,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        });
        app.use('*', async (c, next) => {
          c.env = {
            NODE_ENV: 'development',
            AI_GATEWAY_API_KEY: 'test-key',
            PUBLIC_MODELS_URL: 'https://test.example/v1/models',
            CONVERSATION_ROOM: mockNamespace,
          } as unknown as AppEnv['Bindings'];
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
          c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
          c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
          c.set('envUtils', createEnvUtilities(c.env));
          await next();
        });
        app.route('/', chatRoute);
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });
        await res.text();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const streamEvents = broadcastBodies.filter(
          (b) => (b as Record<string, unknown>)['type'] === 'message:stream'
        );
        // Mock AIClient streams instantly → all tokens batched into one flush on completion
        expect(streamEvents.length).toBeGreaterThanOrEqual(1);
        const allTokens = streamEvents
          .map((e) => (e as Record<string, unknown>)['token'] as string)
          .join('');
        // Mock echoes "Echo: <last user content>" — last user message is "Hello"
        expect(allTokens).toContain('Echo');
      });
    });

    describe('group budget validation', () => {
      const TEST_OWNER_ID = 'owner-user-999';
      const TEST_MEMBER_CM_ID = 'cm-member-1';

      it('allows conversation member to send message using group budget', async () => {
        vi.useRealTimers();

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID, // Owner is different from auth user
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            // Member first (buildBillingInput queries member wallet first)
            { id: TEST_USER_ID, balance: '0.00000000' },
            // Owner second (group path queries owner wallet second)
            { id: TEST_OWNER_ID, balance: '10.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('returns 404 when user is neither owner nor member', async () => {
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_OWNER_ID, balance: '10.00000000' }],
          conversationMemberRows: [], // No member record for test user
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(404);
      });

      it('falls back to personal balance when group budget is exhausted', async () => {
        vi.useRealTimers();

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            // Member first (buildBillingInput queries member wallet first)
            { id: TEST_USER_ID, balance: '10.00000000' },
            // Owner second — no balance (group budget exhausted)
            { id: TEST_OWNER_ID, balance: '0.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('returns 402 when both group and personal budgets are insufficient', async () => {
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '0.00000000' },
            { id: TEST_USER_ID, balance: '0.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(402);
      });

      it('releases group budget reservation after successful stream', async () => {
        vi.useRealTimers();

        const mockRedis = createMockRedis('5');
        const app = createTestApp(
          {
            conversations: [
              {
                id: TEST_CONVERSATION_ID,
                userId: TEST_OWNER_ID,
                title: 'Group Chat',
                currentEpoch: 1,
                nextSequence: 0,
                conversationBudget: '100.00',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
            users: [
              // Member first (buildBillingInput queries member wallet first)
              { id: TEST_USER_ID, balance: '0.00000000' },
              // Owner second (group path queries owner wallet second)
              { id: TEST_OWNER_ID, balance: '10.00000000' },
            ],
            conversationMemberRows: [
              {
                id: TEST_MEMBER_CM_ID,
                userId: TEST_USER_ID,
                conversationId: TEST_CONVERSATION_ID,
                privilege: 'write',
                visibleFromEpoch: 1,
              },
            ],
            memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
          },
          mockRedis
        );

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        await res.text();

        // Redis eval should be called for reservation and release
        expect(mockRedis.eval.mock.calls.length).toBeGreaterThanOrEqual(2);
        // Last eval call should be release (negative increment)
        const lastCall = mockRedis.eval.mock.calls.at(-1) as [string, string[], string[]];
        const increment = Number(lastCall[2][0]);
        expect(increment).toBeLessThan(0);
      });
    });

    describe('group budget post-reservation race guard', () => {
      const TEST_OWNER_ID = 'owner-user-999';
      const TEST_MEMBER_CM_ID = 'cm-member-1';

      it('returns 402 and releases reservation when group budget exceeded after reservation', async () => {
        // Owner has $10 balance, conversation budget $100, member budget $50.
        // reserveGroupBudget uses redis.eval (redisIncrByFloat), while
        // getGroupReservedTotals/getReservedTotal use redis.get (redisGet).
        // Return huge totals from eval to simulate concurrent race condition.
        const mockRedis = createMockRedis();
        mockRedis.get.mockResolvedValue(null);
        // eval calls are ONLY from redisIncrByFloat (reserve + release):
        mockRedis.eval
          .mockResolvedValueOnce('50000') // reserveGroupBudget: member total (huge)
          .mockResolvedValueOnce('50000') // reserveGroupBudget: conversation total (huge)
          .mockResolvedValueOnce('50000') // reserveGroupBudget: payer total (exceeds $10 = 1000 cents)
          .mockResolvedValueOnce('0') // releaseGroupBudget: member release
          .mockResolvedValueOnce('0') // releaseGroupBudget: conversation release
          .mockResolvedValueOnce('0'); // releaseGroupBudget: payer release

        const app = createTestApp(
          {
            conversations: [
              {
                id: TEST_CONVERSATION_ID,
                userId: TEST_OWNER_ID,
                title: 'Group Chat',
                currentEpoch: 1,
                nextSequence: 0,
                conversationBudget: '100.00',
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            ],
            users: [
              // Member first (buildBillingInput queries member wallet first)
              { id: TEST_USER_ID, balance: '0.00000000' },
              // Owner second (group path queries owner wallet second)
              { id: TEST_OWNER_ID, balance: '10.00000000' },
            ],
            conversationMemberRows: [
              {
                id: TEST_MEMBER_CM_ID,
                userId: TEST_USER_ID,
                conversationId: TEST_CONVERSATION_ID,
                privilege: 'write',
                visibleFromEpoch: 1,
              },
            ],
            memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
          },
          mockRedis
        );

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        expect(res.status).toBe(402);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BALANCE_RESERVED);
      });
    });

    describe('read-only member privilege check', () => {
      const TEST_OWNER_ID = 'owner-user-999';
      const TEST_MEMBER_CM_ID = 'cm-member-1';

      it('returns 403 when member has read-only privilege', async () => {
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '10.00000000' },
            { id: TEST_USER_ID, balance: '5.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'read',
              visibleFromEpoch: 1,
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(403);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_PRIVILEGE_INSUFFICIENT);
      });

      it('allows member with admin privilege to send messages', async () => {
        vi.useRealTimers();

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '10.00000000' },
            { id: TEST_USER_ID, balance: '5.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'admin',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'owner_balance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });
    });

    describe('billing mismatch detection', () => {
      it('returns 409 when client fundingSource disagrees with server decision', async () => {
        // Server will resolve personal_balance (paid user with balance)
        // Client claims free_allowance — mismatch!
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'free_allowance' }),
        });

        expect(res.status).toBe(409);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BILLING_MISMATCH);
        expect(body.details?.['serverFundingSource']).toBe('personal_balance');
      });

      it('proceeds normally when client fundingSource matches server decision', async () => {
        vi.useRealTimers();
        // Server will resolve personal_balance (paid user with balance)
        // Client claims personal_balance — match!
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'personal_balance' }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain('event: done');
      });

      it('returns 403 MODEL_TIER_LOCKED denial even when client claims approved fundingSource', async () => {
        // Server denies (zero balance, premium model). The pre-billing tier
        // gate fires before any billing-mismatch evaluation, so this is 403
        // MODEL_TIER_LOCKED — backend denial still takes priority over the
        // mismatch detection in front of resolveBilling.
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            {
              id: TEST_USER_ID,
              balance: '0.00000000',
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'personal_balance' }),
        });

        expect(res.status).toBe(403);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('MODEL_TIER_LOCKED');
      });

      it('returns 409 when member claims personal_balance but server resolves owner_balance', async () => {
        const TEST_OWNER_ID = 'owner-user-999';
        const TEST_MEMBER_CM_ID = 'cm-member-1';

        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_OWNER_ID,
              title: 'Group Chat',
              currentEpoch: 1,
              nextSequence: 0,
              conversationBudget: '100.00',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            { id: TEST_OWNER_ID, balance: '10.00000000' },
            { id: TEST_USER_ID, balance: '5.00000000' },
          ],
          conversationMemberRows: [
            {
              id: TEST_MEMBER_CM_ID,
              userId: TEST_USER_ID,
              conversationId: TEST_CONVERSATION_ID,
              privilege: 'write',
              visibleFromEpoch: 1,
            },
          ],
          memberBudgetRows: [{ budget: '50.00', spent: '0.00000000' }],
        });

        // Server resolves owner_balance (group budget available)
        // Client claims personal_balance — mismatch!
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ fundingSource: 'personal_balance' }),
        });

        expect(res.status).toBe(409);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe(ERROR_CODE_BILLING_MISMATCH);
        expect(body.details?.['serverFundingSource']).toBe('owner_balance');
      });
    });

    describe('stream error codes', () => {
      it('sends STREAM_ERROR code when AIClient model fails', async () => {
        vi.useRealTimers();

        const failingAi = createMockAIClient({ failingModels: ['openai/gpt-5'] });
        const app = createTestApp(undefined, undefined, undefined, failingAi);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody(),
        });

        expect(res.status).toBe(200); // SSE streams always return 200
        const text = await res.text();
        expect(text).toContain('event: error');
        expect(text).toContain('"code":"STREAM_ERROR"');
      });
    });

    // Web search behavior is now exercised via the AI Gateway tools path; the
    // pre-flight worst-case budget for it lives in `pricing.test.ts` (shared)
    // — `MAX_SEARCH_TOOL_CALLS * SEARCH_COST_PER_CALL`.

    describe('smart model', () => {
      const SMART_MODEL_TEST_ID = 'smart-model';
      // Must be within 2-year age window (from real date ~2026-03) but older than
      // 1 year (to avoid premium-by-recency classification for all models).
      const RECENT_CREATED = Math.floor(new Date('2025-01-15T00:00:00Z').getTime() / 1000);

      const smartModelTestModels = [
        {
          id: SMART_MODEL_TEST_ID,
          name: 'Auto Router',
          description: 'Automatically chooses the best model',
          context_length: 2_000_000,
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['temperature'],
          created: RECENT_CREATED,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'openai/gpt-5',
          name: 'OpenAI: GPT-4 Turbo',
          description: 'A capable model',
          context_length: 128_000,
          pricing: { prompt: '0.00001', completion: '0.00003' },
          supported_parameters: ['temperature'],
          created: RECENT_CREATED,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
        {
          id: 'openai/gpt-4o-mini',
          name: 'DeepSeek: DeepSeek R1',
          description: 'A cheap model',
          context_length: 164_000,
          pricing: { prompt: '0.000001', completion: '0.000003' },
          supported_parameters: ['temperature'],
          created: RECENT_CREATED,
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      function stubSmartModelTestModels(fetchMockFunction: FetchMock): void {
        const publicShape = smartModelTestModels.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          type: 'language',
          pricing: { input: m.pricing.prompt, output: m.pricing.completion },
          context_window: m.context_length,
          created: m.created,
        }));
        fetchMockFunction.mockImplementation((url: string) => {
          if (url.includes('/endpoints/zdr')) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  data: smartModelTestModels.map((m) => ({
                    model_id: m.id,
                    model_name: m.name,
                    provider_name: 'Provider',
                    context_length: m.context_length,
                    pricing: m.pricing,
                  })),
                }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: publicShape }),
          });
        });
      }

      it('denies request when no models are affordable', async () => {
        stubSmartModelTestModels(fetchMock);
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [
            {
              id: TEST_USER_ID,
              // $0 balance → free tier, $0 free allowance → nothing affordable
              balance: '0.00000000',
            },
          ],
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: [SMART_MODEL_TEST_ID], fundingSource: 'free_allowance' }),
        });

        expect(res.status).toBe(402);
      });

      it('reserves budget based on worst-case allowed model pricing', async () => {
        vi.useRealTimers();
        stubSmartModelTestModels(fetchMock);
        const mockRedis = createMockRedis();
        const app = createTestApp(undefined, mockRedis);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: [SMART_MODEL_TEST_ID] }),
        });

        expect(res.status).toBe(200);
        await res.text();

        // redis.eval is called with (script, [key], [incrementStr, ttlStr])
        const evalCalls = mockRedis.eval.mock.calls;
        expect(evalCalls.length).toBeGreaterThanOrEqual(1);
        const smartModelReservation = Number(evalCalls[0]?.[2]?.[0]);

        // Compare: send same request with the cheapest model directly
        const mockRedis2 = createMockRedis();
        const app2 = createTestApp(undefined, mockRedis2);

        const res2 = await app2.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-4o-mini'] }),
        });

        expect(res2.status).toBe(200);
        await res2.text();

        const evalCalls2 = mockRedis2.eval.mock.calls;
        expect(evalCalls2.length).toBeGreaterThanOrEqual(1);
        const cheapModelReservation = Number(evalCalls2[0]?.[2]?.[0]);

        // Smart Model reserves at worst-case (most expensive allowed model)
        // PLUS the classifier worst-case overhead — strictly greater than
        // a direct selection of the cheapest model.
        expect(smartModelReservation).toBeGreaterThan(cheapModelReservation);
      });

      it('emits stage:start and stage:done events when classifier resolves an eligible model', async () => {
        vi.useRealTimers();
        stubSmartModelTestModels(fetchMock);
        // Pick any real eligible model id at random and instruct the mock
        // classifier to "resolve" to it. The test then asserts the SSE
        // payload contains exactly that id, so changes to the fixture
        // automatically flow through.
        const expectedResolvedId = smartModelTestModels.find(
          (m) => m.id !== SMART_MODEL_TEST_ID
        )?.id;
        if (expectedResolvedId === undefined)
          throw new Error('test fixture must include a real model');
        const aiClient = createMockAIClient({
          classifierResolution: expectedResolvedId,
        });
        const app = createTestApp(undefined, undefined, undefined, aiClient);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: [SMART_MODEL_TEST_ID] }),
        });

        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain('event: stage:start');
        expect(body).toContain('event: stage:done');
        expect(body).toContain('"stageId":"smart-model"');
        expect(body).toContain(`"resolvedModelId":"${expectedResolvedId}"`);
        // The classifier call must have happened — verify by searching the
        // mock's request history for a request whose system prompt contains
        // the classifier marker.
        const classifierRequests = aiClient
          .getRequestHistory()
          .filter((r) => r.modality === 'text' && classifierSystemPromptDetected(r));
        expect(classifierRequests.length).toBeGreaterThanOrEqual(1);
      });

      it('falls back to the value model and continues when classifier resolution fails', async () => {
        // Plan §10.11: when the classifier returns garbage, the slot falls
        // back to the cheapest eligible model (the classifier model itself)
        // rather than aborting with stage:error. The user still pays for the
        // failed classifier attempt.
        vi.useRealTimers();
        stubSmartModelTestModels(fetchMock);
        // Configure a classifier output that won't match any eligible model.
        const aiClient = createMockAIClient({
          classifierResolution: 'totally-unrelated-model-id-xyz',
        });
        const app = createTestApp(undefined, undefined, undefined, aiClient);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: [SMART_MODEL_TEST_ID] }),
        });

        expect(res.status).toBe(200);
        const body = await res.text();
        // No CLASSIFIER_FAILED — degraded gracefully.
        expect(body).not.toContain('"errorCode":"CLASSIFIER_FAILED"');
        // Stage:done was still emitted with a fallback marker.
        expect(body).toContain('event: stage:done');
        expect(body).toContain('"fallbackOccurred":true');
      });
    });

    describe('multi-model streaming', () => {
      const SECOND_MODEL_ID = 'openai/gpt-4o-mini';
      const multiModels = [
        ...mockModels,
        {
          id: SECOND_MODEL_ID,
          name: 'GPT-3.5 Turbo',
          description: 'Basic model',
          context_length: 16_000,
          pricing: {
            prompt: '0.0000005',
            completion: '0.0000015',
            input: '0.0000005',
            output: '0.0000015',
          },
          supported_parameters: ['temperature'],
          created: Math.floor(Date.now() / 1000),
          architecture: { input_modalities: ['text'], output_modalities: ['text'] },
        },
      ];

      function stubMultiModels(fetchMockFunction: FetchMock): void {
        fetchMockFunction.mockImplementation((url: string) => {
          if (url.includes('/endpoints/zdr')) {
            return Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  data: multiModels.map((m) => ({
                    model_id: m.id,
                    model_name: m.name,
                    provider_name: 'Provider',
                    context_length: m.context_length,
                    pricing: m.pricing,
                  })),
                }),
            });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ data: multiModels }),
          });
        });
      }

      it('saves user + N assistant messages for multi-model request', async () => {
        vi.useRealTimers();
        stubMultiModels(fetchMock);

        const insertedMessages: unknown[] = [];
        const app = createTestApp({
          conversations: [
            {
              id: TEST_CONVERSATION_ID,
              userId: TEST_USER_ID,
              title: 'Test',
              currentEpoch: 1,
              nextSequence: 0,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
          users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
          onInsert: (table, values) => {
            if (table === messagesTable) {
              insertedMessages.push(values);
            }
          },
        });

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-5', SECOND_MODEL_ID] }),
        });

        await res.text();

        // 1 user message + 2 assistant messages = 3 total
        expect(insertedMessages.length).toBe(3);

        const userMsg = insertedMessages[0] as Record<string, unknown>;
        expect(userMsg).toMatchObject({
          conversationId: TEST_CONVERSATION_ID,
          senderType: 'user',
        });

        const aiMsgs = insertedMessages.slice(1) as Record<string, unknown>[];
        for (const aiMsg of aiMsgs) {
          expect(aiMsg).toMatchObject({
            conversationId: TEST_CONVERSATION_ID,
            senderType: 'ai',
          });
        }
      });

      it('emits model:done event for each model', async () => {
        vi.useRealTimers();
        stubMultiModels(fetchMock);
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-5', SECOND_MODEL_ID] }),
        });

        const text = await res.text();

        // Should have model:done events for each model
        const modelDoneMatches = text.match(/event: model:done/g);
        expect(modelDoneMatches).toHaveLength(2);
        expect(text).toContain('"modelId":"openai/gpt-5"');
        expect(text).toContain(`"modelId":"${SECOND_MODEL_ID}"`);
      });

      it('emits model-tagged token events', async () => {
        vi.useRealTimers();
        stubMultiModels(fetchMock);
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ models: ['openai/gpt-5', SECOND_MODEL_ID] }),
        });

        const text = await res.text();

        // Token events should include modelId
        expect(text).toContain('event: token');
        // Parse token events to verify they have modelId
        const tokenDataMatches = [...text.matchAll(/event: token\ndata: (.+)/g)];
        expect(tokenDataMatches.length).toBeGreaterThanOrEqual(2);
        for (const match of tokenDataMatches) {
          const data = JSON.parse(match[1]!) as Record<string, unknown>;
          expect(data).toHaveProperty('modelId');
        }
      });

      // Regression for the N² web-search over-reservation: web search is a
      // per-request feature (one Perplexity call shared across all N models),
      // not per-model. `buildCostManifest` multiplies the caller's
      // `webSearchCost` by `modelCount` internally, so the caller MUST pass
      // the per-request cost. Passing `worstCaseSearchCost() * models.length`
      // (the pre-fix call site) inflated reservations by N² instead of N.
      it('reserves web-search cost as N × base, not N² × base, for N selected models', async () => {
        vi.useRealTimers();
        const { worstCaseSearchCost } = await import('@hushbox/shared');

        stubMultiModels(fetchMock);
        const redisWithSearch = createMockRedis();
        const appWithSearch = createTestApp(undefined, redisWithSearch);
        const resWithSearch = await appWithSearch.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            models: ['openai/gpt-5', SECOND_MODEL_ID],
            webSearchEnabled: true,
          }),
        });
        await resWithSearch.text();

        stubMultiModels(fetchMock);
        const redisWithoutSearch = createMockRedis();
        const appWithoutSearch = createTestApp(undefined, redisWithoutSearch);
        const resWithoutSearch = await appWithoutSearch.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            models: ['openai/gpt-5', SECOND_MODEL_ID],
            webSearchEnabled: false,
          }),
        });
        await resWithoutSearch.text();

        // redis.eval call shape: (script, [key], [incrementStr, ttlStr])
        const withSearchReservation = Number(redisWithSearch.eval.mock.calls[0]?.[2]?.[0]);
        const withoutSearchReservation = Number(redisWithoutSearch.eval.mock.calls[0]?.[2]?.[0]);
        const searchDeltaCents = withSearchReservation - withoutSearchReservation;

        // Expected: 2 models × base search cost (in cents).
        const expectedDeltaCents = 2 * worstCaseSearchCost() * 100;
        expect(searchDeltaCents).toBeCloseTo(expectedDeltaCents, 5);

        // Regression guard: must NOT be 4× base (the N² bug).
        const buggyDeltaCents = 4 * worstCaseSearchCost() * 100;
        expect(searchDeltaCents).not.toBeCloseTo(buggyDeltaCents, 5);
      });
    });

    describe('image modality', () => {
      const IMAGE_MODEL_ID = 'google/imagen-4.0-generate-001';
      const TEXT_MODEL_ID = 'anthropic/claude-sonnet-4.6';

      it('returns 400 MODEL_NOT_FOUND when selected model is unknown', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'image',
            models: ['google/non-existent-model'],
            imageConfig: { aspectRatio: '1:1' },
          }),
        });

        expect(res.status).toBe(400);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('MODEL_NOT_FOUND');
      });

      it('returns 400 MODALITY_MISMATCH when image modality includes non-image model', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'image',
            models: [IMAGE_MODEL_ID, TEXT_MODEL_ID],
            imageConfig: { aspectRatio: '1:1' },
          }),
        });

        expect(res.status).toBe(400);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('MODALITY_MISMATCH');
        const invalidModels = body.details?.['invalidModels'] as string[] | undefined;
        expect(invalidModels).toContain(TEXT_MODEL_ID);
      });

      it('happy path: returns SSE stream with image content items', async () => {
        vi.useRealTimers();
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'image',
            models: [IMAGE_MODEL_ID],
            imageConfig: { aspectRatio: '1:1' },
          }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');

        const text = await res.text();
        expect(text).toContain('event: start');
        expect(text).toContain('event: model:done');
        expect(text).toContain('event: done');
        // Verify the done event payload includes image content items
        expect(text).toContain('"contentType":"image"');
      });

      it('defaults to text modality when modality omitted', async () => {
        vi.useRealTimers();
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Intentionally omit `modality` to verify default behavior
          body: streamBody(),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        // text modality emits token events; image modality does not
        expect(text).toContain('event: token');
      });

      it('bills each image model at its own price (not the max) in a multi-model request', async () => {
        vi.useRealTimers();
        const IMAGEN_FAST = 'google/imagen-4-fast';
        const IMAGEN_ULTRA = 'google/imagen-4-ultra';
        const baseClient = createMockAIClient();
        const mixedPriceClient: AppEnv['Variables']['aiClient'] = {
          ...baseClient,
          listModels: async () => {
            const models = await baseClient.listModels();
            // Inject two image models at different prices. The base mock has a
            // single image model; we synthesize two so the per-model billing path
            // is exercised without requiring real gateway data.
            return [
              ...models.filter((m) => m.modality !== 'image'),
              {
                ...models.find((m) => m.modality === 'image')!,
                id: IMAGEN_FAST,
                pricing: { kind: 'image' as const, perImage: 0.02 },
              },
              {
                ...models.find((m) => m.modality === 'image')!,
                id: IMAGEN_ULTRA,
                pricing: { kind: 'image' as const, perImage: 0.06 },
              },
            ];
          },
          stream: (request) => {
            if (request.modality !== 'image') return baseClient.stream(request);
            // Both synthesized model IDs should use the image generation path —
            // route the canned image bytes from the underlying image model.
            return baseClient.stream({ ...request, model: 'google/imagen-4.0-generate-001' });
          },
        };
        const app = createTestApp(undefined, undefined, undefined, mixedPriceClient);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'image',
            models: [IMAGEN_FAST, IMAGEN_ULTRA],
            imageConfig: { aspectRatio: '1:1' },
          }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        // Extract content item costs from the SSE done event
        const doneMatch = /event: done\ndata: (.+)/.exec(text);
        expect(doneMatch).not.toBeNull();
        const doneData = JSON.parse(doneMatch![1]!) as {
          models: { modelId: string; contentItems: { cost: string }[] }[];
        };
        const fastEntry = doneData.models.find((m) => m.modelId === IMAGEN_FAST);
        const ultraEntry = doneData.models.find((m) => m.modelId === IMAGEN_ULTRA);
        expect(fastEntry).toBeDefined();
        expect(ultraEntry).toBeDefined();
        const fastCost = Number.parseFloat(fastEntry!.contentItems[0]!.cost);
        const ultraCost = Number.parseFloat(ultraEntry!.contentItems[0]!.cost);
        // The mocked perImage values (0.02 / 0.06) are interpreted as
        // FEE-INCLUSIVE per the `ModelInfo.pricing` contract. Storage cost
        // depends on the canned bytes but is identical for both models, so
        // the ultra cost should exceed the fast cost by the perImage delta.
        expect(ultraCost).toBeGreaterThan(fastCost);
        // Delta = 0.06 - 0.02 = 0.04 — close to (within floating-point) but
        // not strictly greater. The regression we care about is "billed at
        // max, not per model" — in that case both would equal and delta = 0.
        expect(ultraCost - fastCost).toBeCloseTo(0.04, 6);
      });

      // NOTE: Link-guest 403 MEDIA_TRIAL_BLOCKED test is not covered here.
      // Simulating a link guest requires extending the mock DB in createTestApp
      // to return a sharedLinks row + conversationMembers row so the real
      // `requirePrivilege({ allowLinkGuest: true })` middleware sets `linkGuest`
      // on context. The existing createMockDb resolves an empty array for
      // sharedLinks, so `resolveLinkGuest` returns null and the middleware
      // falls through to 401. Covering this case requires either a dedicated
      // mock DB that supports the link-guest resolution chain (sharedLinks
      // lookup → conversationMembers by linkId) or a route-level override
      // that pre-seeds `linkGuest` on context before requirePrivilege runs.
      // Both are non-trivial for an isolated route test. The behavior is
      // implicitly exercised via the chat.ts image-branch path check
      // (`modality === 'image' && linkGuest`) once the middleware has set
      // linkGuest — see middleware/require-privilege.test.ts for the
      // middleware-side coverage.
    });

    describe('video modality', () => {
      const VIDEO_MODEL_ID = 'google/veo-3.1-generate-001';
      const TEXT_MODEL_ID = 'anthropic/claude-sonnet-4.6';
      const IMAGE_MODEL_ID = 'google/imagen-4.0-generate-001';
      const DEFAULT_VIDEO_CONFIG = {
        aspectRatio: '16:9',
        durationSeconds: 4,
        resolution: '720p',
      };

      it('rejects video request missing videoConfig with 400', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VIDEO_MODEL_ID],
          }),
        });

        expect(res.status).toBe(400);
      });

      it('returns 400 MODEL_NOT_FOUND when selected video model is unknown', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: ['google/non-existent-video-model'],
            videoConfig: DEFAULT_VIDEO_CONFIG,
          }),
        });

        expect(res.status).toBe(400);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('MODEL_NOT_FOUND');
      });

      it('returns 400 MODALITY_MISMATCH when video modality includes a non-video model', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VIDEO_MODEL_ID, TEXT_MODEL_ID],
            videoConfig: DEFAULT_VIDEO_CONFIG,
          }),
        });

        expect(res.status).toBe(400);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('MODALITY_MISMATCH');
        const invalidModels = body.details?.['invalidModels'] as string[] | undefined;
        expect(invalidModels).toContain(TEXT_MODEL_ID);
      });

      it('returns 400 UNSUPPORTED_DURATION when the duration is not in the model supported set', async () => {
        vi.useRealTimers();
        const app = createTestApp();

        // Veo 3.1 supports {4, 6, 8}. `5` is in the legacy 1-8 range but not in
        // the discrete set — the request should reject before reaching the
        // gateway so the user sees a clear error instead of a silent clamp.
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VIDEO_MODEL_ID],
            videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
          }),
        });

        expect(res.status).toBe(400);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('UNSUPPORTED_DURATION');
        expect(body.details?.['durationSeconds']).toBe(5);
        const invalidModels = body.details?.['invalidModels'] as string[] | undefined;
        expect(invalidModels).toContain(VIDEO_MODEL_ID);
      });

      it('returns 400 UNSUPPORTED_RESOLUTION when the selected model does not price the requested resolution', async () => {
        vi.useRealTimers();
        const baseClient = createMockAIClient();
        // Wrap the mock so veo-3.1 only prices 1080p
        const clientWithout720p: AppEnv['Variables']['aiClient'] = {
          ...baseClient,
          listModels: async () => {
            const models = await baseClient.listModels();
            return models.map((m) =>
              m.id === VIDEO_MODEL_ID && m.pricing.kind === 'video'
                ? {
                    ...m,
                    pricing: { kind: 'video' as const, perSecondByResolution: { '1080p': 0.15 } },
                  }
                : m
            );
          },
        };
        const app = createTestApp(undefined, undefined, undefined, clientWithout720p);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VIDEO_MODEL_ID],
            videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
          }),
        });

        expect(res.status).toBe(400);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('UNSUPPORTED_RESOLUTION');
        expect(body.details?.['resolution']).toBe('720p');
      });

      it('returns 400 MODALITY_MISMATCH when video modality includes an image model', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VIDEO_MODEL_ID, IMAGE_MODEL_ID],
            videoConfig: DEFAULT_VIDEO_CONFIG,
          }),
        });

        expect(res.status).toBe(400);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('MODALITY_MISMATCH');
      });

      it('happy path: returns SSE stream with video content items', async () => {
        vi.useRealTimers();
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VIDEO_MODEL_ID],
            videoConfig: DEFAULT_VIDEO_CONFIG,
          }),
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');

        const text = await res.text();
        expect(text).toContain('event: start');
        expect(text).toContain('event: model:done');
        expect(text).toContain('event: done');
        expect(text).toContain('"contentType":"video"');
        expect(text).toContain('"durationMs":3000');
      });

      it('bills each video model at its own price (not the max) in a multi-model request', async () => {
        vi.useRealTimers();
        const VEO_FAST = 'google/veo-3.1-fast';
        const VEO_ULTRA = 'google/veo-3.1-ultra';
        const baseClient = createMockAIClient();
        const mixedPriceClient: AppEnv['Variables']['aiClient'] = {
          ...baseClient,
          listModels: async () => {
            const models = await baseClient.listModels();
            return [
              ...models.filter((m) => m.modality !== 'video'),
              {
                ...models.find((m) => m.modality === 'video')!,
                id: VEO_FAST,
                pricing: {
                  kind: 'video' as const,
                  perSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
                },
              },
              {
                ...models.find((m) => m.modality === 'video')!,
                id: VEO_ULTRA,
                pricing: {
                  kind: 'video' as const,
                  perSecondByResolution: { '720p': 0.4, '1080p': 0.6 },
                },
              },
            ];
          },
          stream: (request) => {
            if (request.modality !== 'video') return baseClient.stream(request);
            return baseClient.stream({ ...request, model: 'google/veo-3.1-generate-001' });
          },
        };
        const app = createTestApp(undefined, undefined, undefined, mixedPriceClient);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VEO_FAST, VEO_ULTRA],
            videoConfig: DEFAULT_VIDEO_CONFIG,
          }),
        });

        expect(res.status).toBe(200);
        const text = await res.text();
        const doneMatch = /event: done\ndata: (.+)/.exec(text);
        expect(doneMatch).not.toBeNull();
        const doneData = JSON.parse(doneMatch![1]!) as {
          models: { modelId: string; contentItems: { cost: string }[] }[];
        };
        const fastEntry = doneData.models.find((m) => m.modelId === VEO_FAST);
        const ultraEntry = doneData.models.find((m) => m.modelId === VEO_ULTRA);
        expect(fastEntry).toBeDefined();
        expect(ultraEntry).toBeDefined();
        const fastCost = Number.parseFloat(fastEntry!.contentItems[0]!.cost);
        const ultraCost = Number.parseFloat(ultraEntry!.contentItems[0]!.cost);
        // Fee-adjusted delta: (0.4 - 0.1) × 4s × 1.15 = $1.38 minimum difference
        expect(ultraCost - fastCost).toBeGreaterThan(1);
      });

      it('awaits long-running video generation without introducing a pipeline-side timeout', async () => {
        vi.useRealTimers();
        const realClient = createMockAIClient();
        // Wrap the real mock so `stream` on a video request awaits a real delay
        // before yielding media-done. If the pipeline had its own AbortController
        // or deadline, it would cut the stream off before the delay elapsed.
        // 500ms is enough to prove the pipeline waits; the 15-min case is the
        // same code path — the platform `fetch` has no default timeout.
        const SIMULATED_GENERATION_DELAY_MS = 500;
        const delayedClient: AppEnv['Variables']['aiClient'] = {
          ...realClient,
          stream: (request) => {
            if (request.modality !== 'video') return realClient.stream(request);
            const inner = realClient.stream(request);
            return {
              [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
                const iterator = inner[Symbol.asyncIterator]();
                let delayInjected = false;
                return {
                  async next(): Promise<IteratorResult<InferenceEvent>> {
                    if (!delayInjected) {
                      delayInjected = true;
                      await new Promise((resolve) =>
                        setTimeout(resolve, SIMULATED_GENERATION_DELAY_MS)
                      );
                    }
                    return iterator.next();
                  },
                };
              },
            };
          },
        };
        const app = createTestApp(undefined, undefined, undefined, delayedClient);

        const start = Date.now();
        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'video',
            models: [VIDEO_MODEL_ID],
            videoConfig: DEFAULT_VIDEO_CONFIG,
          }),
        });
        const text = await res.text();
        const elapsed = Date.now() - start;

        // The delay was awaited, not short-circuited.
        expect(elapsed).toBeGreaterThanOrEqual(SIMULATED_GENERATION_DELAY_MS);
        // And the pipeline completed successfully despite the long wait.
        expect(res.status).toBe(200);
        expect(text).toContain('event: done');
        expect(text).toContain('"contentType":"video"');
      });
    });

    describe('audio modality', () => {
      const AUDIO_MODEL_ID = 'openai/tts-1';
      const TEXT_MODEL_ID = 'anthropic/claude-sonnet-4.6';
      const DEFAULT_AUDIO_CONFIG = {
        format: 'mp3' as const,
        maxDurationSeconds: 60,
      };

      it('returns 503 AUDIO_DISABLED when FEATURE_FLAGS.AUDIO_ENABLED is off', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'audio',
            models: [AUDIO_MODEL_ID],
            audioConfig: DEFAULT_AUDIO_CONFIG,
          }),
        });

        expect(res.status).toBe(503);
        const body: ErrorBody = await res.json();
        expect(body.code).toBe('AUDIO_DISABLED');
      });

      it('rejects audio request missing audioConfig with 400 (schema)', async () => {
        const app = createTestApp();

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({
            modality: 'audio',
            models: [AUDIO_MODEL_ID],
          }),
        });

        expect(res.status).toBe(400);
      });

      describe('with FEATURE_FLAGS.AUDIO_ENABLED temporarily on', () => {
        // Save/restore pattern: capture the original flag value before flipping
        // so afterEach restores it regardless of the global default. afterEach
        // runs even when beforeEach throws, so the flag can't leak across tests.
        let originalAudioEnabled: boolean;
        beforeEach(() => {
          originalAudioEnabled = FEATURE_FLAGS.AUDIO_ENABLED;
          FEATURE_FLAGS.AUDIO_ENABLED = true;
        });
        afterEach(() => {
          FEATURE_FLAGS.AUDIO_ENABLED = originalAudioEnabled;
        });

        it('returns 400 MODEL_NOT_FOUND when selected audio model is unknown', async () => {
          const app = createTestApp();

          const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody({
              modality: 'audio',
              models: ['openai/non-existent-tts'],
              audioConfig: DEFAULT_AUDIO_CONFIG,
            }),
          });

          expect(res.status).toBe(400);
          const body: ErrorBody = await res.json();
          expect(body.code).toBe('MODEL_NOT_FOUND');
        });

        it('returns 400 MODALITY_MISMATCH when audio modality includes a non-audio model', async () => {
          const app = createTestApp();

          const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody({
              modality: 'audio',
              models: [AUDIO_MODEL_ID, TEXT_MODEL_ID],
              audioConfig: DEFAULT_AUDIO_CONFIG,
            }),
          });

          expect(res.status).toBe(400);
          const body: ErrorBody = await res.json();
          expect(body.code).toBe('MODALITY_MISMATCH');
          const invalidModels = body.details?.['invalidModels'] as string[] | undefined;
          expect(invalidModels).toContain(TEXT_MODEL_ID);
        });

        it('happy path: returns SSE stream with audio content items', async () => {
          vi.useRealTimers();
          const app = createTestApp();

          const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: streamBody({
              modality: 'audio',
              models: [AUDIO_MODEL_ID],
              audioConfig: DEFAULT_AUDIO_CONFIG,
            }),
          });

          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toBe('text/event-stream');

          const text = await res.text();
          expect(text).toContain('event: start');
          expect(text).toContain('event: model:done');
          expect(text).toContain('event: done');
          expect(text).toContain('"contentType":"audio"');
          // Mock audio yields durationMs: 3000
          expect(text).toContain('"durationMs":3000');
        });
      });
    });

    describe('webSearchEnabled threading', () => {
      it('forwards webSearchEnabled=true to the AI client TextRequest', async () => {
        vi.useRealTimers();
        const aiClient = createMockAIClient();
        const app = createTestApp(undefined, undefined, undefined, aiClient);

        const res = await app.request(`/${TEST_CONVERSATION_ID}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamBody({ webSearchEnabled: true }),
        });
        await res.text();

        // Find the non-classifier text request — the mock records the full
        // InferenceRequest including webSearchEnabled.
        const textRequests = aiClient
          .getRequestHistory()
          .filter((r) => r.modality === 'text' && !classifierSystemPromptDetected(r));
        expect(textRequests.length).toBeGreaterThanOrEqual(1);
        expect(textRequests[0]).toMatchObject({
          modality: 'text',
          webSearchEnabled: true,
        });
      });
    });
  });

  describe('POST /message', () => {
    const TEST_MESSAGE_ID = '33333333-3333-3333-8333-333333333333';

    function messageBody(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        messageId: TEST_MESSAGE_ID,
        content: 'Hello without AI',
        ...overrides,
      });
    }

    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(401);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when content is missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: TEST_MESSAGE_ID,
        }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 when conversation does not exist', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 200 with sequenceNumber and epochNumber on success', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(200);
      const body = await jsonBody<{
        messageId: string;
        sequenceNumber: number;
        epochNumber: number;
      }>(res);
      expect(body.messageId).toBe(TEST_MESSAGE_ID);
      expect(body.sequenceNumber).toBeDefined();
      expect(body.epochNumber).toBe(1);
    });

    it('returns JSON response (not SSE stream)', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(200);
      // Verify it's a JSON response, not an SSE stream
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await jsonBody<{ messageId: string }>(res);
      expect(body.messageId).toBe(TEST_MESSAGE_ID);
    });

    it('broadcasts message:new without content field in user-only route', async () => {
      vi.useRealTimers();
      const broadcastBodies: unknown[] = [];
      const doId = { toString: () => 'mock-do-id' };
      const mockStub = {
        fetch: vi.fn().mockImplementation(async (req: Request) => {
          const body: unknown = await req.json();
          broadcastBodies.push(body);
          return Response.json({ sent: 1 }, { headers: { 'Content-Type': 'application/json' } });
        }),
      };
      const mockNamespace = {
        idFromName: vi.fn().mockReturnValue(doId),
        get: vi.fn().mockReturnValue(mockStub),
      };
      const app = new Hono<AppEnv>();
      const mockDb = createMockDb({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
      });
      app.use('*', async (c, next) => {
        c.env = {
          NODE_ENV: 'development',
          AI_GATEWAY_API_KEY: 'test-key',
          CONVERSATION_ROOM: mockNamespace,
        } as unknown as AppEnv['Bindings'];
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
        c.set('db', mockDb as unknown as AppEnv['Variables']['db']);
        c.set('redis', createMockRedis() as unknown as AppEnv['Variables']['redis']);
        c.set('envUtils', createEnvUtilities(c.env));
        await next();
      });
      app.route('/', chatRoute);
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });
      expect(res.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const messageNew = broadcastBodies.find(
        (b) => (b as Record<string, unknown>)['type'] === 'message:new'
      ) as Record<string, unknown>;
      expect(messageNew).toBeDefined();
      expect(messageNew['senderType']).toBe('user');
      expect(messageNew['senderId']).toBe(TEST_USER_ID);
      // User-only route should NOT include content (message already in DB)
      expect(messageNew['content']).toBeUndefined();
    });

    it('returns 403 for members with insufficient privilege', async () => {
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: 'other-owner',
            title: 'Test',
            currentEpoch: 1,
            nextSequence: 1,
            conversationBudget: '100.00',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        conversationMemberRows: [
          {
            id: 'member-1',
            userId: TEST_USER_ID,
            conversationId: TEST_CONVERSATION_ID,
            privilege: 'read_only',
            visibleFromEpoch: 1,
          },
        ],
      });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: messageBody(),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('POST /regenerate', () => {
    const TEST_TARGET_MESSAGE_ID = '55555555-5555-5555-8555-555555555555';

    function regenerateBody(overrides: Record<string, unknown> = {}): string {
      return JSON.stringify({
        targetMessageId: TEST_TARGET_MESSAGE_ID,
        action: 'retry',
        models: ['openai/gpt-5'],
        userMessage: {
          id: TEST_USER_MESSAGE_ID,
          content: 'Hello',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        ...overrides,
      });
    }

    it('returns 401 for unauthenticated requests', async () => {
      const app = createUnauthenticatedTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody(),
      });

      expect(res.status).toBe(401);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('NOT_AUTHENTICATED');
    });

    it('returns 400 when required fields are missing', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid action', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({ action: 'invalid' }),
      });

      expect(res.status).toBe(400);
    });

    it('returns 404 when conversation not found', async () => {
      const app = createTestApp({ conversations: [] });
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody(),
      });

      expect(res.status).toBe(404);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('CONVERSATION_NOT_FOUND');
    });

    it('returns 400 when messagesForInference ends with assistant role', async () => {
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          messagesForInference: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
          ],
        }),
      });

      expect(res.status).toBe(400);
      const body: ErrorBody = await res.json();
      expect(body.code).toBe('LAST_MESSAGE_NOT_USER');
    });

    it('streams SSE response for valid retry request', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'retry',
          messagesForInference: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    it('streams SSE response for edit action', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'edit',
          messagesForInference: [{ role: 'user', content: 'Edited message' }],
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
    });

    it('writes SSE error event when persistence fails after successful stream', async () => {
      vi.useRealTimers();

      // DB insert throws during message persistence
      const app = createTestApp({
        conversations: [
          {
            id: TEST_CONVERSATION_ID,
            userId: TEST_USER_ID,
            title: 'Test Conversation',
            currentEpoch: 1,
            nextSequence: 1,
            conversationBudget: '100.00',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        users: [{ id: TEST_USER_ID, balance: '10.00000000' }],
        onInsert: (table) => {
          if (table === messagesTable) {
            throw new Error('DB write failed');
          }
        },
      });

      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'retry',
          messagesForInference: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200); // SSE streams always return 200
      const text = await res.text();
      expect(text).toContain('event: error');
      expect(text).toContain('"code":"BILLING_ERROR"');
    });

    it('returns SSE events with start, token, and done sequence', async () => {
      vi.useRealTimers();
      const app = createTestApp();
      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'retry',
          messagesForInference: [{ role: 'user', content: 'Hello' }],
        }),
      });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('event: start');
      expect(text).toContain('event: token');
      expect(text).toContain('event: done');
    });

    it('forwards webSearchEnabled=true to the AI client TextRequest', async () => {
      vi.useRealTimers();
      const aiClient = createMockAIClient();
      const app = createTestApp(undefined, undefined, undefined, aiClient);

      const res = await app.request(`/${TEST_CONVERSATION_ID}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: regenerateBody({
          action: 'retry',
          messagesForInference: [{ role: 'user', content: 'Hello' }],
          webSearchEnabled: true,
        }),
      });
      await res.text();

      const textRequests = aiClient.getRequestHistory().filter((r) => r.modality === 'text');
      expect(textRequests.length).toBeGreaterThanOrEqual(1);
      expect(textRequests[0]).toMatchObject({
        modality: 'text',
        webSearchEnabled: true,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Exhaustiveness guards — exercise the `assertNever` defaults so a future
// caller bypassing strict typing (via `as` cast) cannot silently land in a
// no-op branch. Mirrors the pattern in modality-strategies.test.ts.
// ---------------------------------------------------------------------------

describe('lookupMediaModels exhaustiveness guard', () => {
  it('throws when extract returns an unrecognized outcome kind', async () => {
    const fakeAiClient = {
      listModels: () => Promise.resolve([{ id: 'fake-model' }]),
    } as unknown as Parameters<typeof lookupMediaModels>[0];

    type Outcome = { kind: 'ok'; value: number } | { kind: 'mismatch' };
    const maliciousExtract = (): Outcome => ({ kind: 'unrecognized' as 'ok', value: 0 }) as Outcome;

    await expect(lookupMediaModels(fakeAiClient, ['fake-model'], maliciousExtract)).rejects.toThrow(
      /Exhaustiveness check failed/
    );
  });
});
