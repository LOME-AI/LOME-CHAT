import { describe, it, expect, vi, beforeEach } from 'vitest';
import { conversations, epochs, epochMembers, conversationMembers, messages } from '@hushbox/db';
import {
  listDevPersonas,
  cleanupTestData,
  resetTrialUsage,
  resetAuthRateLimits,
  resetUsageRateLimits,
  createDevGroupChat,
  createDevConversation,
  createDevMultiModelConversation,
  createDevMediaConversation,
  setWalletBalance,
} from './dev.js';

/**
 * Sentinel seed model id passed by these unit tests. The production route
 * derives this from `pickValueTextModel(rawModels)` at request time; we don't
 * exercise that selection here.
 */
const TEST_SEED_AI_MODEL = 'anthropic/claude-haiku-4.5';

vi.mock('../billing/index.js', () => ({
  checkUserBalance: vi.fn().mockResolvedValue({
    hasBalance: true,
    currentBalance: '10.00000000',
    freeAllowanceCents: 0,
  }),
}));

const mockCreateOrGetConversation = vi.fn();
vi.mock('../conversations/index.js', () => ({
  createOrGetConversation: (...args: unknown[]) => mockCreateOrGetConversation(...args),
}));

const mockSaveUserOnlyMessage = vi.fn();
vi.mock('../chat/index.js', () => ({
  saveUserOnlyMessage: (...args: unknown[]) => mockSaveUserOnlyMessage(...args),
}));

const mockAssignSequenceNumbers = vi.fn();
const mockFetchEpochPublicKey = vi.fn();
const mockInsertEnvelopeTextMessage = vi.fn();
const mockInsertEnvelopeMediaMessage = vi.fn();
vi.mock('../chat/message-helpers.js', () => ({
  assignSequenceNumbers: (...args: unknown[]) => mockAssignSequenceNumbers(...args),
  fetchEpochPublicKey: (...args: unknown[]) => mockFetchEpochPublicKey(...args),
  insertEnvelopeTextMessage: (...args: unknown[]) => mockInsertEnvelopeTextMessage(...args),
  insertEnvelopeMediaMessage: (...args: unknown[]) => mockInsertEnvelopeMediaMessage(...args),
}));

const mockCreateFirstEpoch = vi.fn();
const mockEncryptMessageForStorage = vi.fn();
const mockBeginMessageEnvelope = vi.fn();
const mockEncryptBinaryWithContentKey = vi.fn();

vi.mock('@hushbox/crypto', () => ({
  createFirstEpoch: (...args: unknown[]) => mockCreateFirstEpoch(...args),
  encryptTextForEpoch: (...args: unknown[]) => mockEncryptMessageForStorage(...args),
  beginMessageEnvelope: (...args: unknown[]) => mockBeginMessageEnvelope(...args),
  encryptBinaryWithContentKey: (...args: unknown[]) => mockEncryptBinaryWithContentKey(...args),
}));

describe('dev service', () => {
  /**
   * Single-user mock db for the solo-conversation seeders: `select` resolves the
   * looked-up user rows, and `transaction` runs its callback against an empty tx
   * stub (the persistence helpers it calls are themselves mocked).
   */
  function createMockDb(
    userRows: { id: string; username: string; email: string; publicKey: Uint8Array }[]
  ): unknown {
    const txMock = {};
    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(userRows),
        }),
      }),
      transaction: vi
        .fn()
        .mockImplementation(async (function_: (tx: typeof txMock) => Promise<void>) =>
          function_(txMock)
        ),
    };
  }

  describe('listDevPersonas', () => {
    let mockDb: {
      select: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockDb = {
        select: vi.fn(),
      };
    });

    it('returns empty array when no dev users exist', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await listDevPersonas(mockDb as never, 'dev');

      expect(result).toEqual([]);
    });

    it('returns personas with stats for dev users', async () => {
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                id: 'user-1',
                username: 'test_user',
                email: 'test@dev.hushbox.test',
                emailVerified: true,
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 5 }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([{ count: 100 }]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ count: 2 }]),
          }),
        });

      const result = await listDevPersonas(mockDb as never, 'dev');

      expect(result).toHaveLength(1);
      expect(result[0]?.username).toBe('test_user');
      expect(result[0]?.stats.conversationCount).toBe(5);
      expect(result[0]?.stats.messageCount).toBe(100);
      expect(result[0]?.stats.projectCount).toBe(2);
      expect(result[0]?.credits).toBe('$10.00');
    });
  });

  describe('cleanupTestData', () => {
    let mockDb: {
      select: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockDb = {
        select: vi.fn(),
        delete: vi.fn(),
      };
    });

    it('returns zeros when no test users exist', async () => {
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const result = await cleanupTestData(mockDb as never);

      expect(result).toEqual({ conversations: 0, messages: 0 });
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it('deletes messages and conversations for test users', async () => {
      mockDb.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'test-user-1' }]),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ id: 'conv-1' }, { id: 'conv-2' }]),
          }),
        });

      mockDb.delete
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue({ rowCount: 10 }),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockResolvedValue({ rowCount: 2 }),
        });

      const result = await cleanupTestData(mockDb as never);

      expect(result).toEqual({ conversations: 2, messages: 10 });
    });
  });

  describe('resetTrialUsage', () => {
    let mockRedis: {
      scan: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockRedis = {
        scan: vi.fn(),
        del: vi.fn().mockResolvedValue(0),
      };
    });

    it('deletes all trial usage keys and returns count', async () => {
      mockRedis.scan.mockResolvedValueOnce([
        '0',
        ['trial:token:abc', 'trial:ip:hash1', 'trial:token:def'],
      ]);

      const result = await resetTrialUsage(mockRedis as never);

      expect(result).toEqual({ deleted: 3 });
      expect(mockRedis.del).toHaveBeenCalledWith(
        'trial:token:abc',
        'trial:ip:hash1',
        'trial:token:def'
      );
    });

    it('returns zero when no trial usage keys exist', async () => {
      mockRedis.scan.mockResolvedValueOnce(['0', []]);

      const result = await resetTrialUsage(mockRedis as never);

      expect(result).toEqual({ deleted: 0 });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('handles multi-page scan results', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['42', ['trial:token:abc', 'trial:ip:hash1']])
        .mockResolvedValueOnce(['0', ['trial:token:def']]);

      const result = await resetTrialUsage(mockRedis as never);

      expect(result).toEqual({ deleted: 3 });
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetAuthRateLimits', () => {
    let mockRedis: {
      scan: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockRedis = {
        scan: vi.fn(),
        del: vi.fn().mockResolvedValue(0),
      };
    });

    it('deletes auth rate limit keys across all prefixes and returns count', async () => {
      // 10 specific prefixes: ratelimit + lockout patterns only
      mockRedis.scan
        .mockResolvedValueOnce(['0', ['login:user:ratelimit:alice']]) // login:*:ratelimit:*
        .mockResolvedValueOnce(['0', ['login:lockout:alice']]) // login:lockout:*
        .mockResolvedValueOnce(['0', ['register:email:ratelimit:alice@test.com']]) // register:*:ratelimit:*
        .mockResolvedValueOnce(['0', ['2fa:user:ratelimit:user-1']]) // 2fa:*:ratelimit:*
        .mockResolvedValueOnce(['0', []]) // 2fa:lockout:*
        .mockResolvedValueOnce(['0', ['recovery:user:ratelimit:alice']]) // recovery:*:ratelimit:*
        .mockResolvedValueOnce(['0', []]) // recovery:lockout:*
        .mockResolvedValueOnce(['0', []]) // verify:*:ratelimit:*
        .mockResolvedValueOnce(['0', []]) // resend-verify:*:ratelimit:*
        .mockResolvedValueOnce(['0', ['totp:used:user-1:123456']]); // totp:used:*

      const result = await resetAuthRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 6 });
      expect(mockRedis.del).toHaveBeenCalledTimes(6);
    });

    it('returns zero when no auth rate limit keys exist', async () => {
      // All prefix scans return empty
      mockRedis.scan.mockResolvedValue(['0', []]);

      const result = await resetAuthRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 0 });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('handles multi-page scan results within a single prefix', async () => {
      mockRedis.scan
        // login:*:ratelimit:* — first page
        .mockResolvedValueOnce(['42', ['login:user:ratelimit:alice']])
        // login:*:ratelimit:* — second page
        .mockResolvedValueOnce(['0', ['login:ip:ratelimit:hash1']])
        // All other 9 prefixes empty
        .mockResolvedValue(['0', []]);

      const result = await resetAuthRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 2 });
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });
  });

  describe('resetUsageRateLimits', () => {
    let mockRedis: {
      scan: ReturnType<typeof vi.fn>;
      del: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockRedis = {
        scan: vi.fn(),
        del: vi.fn().mockResolvedValue(0),
      };
    });

    it('deletes usage rate limit keys plus reservation buckets across every cleared prefix', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['0', ['chat:stream:user:ratelimit:alice']]) // chat stream
        .mockResolvedValueOnce(['0', ['media:download:user:ratelimit:bob']]) // media download
        .mockResolvedValueOnce(['0', ['share:create:user:ratelimit:carol']]) // share create
        .mockResolvedValueOnce(['0', ['chat:reserved:alice']]) // personal reservation
        .mockResolvedValueOnce(['0', ['chat:group-reserved:conv-1:member-1']]) // group member
        .mockResolvedValueOnce(['0', ['chat:conversation-reserved:conv-1']]); // group conversation

      const result = await resetUsageRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 6 });
      expect(mockRedis.del).toHaveBeenCalledTimes(6);
    });

    it('returns zero when no usage rate limit keys exist', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);

      const result = await resetUsageRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 0 });
      expect(mockRedis.del).not.toHaveBeenCalled();
    });

    it('does not scan trial or IP-scoped buckets that other tests depend on', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);

      await resetUsageRateLimits(mockRedis as never);

      const matchedPatterns = mockRedis.scan.mock.calls.map(
        (call: unknown[]) => (call[1] as { match: string }).match
      );
      expect(matchedPatterns).not.toContain('trial:chat:stream:ip:ratelimit:*');
      expect(matchedPatterns).not.toContain('share:get:ip:ratelimit:*');
    });

    it('handles multi-page scan results within a single prefix', async () => {
      mockRedis.scan
        .mockResolvedValueOnce(['99', ['chat:stream:user:ratelimit:alice']])
        .mockResolvedValueOnce(['0', ['chat:stream:user:ratelimit:bob']])
        .mockResolvedValue(['0', []]);

      const result = await resetUsageRateLimits(mockRedis as never);

      expect(result).toEqual({ deleted: 2 });
      expect(mockRedis.del).toHaveBeenCalledTimes(2);
    });

    it('clears speculative reservation buckets so a fresh setWalletBalance reflects the actual available balance', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);

      await resetUsageRateLimits(mockRedis as never);

      const matchedPatterns = mockRedis.scan.mock.calls.map(
        (call: unknown[]) => (call[1] as { match: string }).match
      );
      expect(matchedPatterns).toContain('chat:reserved:*');
      expect(matchedPatterns).toContain('chat:group-reserved:*');
      expect(matchedPatterns).toContain('chat:conversation-reserved:*');
    });
  });

  describe('createDevGroupChat', () => {
    const ALICE_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);
    const BOB_PUBLIC_KEY = new Uint8Array([5, 6, 7, 8]);
    const EPOCH_PUBLIC_KEY = new Uint8Array([10, 11, 12, 13]);
    const CONFIRMATION_HASH = new Uint8Array([20, 21, 22]);
    const ALICE_WRAP = new Uint8Array([30, 31]);
    const BOB_WRAP = new Uint8Array([40, 41]);
    const ENCRYPTED_BLOB = new Uint8Array([50, 51, 52]);

    let insertCalls: { table: unknown; values: unknown }[];

    function createGroupChatMockDb(
      userRows: {
        id: string;
        username: string;
        email: string;
        publicKey: Uint8Array;
      }[]
    ) {
      insertCalls = [];

      const mockSelect = vi.fn();
      const mockInsert = vi.fn();

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(userRows),
        }),
      });

      mockInsert.mockImplementation((table: unknown) => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertCalls.push({ table, values: vals });
          return Promise.resolve();
        }),
      }));

      const mockUpdate = vi.fn().mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(null),
        }),
      }));

      const txMock = { select: mockSelect, insert: mockInsert, update: mockUpdate };
      return {
        select: mockSelect,
        insert: mockInsert,
        update: mockUpdate,
        transaction: vi
          .fn()
          .mockImplementation(async (function_: (tx: typeof txMock) => Promise<void>) =>
            function_(txMock)
          ),
      };
    }

    beforeEach(() => {
      mockCreateFirstEpoch.mockReset();
      mockEncryptMessageForStorage.mockReset();

      mockCreateFirstEpoch.mockReturnValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        confirmationHash: CONFIRMATION_HASH,
        memberWraps: [{ wrap: ALICE_WRAP }, { wrap: BOB_WRAP }],
      });
      mockEncryptMessageForStorage.mockReturnValue(ENCRYPTED_BLOB);
    });

    it('looks up users by email and returns conversationId and members', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      const result = await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      expect(result.conversationId).toBeDefined();
      expect(typeof result.conversationId).toBe('string');
      expect(result.members).toHaveLength(2);
      expect(result.members).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: 'alice-id',
            username: 'alice',
            email: 'alice@test.hushbox.ai',
          }),
          expect.objectContaining({
            userId: 'bob-id',
            username: 'bob',
            email: 'bob@test.hushbox.ai',
          }),
        ])
      );
    });

    it('calls createFirstEpoch with all member public keys', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      expect(mockCreateFirstEpoch).toHaveBeenCalledWith([ALICE_PUBLIC_KEY, BOB_PUBLIC_KEY]);
    });

    it('inserts conversation, epoch, epochMembers, and conversationMembers rows', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      const tables = insertCalls.map((c) => c.table);
      expect(tables).toContain(conversations);
      expect(tables).toContain(epochs);
      expect(tables).toContain(epochMembers);
      expect(tables).toContain(conversationMembers);
    });

    it('sets owner privilege for owner and admin for other members', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      const memberInsert = insertCalls.find((c) => c.table === conversationMembers);
      const memberRows = memberInsert!.values as {
        userId: string;
        privilege: string;
        acceptedAt: Date;
      }[];

      const aliceRow = memberRows.find((r) => r.userId === 'alice-id');
      const bobRow = memberRows.find((r) => r.userId === 'bob-id');
      expect(aliceRow?.privilege).toBe('owner');
      expect(bobRow?.privilege).toBe('admin');
      expect(aliceRow?.acceptedAt).toBeInstanceOf(Date);
      expect(bobRow?.acceptedAt).toBeInstanceOf(Date);
    });

    it('creates pending member with acceptedAt: null when listed in pendingMemberEmails', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        pendingMemberEmails: ['bob@test.hushbox.ai'],
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      const memberInsert = insertCalls.find((c) => c.table === conversationMembers);
      const memberRows = memberInsert!.values as {
        userId: string;
        acceptedAt: Date | null;
      }[];

      const aliceRow = memberRows.find((r) => r.userId === 'alice-id');
      const bobRow = memberRows.find((r) => r.userId === 'bob-id');
      // Owner is never pending — staying as the always-accepted seeder.
      expect(aliceRow?.acceptedAt).toBeInstanceOf(Date);
      // Bob was listed in pendingMemberEmails, so the seed must leave his
      // acceptedAt null. This is the row state the /decline E2E exercises.
      expect(bobRow?.acceptedAt).toBeNull();
    });

    it('encrypts and inserts messages when provided', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        seedAiModel: TEST_SEED_AI_MODEL,
        messages: [
          { senderEmail: 'alice@test.hushbox.ai', content: 'Hello from Alice', senderType: 'user' },
          { content: 'Echo: Hello', senderType: 'ai' },
        ],
      });

      expect(mockEncryptMessageForStorage).toHaveBeenCalledTimes(1);
      expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(EPOCH_PUBLIC_KEY, '');

      expect(mockInsertEnvelopeTextMessage).toHaveBeenCalledTimes(2);

      const call0 = mockInsertEnvelopeTextMessage.mock.calls[0]![1] as Record<string, unknown>;
      expect(call0['senderType']).toBe('user');
      expect(call0['senderId']).toBe('alice-id');
      expect(call0['sequenceNumber']).toBe(1);

      const call1 = mockInsertEnvelopeTextMessage.mock.calls[1]![1] as Record<string, unknown>;
      expect(call1['senderType']).toBe('ai');
      expect(call1['sequenceNumber']).toBe(2);
      expect(call1['modelName']).toBe(TEST_SEED_AI_MODEL);
    });

    it('does not insert messages when none provided', async () => {
      const mockDb = createGroupChatMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await createDevGroupChat(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        memberEmails: ['bob@test.hushbox.ai'],
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      const msgInsert = insertCalls.find((c) => c.table === messages);
      expect(msgInsert).toBeUndefined();
      expect(mockEncryptMessageForStorage).toHaveBeenCalledTimes(1);
      expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(EPOCH_PUBLIC_KEY, '');
    });

    it('throws when owner email not found in database', async () => {
      const mockDb = createGroupChatMockDb([
        { id: 'bob-id', username: 'bob', email: 'bob@test.hushbox.ai', publicKey: BOB_PUBLIC_KEY },
      ]);

      await expect(
        createDevGroupChat(mockDb as never, {
          ownerEmail: 'alice@test.hushbox.ai',
          memberEmails: ['bob@test.hushbox.ai'],
          seedAiModel: TEST_SEED_AI_MODEL,
        })
      ).rejects.toThrow('Owner not found');
    });
  });

  describe('setWalletBalance', () => {
    function createSetWalletMockDb(options: {
      userRows: { id: string }[];
      updateRows: { id: string; balance: string }[];
    }) {
      const mockSelect = vi.fn();
      const mockUpdate = vi.fn();
      const mockInsert = vi.fn();

      mockSelect.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(options.userRows),
        }),
      });

      mockUpdate.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue(options.updateRows),
          }),
        }),
      });

      const insertValuesSpy = vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: 'ledger-1' }]),
      });
      mockInsert.mockReturnValue({
        values: insertValuesSpy,
      });

      return {
        db: { select: mockSelect, update: mockUpdate, insert: mockInsert },
        insertValuesSpy,
      };
    }

    it('updates wallet balance and creates ledger entry', async () => {
      const { db, insertValuesSpy } = createSetWalletMockDb({
        userRows: [{ id: 'user-1' }],
        updateRows: [{ id: 'wallet-1', balance: '10.00000000' }],
      });

      const result = await setWalletBalance(db as never, {
        email: 'test@test.hushbox.ai',
        walletType: 'purchased',
        balance: '10.00000000',
      });

      expect(result).toEqual({ newBalance: '10.00000000' });
      expect(db.update).toHaveBeenCalled();
      expect(db.insert).toHaveBeenCalled();

      const ledgerValues = insertValuesSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(ledgerValues['walletId']).toBe('wallet-1');
      expect(ledgerValues['balanceAfter']).toBe('10.00000000');
      expect(ledgerValues['entryType']).toBe('adjustment');
      expect(ledgerValues['sourceWalletId']).toBe('wallet-1');
    });

    it('throws when user not found', async () => {
      const { db } = createSetWalletMockDb({
        userRows: [],
        updateRows: [],
      });

      await expect(
        setWalletBalance(db as never, {
          email: 'unknown@test.hushbox.ai',
          walletType: 'purchased',
          balance: '10.00000000',
        })
      ).rejects.toThrow('User not found');
    });

    it('throws when wallet not found', async () => {
      const { db } = createSetWalletMockDb({
        userRows: [{ id: 'user-1' }],
        updateRows: [], // UPDATE returns 0 rows
      });

      await expect(
        setWalletBalance(db as never, {
          email: 'test@test.hushbox.ai',
          walletType: 'purchased',
          balance: '10.00000000',
        })
      ).rejects.toThrow('Wallet not found');
    });
  });

  describe('createDevConversation', () => {
    const ALICE_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);
    const EPOCH_PUBLIC_KEY = new Uint8Array([10, 11, 12, 13]);
    const CONFIRMATION_HASH = new Uint8Array([20, 21, 22]);
    const ALICE_WRAP = new Uint8Array([30, 31]);

    beforeEach(() => {
      mockCreateFirstEpoch.mockReset();
      mockCreateOrGetConversation.mockReset();
      mockSaveUserOnlyMessage.mockReset();
      mockAssignSequenceNumbers.mockReset();
      mockFetchEpochPublicKey.mockReset();
      mockInsertEnvelopeTextMessage.mockReset();

      mockCreateFirstEpoch.mockReturnValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        confirmationHash: CONFIRMATION_HASH,
        memberWraps: [{ wrap: ALICE_WRAP }],
      });

      mockAssignSequenceNumbers.mockResolvedValue({ sequences: [1], currentEpoch: 1 });
      mockFetchEpochPublicKey.mockResolvedValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        epochNumber: 1,
      });
      mockInsertEnvelopeTextMessage.mockClear();
    });

    it('looks up user by email and calls createOrGetConversation', async () => {
      const mockDb = createMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
      ]);

      mockCreateOrGetConversation.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });

      const result = await createDevConversation(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      expect(result.conversationId).toBe('conv-123');
      expect(mockCreateFirstEpoch).toHaveBeenCalledWith([ALICE_PUBLIC_KEY]);
      expect(mockCreateOrGetConversation).toHaveBeenCalledWith(
        mockDb,
        'alice-id',
        expect.objectContaining({
          epochPublicKey: EPOCH_PUBLIC_KEY,
          confirmationHash: CONFIRMATION_HASH,
          memberWrap: ALICE_WRAP,
          userPublicKey: ALICE_PUBLIC_KEY,
        })
      );
    });

    it('throws when user not found', async () => {
      const mockDb = createMockDb([]);

      await expect(
        createDevConversation(mockDb as never, {
          ownerEmail: 'nobody@test.hushbox.ai',
          seedAiModel: TEST_SEED_AI_MODEL,
        })
      ).rejects.toThrow('User not found: nobody@test.hushbox.ai');
    });

    it('seeds user messages via saveUserOnlyMessage', async () => {
      const mockDb = createMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
      ]);

      mockCreateOrGetConversation.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockSaveUserOnlyMessage.mockResolvedValue({ sequenceNumber: 1, epochNumber: 1 });

      await createDevConversation(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        seedAiModel: TEST_SEED_AI_MODEL,
        messages: [
          { content: 'Hello', senderType: 'user' },
          { content: 'Echo: Hello', senderType: 'ai' },
        ],
      });

      expect(mockSaveUserOnlyMessage).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          conversationId: 'conv-123',
          senderId: 'alice-id',
          content: 'Hello',
        })
      );
    });

    it('returns conversationId without messages when none provided', async () => {
      const mockDb = createMockDb([
        {
          id: 'alice-id',
          username: 'alice',
          email: 'alice@test.hushbox.ai',
          publicKey: ALICE_PUBLIC_KEY,
        },
      ]);

      mockCreateOrGetConversation.mockResolvedValue({
        conversation: { id: 'conv-456' },
        isNew: true,
      });

      const result = await createDevConversation(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        seedAiModel: TEST_SEED_AI_MODEL,
      });

      expect(result.conversationId).toBe('conv-456');
      expect(mockSaveUserOnlyMessage).not.toHaveBeenCalled();
    });
  });

  describe('createDevMultiModelConversation', () => {
    const ALICE_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);
    const EPOCH_PUBLIC_KEY = new Uint8Array([10, 11, 12, 13]);
    const CONFIRMATION_HASH = new Uint8Array([20, 21, 22]);
    const ALICE_WRAP = new Uint8Array([30, 31]);

    beforeEach(() => {
      mockCreateFirstEpoch.mockReset();
      mockCreateOrGetConversation.mockReset();
      mockAssignSequenceNumbers.mockReset();
      mockFetchEpochPublicKey.mockReset();
      mockInsertEnvelopeTextMessage.mockReset();

      mockCreateFirstEpoch.mockReturnValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        confirmationHash: CONFIRMATION_HASH,
        memberWraps: [{ wrap: ALICE_WRAP }],
      });
      // One user + two AI siblings → three sequence numbers in a single call.
      mockAssignSequenceNumbers.mockResolvedValue({ sequences: [1, 2, 3], currentEpoch: 1 });
      mockFetchEpochPublicKey.mockResolvedValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        epochNumber: 1,
      });
    });

    const ALICE_ROW = {
      id: 'alice-id',
      username: 'alice',
      email: 'alice@test.hushbox.ai',
      publicKey: ALICE_PUBLIC_KEY,
    };

    it('throws when user not found', async () => {
      const mockDb = createMockDb([]);

      await expect(
        createDevMultiModelConversation(mockDb as never, {
          ownerEmail: 'nobody@test.hushbox.ai',
          userContent: 'Compare these',
          aiResponses: [
            { content: 'A', modelName: 'p/a', cost: '0.00200000' },
            { content: 'B', modelName: 'p/b', cost: '0.00300000' },
          ],
        })
      ).rejects.toThrow('User not found: nobody@test.hushbox.ai');
    });

    it('seeds one user message then sibling AI messages sharing parent and batchId', async () => {
      const mockDb = createMockDb([ALICE_ROW]);
      mockCreateOrGetConversation.mockResolvedValue({
        conversation: { id: 'conv-mm' },
        isNew: true,
      });

      const result = await createDevMultiModelConversation(mockDb as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        userContent: 'Compare these',
        aiResponses: [
          { content: 'Echo A', modelName: 'p/a', cost: '0.00200000' },
          { content: 'Echo B', modelName: 'p/b', cost: '0.00300000' },
        ],
      });

      expect(result.conversationId).toBe('conv-mm');
      expect(mockInsertEnvelopeTextMessage).toHaveBeenCalledTimes(3);

      const userCall = mockInsertEnvelopeTextMessage.mock.calls[0]![1] as Record<string, unknown>;
      const ai1Call = mockInsertEnvelopeTextMessage.mock.calls[1]![1] as Record<string, unknown>;
      const ai2Call = mockInsertEnvelopeTextMessage.mock.calls[2]![1] as Record<string, unknown>;

      // User message: root of the turn, no parent, sequence 1.
      expect(userCall['senderType']).toBe('user');
      expect(userCall['senderId']).toBe('alice-id');
      expect(userCall['parentMessageId']).toBeNull();
      expect(userCall['sequenceNumber']).toBe(1);
      expect(userCall['textContent']).toBe('Compare these');

      // Both AI siblings hang off the user message id and share one batch id —
      // the exact shape saveChatTurn writes, so the fork-filter renders them
      // as multi-model peers rather than splitting them across fork branches.
      const userMessageId = userCall['id'];
      expect(typeof userMessageId).toBe('string');
      expect(ai1Call['parentMessageId']).toBe(userMessageId);
      expect(ai2Call['parentMessageId']).toBe(userMessageId);

      const sharedBatchId = userCall['batchId'];
      expect(typeof sharedBatchId).toBe('string');
      expect(ai1Call['batchId']).toBe(sharedBatchId);
      expect(ai2Call['batchId']).toBe(sharedBatchId);

      // Distinct models + non-null costs drive distinct nametags and rendered
      // cost badges.
      expect(ai1Call['senderType']).toBe('ai');
      expect(ai1Call['sequenceNumber']).toBe(2);
      expect(ai1Call['modelName']).toBe('p/a');
      expect(ai1Call['cost']).toBe('0.00200000');

      expect(ai2Call['senderType']).toBe('ai');
      expect(ai2Call['sequenceNumber']).toBe(3);
      expect(ai2Call['modelName']).toBe('p/b');
      expect(ai2Call['cost']).toBe('0.00300000');

      expect(ai1Call['modelName']).not.toBe(ai2Call['modelName']);
    });
  });

  describe('createDevMediaConversation', () => {
    const ALICE_PUBLIC_KEY = new Uint8Array([1, 2, 3, 4]);
    const EPOCH_PUBLIC_KEY = new Uint8Array([10, 11, 12, 13]);
    const CONFIRMATION_HASH = new Uint8Array([20, 21, 22]);
    const ALICE_WRAP = new Uint8Array([30, 31]);
    const CONTENT_KEY = new Uint8Array([40, 41]);
    const WRAPPED_CONTENT_KEY = new Uint8Array([50, 51]);
    const CIPHERTEXT = new Uint8Array([60, 61, 62, 63, 64]);

    const ALICE_ROW = {
      id: 'alice-id',
      username: 'alice',
      email: 'alice@test.hushbox.ai',
      publicKey: ALICE_PUBLIC_KEY,
    };

    beforeEach(() => {
      mockCreateFirstEpoch.mockReset();
      mockCreateOrGetConversation.mockReset();
      mockAssignSequenceNumbers.mockReset();
      mockFetchEpochPublicKey.mockReset();
      mockInsertEnvelopeTextMessage.mockReset();
      mockInsertEnvelopeMediaMessage.mockReset();
      mockBeginMessageEnvelope.mockReset();
      mockEncryptBinaryWithContentKey.mockReset();

      mockCreateFirstEpoch.mockReturnValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        confirmationHash: CONFIRMATION_HASH,
        memberWraps: [{ wrap: ALICE_WRAP }],
      });
      // One user prompt + one AI media reply → two sequence numbers.
      mockAssignSequenceNumbers.mockResolvedValue({ sequences: [1, 2], currentEpoch: 1 });
      mockFetchEpochPublicKey.mockResolvedValue({
        epochPublicKey: EPOCH_PUBLIC_KEY,
        epochNumber: 1,
      });
      mockBeginMessageEnvelope.mockReturnValue({
        contentKey: CONTENT_KEY,
        wrappedContentKey: WRAPPED_CONTENT_KEY,
      });
      mockEncryptBinaryWithContentKey.mockReturnValue(CIPHERTEXT);
    });

    function createMediaStorageMock(): { put: ReturnType<typeof vi.fn> } {
      return { put: vi.fn(() => Promise.resolve()) };
    }

    it('throws when user not found', async () => {
      const mockDb = createMockDb([]);

      await expect(
        createDevMediaConversation(mockDb as never, createMediaStorageMock() as never, {
          ownerEmail: 'nobody@test.hushbox.ai',
          userContent: 'Draw a cat',
          mediaType: 'image',
          modelName: 'p/img',
          cost: '0.01000000',
        })
      ).rejects.toThrow('User not found: nobody@test.hushbox.ai');
    });

    it('seeds a user prompt then an AI image message, storing the encrypted bytes under the message key', async () => {
      const mockDb = createMockDb([ALICE_ROW]);
      mockCreateOrGetConversation.mockResolvedValue({
        conversation: { id: 'conv-img' },
        isNew: true,
      });
      const mediaStorage = createMediaStorageMock();

      const result = await createDevMediaConversation(mockDb as never, mediaStorage as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        userContent: 'Draw a cat',
        mediaType: 'image',
        modelName: 'p/img',
        cost: '0.01000000',
      });

      expect(result.conversationId).toBe('conv-img');
      expect(typeof result.assistantMessageId).toBe('string');

      // The same content key wraps the DB envelope and encrypts the stored
      // bytes, so the client unwraps it once and decrypts the download.
      expect(mockBeginMessageEnvelope).toHaveBeenCalledWith(EPOCH_PUBLIC_KEY);
      expect(mockEncryptBinaryWithContentKey).toHaveBeenCalledWith(
        CONTENT_KEY,
        expect.any(Uint8Array)
      );

      // Ciphertext lands in storage under media/<conv>/<assistantMsg>/<item>.enc.
      expect(mediaStorage.put).toHaveBeenCalledTimes(1);
      const putCall = mediaStorage.put.mock.calls[0] as [string, Uint8Array, string];
      const [storageKey, storedBytes, contentType] = putCall;
      expect(storageKey).toMatch(
        new RegExp(String.raw`^media/conv-img/${result.assistantMessageId}/[0-9a-f-]+\.enc$`)
      );
      expect(storedBytes).toBe(CIPHERTEXT);
      expect(contentType).toBe('application/octet-stream');

      // User prompt persisted as the turn root.
      expect(mockInsertEnvelopeTextMessage).toHaveBeenCalledTimes(1);
      const userCall = mockInsertEnvelopeTextMessage.mock.calls[0]![1] as Record<string, unknown>;
      expect(userCall['senderType']).toBe('user');
      expect(userCall['senderId']).toBe('alice-id');
      expect(userCall['parentMessageId']).toBeNull();
      expect(userCall['sequenceNumber']).toBe(1);
      expect(userCall['textContent']).toBe('Draw a cat');

      // AI media message hangs off the user prompt; its single content item
      // points at the stored object with the encrypted byte length + image dims.
      expect(mockInsertEnvelopeMediaMessage).toHaveBeenCalledTimes(1);
      const mediaCall = mockInsertEnvelopeMediaMessage.mock.calls[0]![1] as Record<string, unknown>;
      expect(mediaCall['id']).toBe(result.assistantMessageId);
      expect(mediaCall['senderType']).toBe('ai');
      expect(mediaCall['sequenceNumber']).toBe(2);
      expect(mediaCall['parentMessageId']).toBe(userCall['id']);
      expect(mediaCall['wrappedContentKey']).toBe(WRAPPED_CONTENT_KEY);
      expect(mediaCall['epochNumber']).toBe(1);

      const items = mediaCall['mediaItems'] as Record<string, unknown>[];
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item['contentType']).toBe('image');
      expect(item['storageKey']).toBe(storageKey);
      expect(item['mimeType']).toBe('image/jpeg');
      expect(item['sizeBytes']).toBe(CIPHERTEXT.byteLength);
      expect(item['modelName']).toBe('p/img');
      expect(item['cost']).toBe('0.01000000');
      expect(item['isSmartModel']).toBe(false);
      expect(item['position']).toBe(0);
      expect(item['width']).toBeGreaterThan(0);
      expect(item['height']).toBeGreaterThan(0);
    });

    it('seeds a video message with duration metadata and the webm mime type', async () => {
      const mockDb = createMockDb([ALICE_ROW]);
      mockCreateOrGetConversation.mockResolvedValue({
        conversation: { id: 'conv-vid' },
        isNew: true,
      });
      const mediaStorage = createMediaStorageMock();

      await createDevMediaConversation(mockDb as never, mediaStorage as never, {
        ownerEmail: 'alice@test.hushbox.ai',
        userContent: 'Animate a cat',
        mediaType: 'video',
        modelName: 'p/vid',
        cost: '0.02000000',
      });

      const mediaCall = mockInsertEnvelopeMediaMessage.mock.calls[0]![1] as Record<string, unknown>;
      const item = (mediaCall['mediaItems'] as Record<string, unknown>[])[0]!;
      expect(item['contentType']).toBe('video');
      expect(item['mimeType']).toBe('video/webm');
      expect(item['durationMs']).toBeGreaterThan(0);
    });
  });
});
