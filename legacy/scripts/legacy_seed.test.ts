import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEV_EMAIL_DOMAIN, TEST_EMAIL_DOMAIN } from '@hushbox/shared';

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  getTableColumns: vi.fn(() => ({ id: { name: 'id' }, name: { name: 'name' } })),
  // getTableName is consumed at module-eval time by seed.ts's
  // TRACKED_TABLE_NAMES = TRACKED_TABLE_OBJECTS.map((t) => getTableName(t)).
  // Use the schema-symbol fallback Drizzle exposes via Symbol.for so the test
  // doesn't depend on each schema file's metadata shape.
  getTableName: vi.fn((table: { _?: { name?: string } } | null | undefined) => {
    return table?._?.name ?? 'unknown';
  }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    {
      raw: vi.fn((s: string) => ({ raw: s })),
      identifier: vi.fn((s: string) => ({ identifier: s })),
    }
  ),
}));

vi.mock('./lib/seed-crypto-pool.js', () => ({
  ensurePersonaCrypto: vi.fn(() => Promise.resolve(new Map())),
}));

vi.mock('./lib/seed-crypto-cache.js', async () => {
  const actual = await vi.importActual<typeof import('./lib/seed-crypto-cache.js')>(
    './lib/seed-crypto-cache.js'
  );
  return {
    ...actual,
    computeCryptoFingerprint: vi.fn(() => Promise.resolve('test-fingerprint')),
  };
});

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

vi.mock('@hushbox/shared/models', () => ({
  fetchModels: vi.fn(() => Promise.resolve([])),
  pickValueTextModel: vi.fn(() => 'anthropic/claude-3.5-sonnet'),
}));

function mockCryptoBytes(length: number): Uint8Array {
  return new Uint8Array(length).fill(0xab);
}

vi.mock('@hushbox/crypto', () => ({
  createOpaqueClient: vi.fn(() => ({})),
  startRegistration: vi.fn(() => Promise.resolve({ serialized: [1, 2, 3] })),
  finishRegistration: vi.fn(() =>
    Promise.resolve({ record: [...mockCryptoBytes(192)], exportKey: [4, 5, 6] })
  ),
  createAccount: vi.fn(() =>
    Promise.resolve({
      publicKey: mockCryptoBytes(32),
      passwordWrappedPrivateKey: mockCryptoBytes(48),
      recoveryWrappedPrivateKey: mockCryptoBytes(48),
      recoveryPhrase: 'test mnemonic phrase words here for recovery seed backup now',
    })
  ),
  createFirstEpoch: vi.fn((keys: Uint8Array[]) => ({
    epochPublicKey: mockCryptoBytes(32),
    epochPrivateKey: mockCryptoBytes(32),
    confirmationHash: mockCryptoBytes(32),
    memberWraps: keys.map((k: Uint8Array) => ({
      memberPublicKey: k,
      wrap: mockCryptoBytes(48),
    })),
  })),
  encryptTextForEpoch: vi.fn(() => mockCryptoBytes(64)),
  beginMessageEnvelope: vi.fn(() => ({
    contentKey: mockCryptoBytes(32),
    wrappedContentKey: mockCryptoBytes(81),
  })),
  encryptTextWithContentKey: vi.fn(() => mockCryptoBytes(64)),
  generateKeyPair: vi.fn(() => ({
    publicKey: mockCryptoBytes(32),
    privateKey: mockCryptoBytes(32),
  })),
  OpaqueClientConfig: {},
  OpaqueRegistrationRequest: {
    deserialize: vi.fn(() => ({ serialize: vi.fn(() => [7, 8, 9]) })),
  },
  createOpaqueServer: vi.fn(() =>
    Promise.resolve({
      registerInit: vi.fn(() => Promise.resolve({ serialize: () => [10, 11, 12] })),
    })
  ),
  OPAQUE_SERVER_IDENTIFIER: 'opaque-server-v1',
  deriveTotpEncryptionKey: vi.fn(() => mockCryptoBytes(32)),
  encryptTotpSecret: vi.fn(() => mockCryptoBytes(48)),
}));

function createMockSelectChain(result: unknown[] = []) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(result)),
      })),
    })),
  };
}

function createMockDb() {
  const buildValues = (): Promise<void> & { onConflictDoUpdate: () => Promise<void> } => {
    const promise = Promise.resolve();
    const augmented = promise as Promise<void> & {
      onConflictDoUpdate: () => Promise<void>;
    };
    augmented.onConflictDoUpdate = vi.fn(() => Promise.resolve());
    return augmented;
  };
  return {
    select: vi.fn(() => createMockSelectChain()),
    insert: vi.fn(() => ({
      values: vi.fn(() => buildValues()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    })),
  };
}

vi.mock('@hushbox/db', () => {
  return {
    createDb: vi.fn(() => createMockDb()),
    LOCAL_NEON_DEV_CONFIG: {},
    users: { id: 'id' },
    conversations: { id: 'id' },
    messages: { id: 'id' },
    contentItems: { id: 'id' },
    projects: { id: 'id' },
    payments: { id: 'id' },
    wallets: { id: 'id' },
    ledgerEntries: { id: 'id' },
    epochs: { id: 'id' },
    epochMembers: { id: 'id' },
    conversationMembers: { id: 'id' },
    usageRecords: { id: 'id' },
    llmCompletions: { id: 'id' },
    conversationSpending: { id: 'id' },
  };
});

vi.mock('@hushbox/db/factories', () => ({
  userFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-user-id',
      email: 'test@example.com',
      username: 'test_user',
      publicKey: mockCryptoBytes(32),
      passwordWrappedPrivateKey: mockCryptoBytes(48),
      recoveryWrappedPrivateKey: mockCryptoBytes(48),
      opaqueRegistration: mockCryptoBytes(64),
      emailVerified: false,
      totpEnabled: false,
      totpSecretEncrypted: null,
      hasAcknowledgedPhrase: false,
      ...overrides,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  },
  conversationFactory: {
    build: vi.fn((overrides?: { id?: string; userId?: string; title?: Uint8Array }) => ({
      id: overrides?.id ?? 'test-conv-id',
      userId: overrides?.userId ?? 'test-user-id',
      title: overrides?.title ?? mockCryptoBytes(64),
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 1,

      ...overrides,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  },
  messageFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-msg-id',
      conversationId: 'test-conv-id',
      wrappedContentKey: mockCryptoBytes(81),
      senderType: 'user',
      senderId: 'test-user-id',
      epochNumber: 1,
      sequenceNumber: 1,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  contentItemFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-ci-id',
      messageId: 'test-msg-id',
      contentType: 'text',
      position: 0,
      encryptedBlob: mockCryptoBytes(64),
      storageKey: null,
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      durationMs: null,
      modelName: null,
      cost: null,
      isSmartModel: false,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  projectFactory: {
    build: vi.fn(
      (overrides?: {
        id?: string;
        userId?: string;
        encryptedName?: Uint8Array;
        encryptedDescription?: Uint8Array | null;
      }) => ({
        id: overrides?.id ?? 'test-project-id',
        userId: overrides?.userId ?? 'test-user-id',
        encryptedName: overrides?.encryptedName ?? mockCryptoBytes(64),
        encryptedDescription: overrides?.encryptedDescription ?? null,
        ...overrides,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    ),
  },
  paymentFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-payment-id',
      userId: 'test-user-id',
      amount: '50.00000000',
      status: 'completed',
      helcimTransactionId: 'txn-123',
      cardType: 'Visa',
      cardLastFour: '4242',
      errorMessage: null,
      ...overrides,
      createdAt: new Date(),
      updatedAt: new Date(),
      webhookReceivedAt: new Date(),
    })),
  },
  walletFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-wallet-id',
      userId: 'test-user-id',
      type: 'purchased',
      balance: '0.00000000',
      priority: 0,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  ledgerEntryFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-ledger-id',
      walletId: 'test-wallet-id',
      amount: '0.00000000',
      balanceAfter: '0.00000000',
      entryType: 'welcome_credit',
      paymentId: null,
      usageRecordId: null,
      sourceWalletId: 'test-wallet-id',
      ...overrides,
      createdAt: new Date(),
    })),
  },
  epochFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-epoch-id',
      conversationId: 'test-conv-id',
      epochNumber: 1,
      epochPublicKey: mockCryptoBytes(32),
      confirmationHash: mockCryptoBytes(32),
      chainLink: null,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  epochMemberFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-epoch-member-id',
      epochId: 'test-epoch-id',
      memberPublicKey: mockCryptoBytes(32),
      wrap: mockCryptoBytes(48),
      privilege: 'owner',
      visibleFromEpoch: 1,
      ...overrides,
      createdAt: new Date(),
    })),
  },
  conversationMemberFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-member-id',
      conversationId: 'test-conv-id',
      userId: 'test-user-id',
      linkId: null,
      privilege: 'owner',
      visibleFromEpoch: 1,
      ...overrides,
      joinedAt: new Date(),
      leftAt: null,
    })),
  },
  usageRecordFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-usage-id',
      userId: 'test-user-id',
      type: 'llm_completion',
      status: 'completed',
      cost: '0.01000000',
      sourceType: 'message',
      sourceId: 'test-msg-id',
      ...overrides,
      createdAt: new Date(),
      completedAt: new Date(),
    })),
  },
  llmCompletionFactory: {
    build: vi.fn((overrides: Record<string, unknown> = {}) => ({
      id: 'test-completion-id',
      usageRecordId: 'test-usage-id',
      model: 'openai/gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      ...overrides,
    })),
  },
}));

import {
  SEED_CONFIG,
  generateSeedData,
  generatePersonaData,
  generateTestPersonaData,
  loadSeedAiModel,
  upsertEntity,
  seed,
  seedUUID,
  createScreenshotConversations,
  BASE_TEST_PERSONAS,
  E2E_PROJECT_NAMES,
  MOBILE_TEST_PERSONA,
  TEST_PERSONAS,
} from './seed';

const FIRST_PROJECT = E2E_PROJECT_NAMES[0];
const EXPECTED_TEST_USER_COUNT = BASE_TEST_PERSONAS.length * E2E_PROJECT_NAMES.length;

describe('seed script', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['PUBLIC_MODELS_URL'] = 'https://models.test/local.json';
    await loadSeedAiModel();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('SEED_CONFIG', () => {
    it('defines moderate data amounts', () => {
      expect(SEED_CONFIG.USER_COUNT).toBe(5);
      expect(SEED_CONFIG.PROJECTS_PER_USER).toBe(2);
      expect(SEED_CONFIG.CONVERSATIONS_PER_USER).toBe(2);
      expect(SEED_CONFIG.MESSAGES_PER_CONVERSATION).toBe(5);
    });
  });

  describe('seedUUID', () => {
    it('generates valid UUID format', () => {
      const uuid = seedUUID('test');
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });

    it('generates deterministic UUIDs', () => {
      const uuid1 = seedUUID('test');
      const uuid2 = seedUUID('test');
      expect(uuid1).toBe(uuid2);
    });

    it('generates different UUIDs for different inputs', () => {
      const uuid1 = seedUUID('test1');
      const uuid2 = seedUUID('test2');
      expect(uuid1).not.toBe(uuid2);
    });
  });

  describe('generateSeedData', () => {
    it('generates correct number of users', () => {
      const data = generateSeedData();
      expect(data.users).toHaveLength(SEED_CONFIG.USER_COUNT);
    });

    it('generates deterministic user IDs as valid UUIDs', () => {
      const data = generateSeedData();
      const firstUser = data.users[0];
      const fifthUser = data.users[4];
      expect(firstUser).toBeDefined();
      expect(fifthUser).toBeDefined();
      expect(firstUser?.id).toBe(seedUUID('seed-user-1'));
      expect(fifthUser?.id).toBe(seedUUID('seed-user-5'));
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(firstUser?.id).toMatch(uuidRegex);
    });

    it('derives deterministic, unique identities for filler users', () => {
      const first = generateSeedData();
      const second = generateSeedData();

      const emails = first.users.map((u) => u.email);
      const usernames = first.users.map((u) => u.username);

      // Index-derived, so identical across runs and unique by construction.
      // bulkUpsert conflicts only on id, so a colliding email/username (the
      // factory's faker default) would abort the whole insert.
      expect(first.users[0]?.email).toBe(`seed-user-1@${DEV_EMAIL_DOMAIN}`);
      expect(first.users[0]?.username).toBe('seeduser1');
      expect(first.users[4]?.username).toBe('seeduser5');
      expect(second.users.map((u) => u.email)).toEqual(emails);
      expect(second.users.map((u) => u.username)).toEqual(usernames);
      expect(new Set(emails).size).toBe(emails.length);
      expect(new Set(usernames).size).toBe(usernames.length);
    });

    it('generates correct number of projects (2 per user)', () => {
      const data = generateSeedData();
      const expectedProjects = SEED_CONFIG.USER_COUNT * SEED_CONFIG.PROJECTS_PER_USER;
      expect(data.projects).toHaveLength(expectedProjects);
    });

    it('generates correct number of conversations (2 per user)', () => {
      const data = generateSeedData();
      const expectedConversations = SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.conversations).toHaveLength(expectedConversations);
    });

    it('generates correct number of messages (5 per conversation)', () => {
      const data = generateSeedData();
      const expectedMessages =
        SEED_CONFIG.USER_COUNT *
        SEED_CONFIG.CONVERSATIONS_PER_USER *
        SEED_CONFIG.MESSAGES_PER_CONVERSATION;
      expect(data.messages).toHaveLength(expectedMessages);
    });

    it('links projects to correct users', () => {
      const data = generateSeedData();
      const user1Id = seedUUID('seed-user-1');
      const user1Projects = data.projects.filter((p) => p.userId === user1Id);
      expect(user1Projects).toHaveLength(SEED_CONFIG.PROJECTS_PER_USER);
    });

    it('links conversations to correct users', () => {
      const data = generateSeedData();
      const user1Id = seedUUID('seed-user-1');
      const user1Convs = data.conversations.filter((c) => c.userId === user1Id);
      expect(user1Convs).toHaveLength(SEED_CONFIG.CONVERSATIONS_PER_USER);
    });

    it('links messages to correct conversations', () => {
      const data = generateSeedData();
      const firstConv = data.conversations[0];
      expect(firstConv).toBeDefined();
      const conv1Messages = data.messages.filter((m) => m.conversationId === firstConv?.id);
      expect(conv1Messages).toHaveLength(SEED_CONFIG.MESSAGES_PER_CONVERSATION);
    });

    it('alternates message senderType between user and ai', () => {
      const data = generateSeedData();
      const firstConv = data.conversations[0];
      expect(firstConv).toBeDefined();
      const conv1Messages = data.messages.filter((m) => m.conversationId === firstConv?.id);

      expect(conv1Messages[0]?.senderType).toBe('user');
      expect(conv1Messages[1]?.senderType).toBe('ai');
      expect(conv1Messages[2]?.senderType).toBe('user');
    });

    it('generates epochs for each conversation', () => {
      const data = generateSeedData();
      const expectedEpochs = SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.epochs).toHaveLength(expectedEpochs);
    });

    it('generates epoch members for each conversation', () => {
      const data = generateSeedData();
      const expectedEpochMembers = SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.epochMembers).toHaveLength(expectedEpochMembers);
    });

    it('generates conversation members for each conversation', () => {
      const data = generateSeedData();
      const expectedConversationMembers =
        SEED_CONFIG.USER_COUNT * SEED_CONFIG.CONVERSATIONS_PER_USER;
      expect(data.conversationMembers).toHaveLength(expectedConversationMembers);
    });

    it('messages have wrappedContentKey instead of plaintext content', () => {
      const data = generateSeedData();
      const firstMsg = data.messages[0];
      expect(firstMsg).toBeDefined();
      expect(firstMsg?.wrappedContentKey).toBeInstanceOf(Uint8Array);
      expect('content' in (firstMsg ?? {})).toBe(false);
      expect('role' in (firstMsg ?? {})).toBe(false);
    });

    it('generates content items for each message', () => {
      const data = generateSeedData();
      expect(data.contentItems).toHaveLength(data.messages.length);
      const firstItem = data.contentItems[0];
      expect(firstItem).toBeDefined();
      expect(firstItem?.encryptedBlob).toBeInstanceOf(Uint8Array);
      expect(firstItem?.contentType).toBe('text');
    });

    it('conversations have encrypted titles', () => {
      const data = generateSeedData();
      const firstConv = data.conversations[0];
      expect(firstConv).toBeDefined();
      expect(firstConv?.title).toBeInstanceOf(Uint8Array);
    });

    it('projects have encrypted names', () => {
      const data = generateSeedData();
      const firstProject = data.projects[0];
      expect(firstProject).toBeDefined();
      expect(firstProject?.encryptedName).toBeInstanceOf(Uint8Array);
    });
  });

  describe('upsertEntity', () => {
    function createTestMockDb(existingRecords: unknown[] = []) {
      return {
        select: vi.fn(() => createMockSelectChain(existingRecords)),
        insert: vi.fn(() => ({
          values: vi.fn(() => Promise.resolve()),
        })),
      };
    }

    it('returns "created" when entity does not exist', async () => {
      const mockDb = createTestMockDb([]);

      const result = await upsertEntity(
        mockDb as never,
        { id: 'id' } as never,
        { id: 'test-1' } as never
      );

      expect(result).toBe('created');
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('returns "updated" and calls update when entity already exists', async () => {
      const mockSetChain = { where: vi.fn(() => Promise.resolve()) };
      const mockDb = {
        select: vi.fn(() => createMockSelectChain([{ id: 'test-1', name: 'old' }])),
        insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve()) })),
        update: vi.fn(() => ({ set: vi.fn(() => mockSetChain) })),
      };

      const result = await upsertEntity(
        mockDb as never,
        { id: 'id' } as never,
        { id: 'test-1', name: 'new-value' } as never
      );

      expect(result).toBe('updated');
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('seed', () => {
    it('throws if DATABASE_URL is not set', async () => {
      delete process.env['DATABASE_URL'];

      await expect(seed()).rejects.toThrow('DATABASE_URL is required');
    });

    it('seeds all entities without throwing', async () => {
      await expect(seed()).resolves.not.toThrow();
    });

    it('refuses to run against a non-local DATABASE_URL', async () => {
      process.env['DATABASE_URL'] = 'postgres://user:pass@db.prod.neon.tech/hushbox';

      await expect(seed()).rejects.toThrow(/refus|local/i);
    });

    it('proceeds against a 127.0.0.1 DATABASE_URL', async () => {
      process.env['DATABASE_URL'] = 'postgres://postgres:postgres@127.0.0.1:4444/hushbox';

      await expect(seed()).resolves.not.toThrow();
    });

    it('proceeds against a bracketed IPv6 loopback DATABASE_URL', async () => {
      process.env['DATABASE_URL'] = 'postgres://postgres:postgres@[::1]:5432/hushbox';

      await expect(seed()).resolves.not.toThrow();
    });

    it('refuses to run against an unparseable DATABASE_URL', async () => {
      process.env['DATABASE_URL'] = 'not a valid url';

      await expect(seed()).rejects.toThrow(/refus|local/i);
    });
  });

  describe('generatePersonaData', () => {
    it('generates all three personas', async () => {
      const data = await generatePersonaData();
      expect(data.users).toHaveLength(3);
    });

    it('includes alice, bob, and charlie users with dev domain', async () => {
      const data = await generatePersonaData();
      const emails = data.users.map((u) => u.email);
      expect(emails).toContain(`alice@${DEV_EMAIL_DOMAIN}`);
      expect(emails).toContain(`bob@${DEV_EMAIL_DOMAIN}`);
      expect(emails).toContain(`charlie@${DEV_EMAIL_DOMAIN}`);
    });

    it('uses deterministic UUIDs based on persona name', async () => {
      const data = await generatePersonaData();
      const alice = data.users.find((u) => u.email === `alice@${DEV_EMAIL_DOMAIN}`);
      expect(alice?.id).toBe(seedUUID('dev-user-alice'));
    });

    it('generates sample data only for alice (hasSampleData=true)', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const bobId = seedUUID('dev-user-bob');
      const charlieId = seedUUID('dev-user-charlie');

      const aliceProjects = data.projects.filter((p) => p.userId === aliceId);
      expect(aliceProjects.length).toBeGreaterThan(0);

      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);
      expect(aliceConversations.length).toBeGreaterThan(0);

      const bobProjects = data.projects.filter((p) => p.userId === bobId);
      const bobConversations = data.conversations.filter((c) => c.userId === bobId);
      expect(bobProjects).toHaveLength(0);
      expect(bobConversations).toHaveLength(0);

      const charlieProjects = data.projects.filter((p) => p.userId === charlieId);
      expect(charlieProjects).toHaveLength(0);
    });

    it('charlie has exactly 1 conversation with 4 messages', async () => {
      const data = await generatePersonaData();
      const charlieId = seedUUID('dev-user-charlie');

      const charlieConversations = data.conversations.filter((c) => c.userId === charlieId);
      expect(charlieConversations).toHaveLength(1);

      const charlieMessages = data.messages.filter((m) =>
        charlieConversations.some((c) => c.id === m.conversationId)
      );
      expect(charlieMessages).toHaveLength(4);

      expect(charlieMessages[0]?.senderType).toBe('user');
      expect(charlieMessages[1]?.senderType).toBe('ai');
      expect(charlieMessages[2]?.senderType).toBe('user');
      expect(charlieMessages[3]?.senderType).toBe('ai');
    });

    it('alice has exactly 2 projects', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceProjects = data.projects.filter((p) => p.userId === aliceId);
      expect(aliceProjects).toHaveLength(2);
    });

    it('alice has exactly 155 conversations (150 sample + 5 screenshot)', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);
      expect(aliceConversations).toHaveLength(155);
    });

    it('sets emailVerified correctly from persona definition', async () => {
      const data = await generatePersonaData();
      const alice = data.users.find((u) => u.email === `alice@${DEV_EMAIL_DOMAIN}`);
      const bob = data.users.find((u) => u.email === `bob@${DEV_EMAIL_DOMAIN}`);
      const charlie = data.users.find((u) => u.email === `charlie@${DEV_EMAIL_DOMAIN}`);

      expect(alice?.emailVerified).toBe(true);
      expect(bob?.emailVerified).toBe(true);
      expect(charlie?.emailVerified).toBe(true);
    });

    it('alice has exactly 14 payments', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const alicePayments = data.payments.filter((p) => p.userId === aliceId);
      expect(alicePayments).toHaveLength(14);
    });

    it('alice has exactly 14 deposit ledger entries', async () => {
      const data = await generatePersonaData();
      const purchasedWalletId = seedUUID('alice-wallet-purchased');
      const aliceDepositEntries = data.ledgerEntries.filter(
        (e) => e.walletId === purchasedWalletId && e.entryType === 'deposit'
      );
      expect(aliceDepositEntries).toHaveLength(14);
    });

    it('all alice payments are confirmed status', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const alicePayments = data.payments.filter((p) => p.userId === aliceId);
      for (const payment of alicePayments) {
        expect(payment.status).toBe('completed');
      }
    });

    it('deposit ledger entries are linked to payments', async () => {
      const data = await generatePersonaData();
      const purchasedWalletId = seedUUID('alice-wallet-purchased');
      const aliceDepositEntries = data.ledgerEntries.filter(
        (e) => e.walletId === purchasedWalletId && e.entryType === 'deposit'
      );
      const alicePaymentIds = new Set(
        data.payments.filter((p) => p.userId === seedUUID('dev-user-alice')).map((p) => p.id)
      );

      for (const entry of aliceDepositEntries) {
        expect(alicePaymentIds.has(entry.paymentId ?? '')).toBe(true);
      }
    });

    it('bob and charlie have no payments', async () => {
      const data = await generatePersonaData();
      const bobId = seedUUID('dev-user-bob');
      const charlieId = seedUUID('dev-user-charlie');

      const bobPayments = data.payments.filter((p) => p.userId === bobId);
      const charliePayments = data.payments.filter((p) => p.userId === charlieId);

      expect(bobPayments).toHaveLength(0);
      expect(charliePayments).toHaveLength(0);
    });

    it('persona users have valid crypto fields', async () => {
      const data = await generatePersonaData();
      for (const user of data.users) {
        expect(user.opaqueRegistration).toBeInstanceOf(Uint8Array);
        expect(user.opaqueRegistration.length).toBeGreaterThan(64);
        expect(user.publicKey).toBeInstanceOf(Uint8Array);
        expect(user.passwordWrappedPrivateKey).toBeInstanceOf(Uint8Array);
        expect(user.recoveryWrappedPrivateKey).toBeInstanceOf(Uint8Array);
      }
    });

    it('each persona has 2 wallets (purchased + free_tier)', async () => {
      const data = await generatePersonaData();
      expect(data.wallets).toHaveLength(6);

      const aliceId = seedUUID('dev-user-alice');
      const aliceWallets = data.wallets.filter((w) => w.userId === aliceId);
      expect(aliceWallets).toHaveLength(2);

      const purchased = aliceWallets.find((w) => w.type === 'purchased');
      const freeTier = aliceWallets.find((w) => w.type === 'free_tier');
      expect(purchased).toBeDefined();
      expect(freeTier).toBeDefined();
      expect(purchased?.priority).toBe(0);
      expect(freeTier?.priority).toBe(1);
    });

    it('alice conversations have epochs', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);

      for (const conv of aliceConversations) {
        const convEpochs = data.epochs.filter((e) => e.conversationId === conv.id);
        expect(convEpochs).toHaveLength(1);
        expect(convEpochs[0]?.epochNumber).toBe(1);
      }
    });

    it('alice conversations have conversation members with alice as owner', async () => {
      const data = await generatePersonaData();
      const aliceId = seedUUID('dev-user-alice');
      const aliceConversations = data.conversations.filter((c) => c.userId === aliceId);

      for (const conv of aliceConversations) {
        const convMembers = data.conversationMembers.filter((m) => m.conversationId === conv.id);
        expect(convMembers.length).toBeGreaterThanOrEqual(1);
        const aliceMember = convMembers.find((m) => m.userId === aliceId);
        expect(aliceMember).toBeDefined();
        expect(aliceMember?.privilege).toBe('owner');
      }
    });
  });

  describe('generateTestPersonaData', () => {
    it('generates one user per base persona per project plus the mobile persona', async () => {
      const data = await generateTestPersonaData();
      expect(data.users).toHaveLength(EXPECTED_TEST_USER_COUNT + 1);
    });

    it('includes test-alice, test-bob, and test-charlie variants with test domain', async () => {
      const data = await generateTestPersonaData();
      const emails = data.users.map((u) => u.email);
      expect(emails).toContain(`test-alice-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`);
      expect(emails).toContain(`test-bob-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`);
      expect(emails).toContain(`test-charlie-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`);
    });

    it('uses deterministic UUIDs based on project-suffixed persona name', async () => {
      const data = await generateTestPersonaData();
      const testAlice = data.users.find(
        (u) => u.email === `test-alice-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`
      );
      expect(testAlice?.id).toBe(seedUUID(`test-user-test-alice-${FIRST_PROJECT}`));
    });

    it('generates sample data only for test-alice variants (hasSampleData=true)', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID(`test-user-test-alice-${FIRST_PROJECT}`);
      const testBobId = seedUUID(`test-user-test-bob-${FIRST_PROJECT}`);
      const testCharlieId = seedUUID(`test-user-test-charlie-${FIRST_PROJECT}`);

      const testAliceProjects = data.projects.filter((p) => p.userId === testAliceId);
      expect(testAliceProjects.length).toBeGreaterThan(0);

      const testAliceConversations = data.conversations.filter((c) => c.userId === testAliceId);
      expect(testAliceConversations.length).toBeGreaterThan(0);

      const testBobProjects = data.projects.filter((p) => p.userId === testBobId);
      const testBobConversations = data.conversations.filter((c) => c.userId === testBobId);
      expect(testBobProjects).toHaveLength(0);
      expect(testBobConversations).toHaveLength(0);

      const testCharlieProjects = data.projects.filter((p) => p.userId === testCharlieId);
      const testCharlieConversations = data.conversations.filter((c) => c.userId === testCharlieId);
      expect(testCharlieProjects).toHaveLength(0);
      expect(testCharlieConversations).toHaveLength(0);
    });

    it('each test-alice variant has exactly 2 projects', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID(`test-user-test-alice-${FIRST_PROJECT}`);
      const testAliceProjects = data.projects.filter((p) => p.userId === testAliceId);
      expect(testAliceProjects).toHaveLength(2);
    });

    it('each test-alice variant has exactly 3 conversations', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID(`test-user-test-alice-${FIRST_PROJECT}`);
      const testAliceConversations = data.conversations.filter((c) => c.userId === testAliceId);
      expect(testAliceConversations).toHaveLength(3);
    });

    it('sets emailVerified correctly from base test persona definition', async () => {
      const data = await generateTestPersonaData();
      const testAlice = data.users.find(
        (u) => u.email === `test-alice-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`
      );
      const testBob = data.users.find(
        (u) => u.email === `test-bob-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`
      );
      const testCharlie = data.users.find(
        (u) => u.email === `test-charlie-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`
      );

      expect(testAlice?.emailVerified).toBe(true);
      expect(testBob?.emailVerified).toBe(true);
      expect(testCharlie?.emailVerified).toBe(false);
    });

    it('uses different email domain than dev personas', async () => {
      const devData = await generatePersonaData();
      const testData = await generateTestPersonaData();

      const devEmails = devData.users.map((u) => u.email);
      const testEmails = testData.users.map((u) => u.email);

      for (const devEmail of devEmails) {
        expect(testEmails).not.toContain(devEmail);
      }
    });

    it('includes test-2fa persona variants with TOTP enabled', async () => {
      const data = await generateTestPersonaData();
      const test2fa = data.users.find(
        (u) => u.email === `test-2fa-${FIRST_PROJECT}@${TEST_EMAIL_DOMAIN}`
      );

      expect(test2fa).toBeDefined();
      expect(test2fa?.emailVerified).toBe(true);
      expect(test2fa?.totpEnabled).toBe(true);
      expect(test2fa?.totpSecretEncrypted).toBeInstanceOf(Uint8Array);
    });

    it('test persona users have valid crypto fields', async () => {
      const data = await generateTestPersonaData();
      for (const user of data.users) {
        expect(user.opaqueRegistration).toBeInstanceOf(Uint8Array);
        expect(user.opaqueRegistration.length).toBeGreaterThan(64);
        expect(user.publicKey).toBeInstanceOf(Uint8Array);
        expect(user.passwordWrappedPrivateKey).toBeInstanceOf(Uint8Array);
        expect(user.recoveryWrappedPrivateKey).toBeInstanceOf(Uint8Array);
      }
    });

    it('each test persona has 2 wallets (purchased + free_tier)', async () => {
      const data = await generateTestPersonaData();
      expect(data.wallets).toHaveLength((TEST_PERSONAS.length + 1) * 2);
    });

    it('test-alice variant conversations have epochs and members', async () => {
      const data = await generateTestPersonaData();
      const testAliceId = seedUUID(`test-user-test-alice-${FIRST_PROJECT}`);
      const testAliceConversations = data.conversations.filter((c) => c.userId === testAliceId);

      for (const conv of testAliceConversations) {
        const convEpochs = data.epochs.filter((e) => e.conversationId === conv.id);
        expect(convEpochs).toHaveLength(1);

        const convMembers = data.conversationMembers.filter((m) => m.conversationId === conv.id);
        expect(convMembers).toHaveLength(1);
        expect(convMembers[0]?.userId).toBe(testAliceId);
      }
    });
  });

  describe('MOBILE_TEST_PERSONA', () => {
    it('uses an unsuffixed name so the Maestro YAML literal resolves', () => {
      expect(MOBILE_TEST_PERSONA.name).toBe('test-mobile');
    });

    it('has a varchar(20)-safe username', () => {
      expect(MOBILE_TEST_PERSONA.username).toBe('tmu');
      expect(MOBILE_TEST_PERSONA.username.length).toBeLessThanOrEqual(20);
    });

    it('is marked email-verified so login does not bounce to verification', () => {
      expect(MOBILE_TEST_PERSONA.emailVerified).toBe(true);
    });

    it('is not part of the per-project TEST_PERSONAS cross-product', () => {
      for (const persona of TEST_PERSONAS) {
        expect(persona.name).not.toBe('test-mobile');
      }
    });

    it('generates exactly one seeded user at test-mobile@test.hushbox.ai', async () => {
      const data = await generateTestPersonaData();
      const mobileUsers = data.users.filter((u) => u.email === `test-mobile@${TEST_EMAIL_DOMAIN}`);
      expect(mobileUsers).toHaveLength(1);
    });

    it('uses a deterministic UUID derived from test-user-test-mobile', async () => {
      const data = await generateTestPersonaData();
      const mobileUser = data.users.find((u) => u.email === `test-mobile@${TEST_EMAIL_DOMAIN}`);
      expect(mobileUser?.id).toBe(seedUUID('test-user-test-mobile'));
    });

    it('seeds two wallets for the mobile persona', async () => {
      const data = await generateTestPersonaData();
      const mobileUserId = seedUUID('test-user-test-mobile');
      const mobileWallets = data.wallets.filter((w) => w.userId === mobileUserId);
      expect(mobileWallets).toHaveLength(2);
    });

    it('seeds sample-data projects for the mobile persona', async () => {
      const data = await generateTestPersonaData();
      const mobileUserId = seedUUID('test-user-test-mobile');
      const mobileProjects = data.projects.filter((p) => p.userId === mobileUserId);
      expect(mobileProjects.length).toBeGreaterThan(0);
    });
  });

  describe('createScreenshotConversations', () => {
    function buildScreenshotParams() {
      return {
        aliceUserId: seedUUID('dev-user-alice'),
        alicePublicKey: mockCryptoBytes(32),
        bobUserId: seedUUID('dev-user-bob'),
        bobPublicKey: mockCryptoBytes(32),
        charlieUserId: seedUUID('dev-user-charlie'),
        charliePublicKey: mockCryptoBytes(32),
        now: new Date(),
      };
    }

    it('creates exactly 5 conversations', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      expect(result.conversations).toHaveLength(5);
    });

    it('uses deterministic screenshot-conv-* UUIDs', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      const ids = result.conversations.map((c) => c.id);
      expect(ids).toContain(seedUUID('screenshot-conv-chat'));
      expect(ids).toContain(seedUUID('screenshot-conv-group-chat'));
      expect(ids).toContain(seedUUID('screenshot-conv-code'));
      expect(ids).toContain(seedUUID('screenshot-conv-mermaid'));
      expect(ids).toContain(seedUUID('screenshot-conv-privacy'));
    });

    it('all conversations belong to alice', () => {
      const params = buildScreenshotParams();
      const result = createScreenshotConversations(params);
      for (const conv of result.conversations) {
        expect(conv.userId).toBe(params.aliceUserId);
      }
    });

    it('creates 5 epochs (one per conversation)', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      expect(result.epochs).toHaveLength(5);
    });

    it('creates 7 epoch members (4 solo + 3 group)', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      expect(result.epochMembers).toHaveLength(7);
    });

    it('creates 7 conversation members (4 solo + 3 group)', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      expect(result.conversationMembers).toHaveLength(7);
    });

    it('group chat has 3 epoch members', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      const groupConvId = seedUUID('screenshot-conv-group-chat');
      const groupEpoch = result.epochs.find((e) => e.conversationId === groupConvId);
      expect(groupEpoch).toBeDefined();
      const groupEpochMembers = result.epochMembers.filter((em) => em.epochId === groupEpoch!.id);
      expect(groupEpochMembers).toHaveLength(3);
    });

    it('group chat has 3 conversation members with correct privileges', () => {
      const params = buildScreenshotParams();
      const result = createScreenshotConversations(params);
      const groupConvId = seedUUID('screenshot-conv-group-chat');
      const members = result.conversationMembers.filter((m) => m.conversationId === groupConvId);
      expect(members).toHaveLength(3);
      const aliceMember = members.find((m) => m.userId === params.aliceUserId);
      const bobMember = members.find((m) => m.userId === params.bobUserId);
      const charlieMember = members.find((m) => m.userId === params.charlieUserId);
      expect(aliceMember?.privilege).toBe('owner');
      expect(bobMember?.privilege).toBe('write');
      expect(charlieMember?.privilege).toBe('write');
    });

    it('creates exactly 12 messages total', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      expect(result.messages).toHaveLength(12);
    });

    it('group chat has 4 messages with correct senders', () => {
      const params = buildScreenshotParams();
      const result = createScreenshotConversations(params);
      const groupConvId = seedUUID('screenshot-conv-group-chat');
      const groupMessages = result.messages.filter((m) => m.conversationId === groupConvId);
      expect(groupMessages).toHaveLength(4);
      expect(groupMessages[0]!.senderType).toBe('user');
      expect(groupMessages[0]!.senderId).toBe(params.aliceUserId);
      expect(groupMessages[1]!.senderType).toBe('user');
      expect(groupMessages[1]!.senderId).toBe(params.bobUserId);
      expect(groupMessages[2]!.senderType).toBe('user');
      expect(groupMessages[2]!.senderId).toBe(params.charlieUserId);
      expect(groupMessages[3]!.senderType).toBe('ai');
      expect(groupMessages[3]!.senderId).toBeNull();
    });

    it('solo conversations each have 2 messages (user + ai)', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      const soloNames = ['chat', 'code', 'mermaid', 'privacy'];
      for (const name of soloNames) {
        const convId = seedUUID(`screenshot-conv-${name}`);
        const msgs = result.messages.filter((m) => m.conversationId === convId);
        expect(msgs).toHaveLength(2);
        expect(msgs[0]!.senderType).toBe('user');
        expect(msgs[1]!.senderType).toBe('ai');
      }
    });

    it('all messages have wrappedContentKey', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      for (const msg of result.messages) {
        expect(msg.wrappedContentKey).toBeInstanceOf(Uint8Array);
      }
    });

    it('creates content items for each message', () => {
      const result = createScreenshotConversations(buildScreenshotParams());
      expect(result.contentItems).toHaveLength(result.messages.length);
      for (const item of result.contentItems) {
        expect(item.encryptedBlob).toBeInstanceOf(Uint8Array);
        expect(item.contentType).toBe('text');
      }
    });
  });
});
