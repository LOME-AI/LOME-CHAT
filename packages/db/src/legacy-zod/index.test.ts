import { describe, expect, it } from 'vitest';

import {
  insertContentItemSchema,
  insertConversationMemberSchema,
  insertConversationSchema,
  insertConversationSpendingSchema,
  insertEpochMemberSchema,
  insertEpochSchema,
  insertLedgerEntrySchema,
  insertLlmCompletionSchema,
  insertMediaGenerationSchema,
  insertMemberBudgetSchema,
  insertMessageSchema,
  insertPaymentSchema,
  insertProjectSchema,
  insertServiceEvidenceSchema,
  insertSharedLinkSchema,
  insertSharedMessageSchema,
  insertUsageRecordSchema,
  insertUserSchema,
  insertWalletSchema,
  selectContentItemSchema,
  selectConversationMemberSchema,
  selectConversationSchema,
  selectConversationSpendingSchema,
  selectEpochMemberSchema,
  selectEpochSchema,
  selectLedgerEntrySchema,
  selectLlmCompletionSchema,
  selectMediaGenerationSchema,
  selectMemberBudgetSchema,
  selectMessageSchema,
  selectPaymentSchema,
  selectProjectSchema,
  selectServiceEvidenceSchema,
  selectSharedLinkSchema,
  selectSharedMessageSchema,
  selectUsageRecordSchema,
  selectUserSchema,
  selectWalletSchema,
} from './index';

describe('insertUserSchema', () => {
  it('accepts valid user data', () => {
    const result = insertUserSchema.safeParse({
      email: 'test@example.com',
      username: 'test_user',
    });
    expect(result.success).toBe(true);
  });

  it('accepts missing email (nullable column)', () => {
    const result = insertUserSchema.safeParse({
      username: 'test_user',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing username', () => {
    const result = insertUserSchema.safeParse({
      email: 'test@example.com',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectUserSchema', () => {
  it('accepts complete user data', () => {
    const result = selectUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      username: 'test_user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerifyToken: null,
      emailVerifyExpires: null,
      opaqueRegistration: new Uint8Array([1, 2, 3]),
      totpSecretEncrypted: null,
      totpEnabled: false,
      hasAcknowledgedPhrase: false,
      publicKey: new Uint8Array([10, 11, 12]),
      passwordWrappedPrivateKey: new Uint8Array([13, 14, 15]),
      recoveryWrappedPrivateKey: new Uint8Array([16, 17, 18]),
      accessibilityPreferences: { version: 1 },
      accessibilityPreferencesUpdatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts null email', () => {
    const result = selectUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: null,
      username: 'test_user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerifyToken: null,
      emailVerifyExpires: null,
      opaqueRegistration: new Uint8Array([1, 2, 3]),
      totpSecretEncrypted: null,
      totpEnabled: false,
      hasAcknowledgedPhrase: false,
      publicKey: new Uint8Array([10, 11, 12]),
      passwordWrappedPrivateKey: new Uint8Array([13, 14, 15]),
      recoveryWrappedPrivateKey: new Uint8Array([16, 17, 18]),
      accessibilityPreferences: { version: 1 },
      accessibilityPreferencesUpdatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    const result = selectUserSchema.safeParse({
      email: 'test@example.com',
      username: 'test_user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects null opaqueRegistration', () => {
    const result = selectUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      username: 'test_user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerifyToken: null,
      emailVerifyExpires: null,
      opaqueRegistration: null,
      totpSecretEncrypted: null,
      totpEnabled: false,
      hasAcknowledgedPhrase: false,
      publicKey: new Uint8Array([10, 11, 12]),
      passwordWrappedPrivateKey: new Uint8Array([13, 14, 15]),
      recoveryWrappedPrivateKey: new Uint8Array([16, 17, 18]),
    });
    expect(result.success).toBe(false);
  });

  it('rejects null publicKey', () => {
    const result = selectUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      username: 'test_user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerifyToken: null,
      emailVerifyExpires: null,
      opaqueRegistration: new Uint8Array([1, 2, 3]),
      totpSecretEncrypted: null,
      totpEnabled: false,
      hasAcknowledgedPhrase: false,
      publicKey: null,
      passwordWrappedPrivateKey: new Uint8Array([13, 14, 15]),
      recoveryWrappedPrivateKey: new Uint8Array([16, 17, 18]),
    });
    expect(result.success).toBe(false);
  });

  it('rejects null passwordWrappedPrivateKey', () => {
    const result = selectUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      username: 'test_user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerifyToken: null,
      emailVerifyExpires: null,
      opaqueRegistration: new Uint8Array([1, 2, 3]),
      totpSecretEncrypted: null,
      totpEnabled: false,
      hasAcknowledgedPhrase: false,
      publicKey: new Uint8Array([10, 11, 12]),
      passwordWrappedPrivateKey: null,
      recoveryWrappedPrivateKey: new Uint8Array([16, 17, 18]),
    });
    expect(result.success).toBe(false);
  });

  it('rejects null recoveryWrappedPrivateKey', () => {
    const result = selectUserSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'test@example.com',
      username: 'test_user',
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      emailVerifyToken: null,
      emailVerifyExpires: null,
      opaqueRegistration: new Uint8Array([1, 2, 3]),
      totpSecretEncrypted: null,
      totpEnabled: false,
      hasAcknowledgedPhrase: false,
      publicKey: new Uint8Array([10, 11, 12]),
      passwordWrappedPrivateKey: new Uint8Array([13, 14, 15]),
      recoveryWrappedPrivateKey: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('insertConversationSchema', () => {
  it('accepts valid conversation data with encrypted title', () => {
    const result = insertConversationSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      title: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing userId', () => {
    const result = insertConversationSchema.safeParse({
      title: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing title', () => {
    const result = insertConversationSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectConversationSchema', () => {
  it('accepts complete conversation data', () => {
    const result = selectConversationSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      title: new Uint8Array([1, 2, 3]),
      projectId: null,
      titleEpochNumber: 1,
      currentEpoch: 1,
      nextSequence: 1,
      conversationBudget: '0.00',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertMessageSchema', () => {
  it('accepts valid message data with wrapped content key', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      wrappedContentKey: new Uint8Array([1, 2, 3]),
      senderType: 'user',
      epochNumber: 1,
      sequenceNumber: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts message with optional senderId', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      wrappedContentKey: new Uint8Array([1, 2, 3]),
      senderType: 'ai',
      epochNumber: 1,
      sequenceNumber: 2,
      senderId: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing wrappedContentKey', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      senderType: 'user',
      epochNumber: 1,
      sequenceNumber: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing senderType', () => {
    const result = insertMessageSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      wrappedContentKey: new Uint8Array([1, 2, 3]),
      epochNumber: 1,
      sequenceNumber: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('selectMessageSchema', () => {
  it('accepts complete message data', () => {
    const result = selectMessageSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440001',
      wrappedContentKey: new Uint8Array([1, 2, 3]),
      senderType: 'user',
      senderId: '550e8400-e29b-41d4-a716-446655440002',
      epochNumber: 1,
      sequenceNumber: 1,
      parentMessageId: null,
      batchId: '550e8400-e29b-41d4-a716-446655440099',
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts AI message data', () => {
    const result = selectMessageSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440001',
      wrappedContentKey: new Uint8Array([1, 2, 3]),
      senderType: 'ai',
      senderId: null,
      epochNumber: 1,
      sequenceNumber: 2,
      parentMessageId: null,
      batchId: '550e8400-e29b-41d4-a716-446655440099',
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertProjectSchema', () => {
  it('accepts valid project data', () => {
    const result = insertProjectSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      encryptedName: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(true);
  });

  it('accepts project with optional encrypted description', () => {
    const result = insertProjectSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      encryptedName: new Uint8Array([1, 2, 3]),
      encryptedDescription: new Uint8Array([4, 5, 6]),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing encryptedName', () => {
    const result = insertProjectSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectProjectSchema', () => {
  it('accepts complete project data', () => {
    const result = selectProjectSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      encryptedName: new Uint8Array([1, 2, 3]),
      encryptedDescription: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertPaymentSchema', () => {
  it('accepts valid payment data', () => {
    const result = insertPaymentSchema.safeParse({
      amount: '10.00000000',
    });
    expect(result.success).toBe(true);
  });

  it('accepts payment with optional userId', () => {
    const result = insertPaymentSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      amount: '25.50000000',
      idempotencyKey: 'key-123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing amount', () => {
    const result = insertPaymentSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectPaymentSchema', () => {
  it('accepts complete payment data', () => {
    const result = selectPaymentSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      amount: '10.00000000',
      status: 'completed',
      idempotencyKey: 'key-123',
      helcimTransactionId: 'txn-456',
      cardType: 'visa',
      cardLastFour: '4242',
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      webhookReceivedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts payment with null userId', () => {
    const result = selectPaymentSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: null,
      amount: '10.00000000',
      status: 'pending',
      idempotencyKey: null,
      helcimTransactionId: null,
      cardType: null,
      cardLastFour: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      webhookReceivedAt: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('insertServiceEvidenceSchema', () => {
  it('accepts valid service evidence data', () => {
    const result = insertServiceEvidenceSchema.safeParse({
      service: 'ai-gateway',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing service', () => {
    const result = insertServiceEvidenceSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('selectServiceEvidenceSchema', () => {
  it('accepts complete service evidence data', () => {
    const result = selectServiceEvidenceSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      service: 'ai-gateway',
      details: { key: 'value' },
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertWalletSchema', () => {
  it('accepts valid wallet data', () => {
    const result = insertWalletSchema.safeParse({
      type: 'credit',
      priority: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts wallet with userId', () => {
    const result = insertWalletSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440000',
      type: 'promotional',
      priority: 2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing type', () => {
    const result = insertWalletSchema.safeParse({
      priority: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing priority', () => {
    const result = insertWalletSchema.safeParse({
      type: 'credit',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectWalletSchema', () => {
  it('accepts complete wallet data', () => {
    const result = selectWalletSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      type: 'credit',
      balance: '100.00000000',
      priority: 1,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts wallet with null userId', () => {
    const result = selectWalletSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: null,
      type: 'promotional',
      balance: '0',
      priority: 2,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertUsageRecordSchema', () => {
  it('accepts valid usage record data', () => {
    const result = insertUsageRecordSchema.safeParse({
      type: 'llm',
      cost: '0.00150000',
      sourceType: 'message',
      sourceId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing cost', () => {
    const result = insertUsageRecordSchema.safeParse({
      type: 'llm',
      sourceType: 'message',
      sourceId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing sourceType', () => {
    const result = insertUsageRecordSchema.safeParse({
      type: 'llm',
      cost: '0.00150000',
      sourceId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectUsageRecordSchema', () => {
  it('accepts complete usage record data', () => {
    const result = selectUsageRecordSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      type: 'llm',
      status: 'completed',
      cost: '0.00150000',
      isEstimated: false,
      sourceType: 'message',
      sourceId: '550e8400-e29b-41d4-a716-446655440002',
      createdAt: new Date(),
      completedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts usage record with null userId', () => {
    const result = selectUsageRecordSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      userId: null,
      type: 'storage',
      status: 'pending',
      cost: '0.00000300',
      isEstimated: false,
      sourceType: 'message',
      sourceId: '550e8400-e29b-41d4-a716-446655440002',
      createdAt: new Date(),
      completedAt: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('insertLlmCompletionSchema', () => {
  it('accepts valid llm completion data', () => {
    const result = insertLlmCompletionSchema.safeParse({
      usageRecordId: '550e8400-e29b-41d4-a716-446655440000',
      model: 'gpt-4',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing model', () => {
    const result = insertLlmCompletionSchema.safeParse({
      usageRecordId: '550e8400-e29b-41d4-a716-446655440000',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing inputTokens', () => {
    const result = insertLlmCompletionSchema.safeParse({
      usageRecordId: '550e8400-e29b-41d4-a716-446655440000',
      model: 'gpt-4',
      provider: 'openai',
      outputTokens: 50,
    });
    expect(result.success).toBe(false);
  });
});

describe('selectLlmCompletionSchema', () => {
  it('accepts complete llm completion data', () => {
    const result = selectLlmCompletionSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      usageRecordId: '550e8400-e29b-41d4-a716-446655440001',
      model: 'gpt-4',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
    });
    expect(result.success).toBe(true);
  });
});

describe('insertLedgerEntrySchema', () => {
  it('accepts valid ledger entry data', () => {
    const result = insertLedgerEntrySchema.safeParse({
      walletId: '550e8400-e29b-41d4-a716-446655440000',
      amount: '10.00000000',
      balanceAfter: '110.00000000',
      entryType: 'credit',
    });
    expect(result.success).toBe(true);
  });

  it('accepts ledger entry with optional references', () => {
    const result = insertLedgerEntrySchema.safeParse({
      walletId: '550e8400-e29b-41d4-a716-446655440000',
      amount: '-0.00150000',
      balanceAfter: '99.99850000',
      entryType: 'usage',
      paymentId: '550e8400-e29b-41d4-a716-446655440001',
      usageRecordId: '550e8400-e29b-41d4-a716-446655440002',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing walletId', () => {
    const result = insertLedgerEntrySchema.safeParse({
      amount: '10.00000000',
      balanceAfter: '110.00000000',
      entryType: 'credit',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing entryType', () => {
    const result = insertLedgerEntrySchema.safeParse({
      walletId: '550e8400-e29b-41d4-a716-446655440000',
      amount: '10.00000000',
      balanceAfter: '110.00000000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectLedgerEntrySchema', () => {
  it('accepts complete ledger entry data', () => {
    const result = selectLedgerEntrySchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      walletId: '550e8400-e29b-41d4-a716-446655440001',
      amount: '10.00000000',
      balanceAfter: '110.00000000',
      entryType: 'credit',
      paymentId: null,
      usageRecordId: null,
      sourceWalletId: null,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertSharedLinkSchema', () => {
  it('accepts valid shared link data', () => {
    const result = insertSharedLinkSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      linkPublicKey: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing linkPublicKey', () => {
    const result = insertSharedLinkSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectSharedLinkSchema', () => {
  it('accepts complete shared link data', () => {
    const result = selectSharedLinkSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440001',
      linkPublicKey: new Uint8Array([1, 2, 3]),
      privilege: 'read',
      displayName: null,
      revokedAt: null,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertConversationMemberSchema', () => {
  it('accepts valid member data with userId', () => {
    const result = insertConversationMemberSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
      visibleFromEpoch: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid member data with linkId', () => {
    const result = insertConversationMemberSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      linkId: '550e8400-e29b-41d4-a716-446655440002',
      visibleFromEpoch: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing conversationId', () => {
    const result = insertConversationMemberSchema.safeParse({
      userId: '550e8400-e29b-41d4-a716-446655440001',
      visibleFromEpoch: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing visibleFromEpoch', () => {
    const result = insertConversationMemberSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      userId: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectConversationMemberSchema', () => {
  it('accepts complete conversation member data', () => {
    const result = selectConversationMemberSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440001',
      userId: '550e8400-e29b-41d4-a716-446655440002',
      linkId: null,
      privilege: 'write',
      visibleFromEpoch: 1,
      joinedAt: new Date(),
      leftAt: null,
      acceptedAt: null,
      muted: false,
      pinned: false,
      invitedByUserId: null,
    });
    expect(result.success).toBe(true);
  });
});

describe('insertEpochSchema', () => {
  it('accepts valid epoch data', () => {
    const result = insertEpochSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      epochNumber: 1,
      epochPublicKey: new Uint8Array([1, 2, 3]),
      confirmationHash: new Uint8Array([4, 5, 6]),
    });
    expect(result.success).toBe(true);
  });

  it('accepts epoch with optional chainLink', () => {
    const result = insertEpochSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      epochNumber: 2,
      epochPublicKey: new Uint8Array([1, 2, 3]),
      confirmationHash: new Uint8Array([4, 5, 6]),
      chainLink: new Uint8Array([7, 8, 9]),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing epochPublicKey', () => {
    const result = insertEpochSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      epochNumber: 1,
      confirmationHash: new Uint8Array([4, 5, 6]),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing confirmationHash', () => {
    const result = insertEpochSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
      epochNumber: 1,
      epochPublicKey: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(false);
  });
});

describe('selectEpochSchema', () => {
  it('accepts complete epoch data', () => {
    const result = selectEpochSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440001',
      epochNumber: 1,
      epochPublicKey: new Uint8Array([1, 2, 3]),
      confirmationHash: new Uint8Array([4, 5, 6]),
      chainLink: null,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertEpochMemberSchema', () => {
  it('accepts valid epoch member data', () => {
    const result = insertEpochMemberSchema.safeParse({
      epochId: '550e8400-e29b-41d4-a716-446655440000',
      memberPublicKey: new Uint8Array([1, 2, 3]),
      wrap: new Uint8Array([4, 5, 6]),
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing wrap', () => {
    const result = insertEpochMemberSchema.safeParse({
      epochId: '550e8400-e29b-41d4-a716-446655440000',
      memberPublicKey: new Uint8Array([1, 2, 3]),
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing memberPublicKey', () => {
    const result = insertEpochMemberSchema.safeParse({
      epochId: '550e8400-e29b-41d4-a716-446655440000',
      wrap: new Uint8Array([4, 5, 6]),
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe('selectEpochMemberSchema', () => {
  it('accepts complete epoch member data', () => {
    const result = selectEpochMemberSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      epochId: '550e8400-e29b-41d4-a716-446655440001',
      memberPublicKey: new Uint8Array([1, 2, 3]),
      wrap: new Uint8Array([4, 5, 6]),
      privilege: 'write',
      visibleFromEpoch: 1,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertSharedMessageSchema', () => {
  it('accepts valid shared message data', () => {
    const result = insertSharedMessageSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      wrappedContentKey: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing messageId', () => {
    const result = insertSharedMessageSchema.safeParse({
      wrappedContentKey: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing wrappedContentKey', () => {
    const result = insertSharedMessageSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectSharedMessageSchema', () => {
  it('accepts complete shared message data', () => {
    const result = selectSharedMessageSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      messageId: '550e8400-e29b-41d4-a716-446655440001',
      wrappedContentKey: new Uint8Array([1, 2, 3]),
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertMemberBudgetSchema', () => {
  it('accepts valid member budget data', () => {
    const result = insertMemberBudgetSchema.safeParse({
      memberId: '550e8400-e29b-41d4-a716-446655440000',
      budget: '50.00',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing memberId', () => {
    const result = insertMemberBudgetSchema.safeParse({
      budget: '50.00',
    });
    expect(result.success).toBe(false);
  });

  it('accepts missing budget (uses database default)', () => {
    const result = insertMemberBudgetSchema.safeParse({
      memberId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });
});

describe('selectMemberBudgetSchema', () => {
  it('accepts complete member budget data', () => {
    const result = selectMemberBudgetSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      memberId: '550e8400-e29b-41d4-a716-446655440001',
      budget: '50.00',
      spent: '10.00000000',
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertConversationSpendingSchema', () => {
  it('accepts valid conversation spending data', () => {
    const result = insertConversationSpendingSchema.safeParse({
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing conversationId', () => {
    const result = insertConversationSpendingSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('selectConversationSpendingSchema', () => {
  it('accepts complete conversation spending data', () => {
    const result = selectConversationSpendingSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      conversationId: '550e8400-e29b-41d4-a716-446655440001',
      totalSpent: '25.50000000',
      updatedAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertContentItemSchema', () => {
  it('accepts a text item with encryptedBlob and no media fields', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'text',
      position: 0,
      encryptedBlob: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a text item that also carries storageKey', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'text',
      position: 0,
      encryptedBlob: new Uint8Array([1, 2, 3]),
      storageKey: 'media/foo/bar.enc',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a text item missing encryptedBlob', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'text',
      position: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an image item with storageKey, mimeType, sizeBytes', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'image',
      position: 0,
      storageKey: 'media/conv/msg/item.enc',
      mimeType: 'image/png',
      sizeBytes: 12_345,
      modelName: 'imagen-4',
      cost: '0.046',
      isSmartModel: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a media item missing storageKey', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'image',
      position: 0,
      mimeType: 'image/png',
      sizeBytes: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a media item missing mimeType', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'audio',
      position: 0,
      storageKey: 'media/foo/bar.enc',
      sizeBytes: 100,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a media item missing sizeBytes', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'video',
      position: 0,
      storageKey: 'media/foo/bar.enc',
      mimeType: 'video/mp4',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a media item that also carries encryptedBlob', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'image',
      position: 0,
      storageKey: 'media/foo/bar.enc',
      mimeType: 'image/png',
      sizeBytes: 100,
      encryptedBlob: new Uint8Array([1, 2, 3]),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown contentType', () => {
    const result = insertContentItemSchema.safeParse({
      messageId: '550e8400-e29b-41d4-a716-446655440000',
      contentType: 'banana',
      position: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('selectContentItemSchema', () => {
  it('accepts a complete text content item', () => {
    const result = selectContentItemSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      messageId: '550e8400-e29b-41d4-a716-446655440001',
      contentType: 'text',
      position: 0,
      encryptedBlob: new Uint8Array([1, 2, 3]),
      storageKey: null,
      mimeType: null,
      sizeBytes: null,
      width: null,
      height: null,
      durationMs: null,
      modelName: null,
      cost: null,
      isSmartModel: false,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });

  it('accepts a complete image content item', () => {
    const result = selectContentItemSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      messageId: '550e8400-e29b-41d4-a716-446655440001',
      contentType: 'image',
      position: 0,
      encryptedBlob: null,
      storageKey: 'media/foo/bar.enc',
      mimeType: 'image/png',
      sizeBytes: 12_345,
      width: 1024,
      height: 1024,
      durationMs: null,
      modelName: 'imagen-4',
      cost: '0.04600000',
      isSmartModel: false,
      createdAt: new Date(),
    });
    expect(result.success).toBe(true);
  });
});

describe('insertMediaGenerationSchema', () => {
  it('accepts an image generation row', () => {
    const result = insertMediaGenerationSchema.safeParse({
      usageRecordId: '550e8400-e29b-41d4-a716-446655440000',
      model: 'imagen-4',
      provider: 'ai-gateway',
      mediaType: 'image',
      imageCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a video generation row with duration and resolution', () => {
    const result = insertMediaGenerationSchema.safeParse({
      usageRecordId: '550e8400-e29b-41d4-a716-446655440000',
      model: 'veo-3',
      provider: 'ai-gateway',
      mediaType: 'video',
      durationMs: 5000,
      resolution: '720p',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a row missing model', () => {
    const result = insertMediaGenerationSchema.safeParse({
      usageRecordId: '550e8400-e29b-41d4-a716-446655440000',
      provider: 'ai-gateway',
      mediaType: 'image',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a row missing mediaType', () => {
    const result = insertMediaGenerationSchema.safeParse({
      usageRecordId: '550e8400-e29b-41d4-a716-446655440000',
      model: 'imagen-4',
      provider: 'ai-gateway',
    });
    expect(result.success).toBe(false);
  });
});

describe('selectMediaGenerationSchema', () => {
  it('accepts a complete media generation row', () => {
    const result = selectMediaGenerationSchema.safeParse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      usageRecordId: '550e8400-e29b-41d4-a716-446655440001',
      model: 'imagen-4',
      provider: 'ai-gateway',
      mediaType: 'image',
      imageCount: 1,
      durationMs: null,
      resolution: null,
    });
    expect(result.success).toBe(true);
  });
});
