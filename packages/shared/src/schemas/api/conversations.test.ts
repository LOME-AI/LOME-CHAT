import { describe, it, expect } from 'vitest';
import {
  createConversationRequestSchema,
  updateConversationRequestSchema,
  rotationSchema,
  conversationResponseSchema,
  conversationListItemSchema,
  messageResponseSchema,
  listConversationsResponseSchema,
  getConversationResponseSchema,
  createConversationResponseSchema,
  updateConversationResponseSchema,
  deleteConversationResponseSchema,
  streamChatRequestSchema,
  forkResponseSchema,
  createForkRequestSchema,
  renameForkRequestSchema,
  regenerateRequestSchema,
  keyChainResponseSchema,
} from './conversations.js';

describe('deleted schemas', () => {
  it('createMessageRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('createMessageRequestSchema' in module_).toBe(false);
  });

  it('CreateMessageRequest type is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('CreateMessageRequest' in module_).toBe(false);
  });

  it('finalizeMessageRequestSchema is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('finalizeMessageRequestSchema' in module_).toBe(false);
  });

  it('FinalizeMessageRequest type is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('FinalizeMessageRequest' in module_).toBe(false);
  });

  it('createMessageResponseSchema is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('createMessageResponseSchema' in module_).toBe(false);
  });

  it('CreateMessageResponse type is not exported', async () => {
    const module_ = await import('./conversations.js');
    expect('CreateMessageResponse' in module_).toBe(false);
  });
});

describe('createConversationRequestSchema', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts valid request with all epoch fields', () => {
    const result = createConversationRequestSchema.parse({
      id: validId,
      title: 'base64encodedencryptedtitle',
      epochPublicKey: 'base64epochpubkey',
      confirmationHash: 'base64confirmhash',
      memberWrap: 'base64memberwrap',
    });
    expect(result.id).toBe(validId);
    expect(result.title).toBe('base64encodedencryptedtitle');
    expect(result.epochPublicKey).toBe('base64epochpubkey');
    expect(result.confirmationHash).toBe('base64confirmhash');
    expect(result.memberWrap).toBe('base64memberwrap');
  });

  it('accepts without title (optional)', () => {
    const result = createConversationRequestSchema.parse({
      id: validId,
      epochPublicKey: 'base64epochpubkey',
      confirmationHash: 'base64confirmhash',
      memberWrap: 'base64memberwrap',
    });
    expect(result.title).toBeUndefined();
  });

  it('requires id field', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('rejects invalid UUID', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: 'not-a-uuid',
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('requires epochPublicKey', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('rejects empty epochPublicKey', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: '',
        confirmationHash: 'base64confirmhash',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('requires confirmationHash', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('rejects empty confirmationHash', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: '',
        memberWrap: 'base64memberwrap',
      })
    ).toThrow();
  });

  it('requires memberWrap', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
      })
    ).toThrow();
  });

  it('rejects empty memberWrap', () => {
    expect(() =>
      createConversationRequestSchema.parse({
        id: validId,
        epochPublicKey: 'base64epochpubkey',
        confirmationHash: 'base64confirmhash',
        memberWrap: '',
      })
    ).toThrow();
  });
});

describe('updateConversationRequestSchema', () => {
  it('accepts valid encrypted title with titleEpochNumber', () => {
    const result = updateConversationRequestSchema.parse({
      title: 'base64encryptedtitle',
      titleEpochNumber: 3,
    });
    expect(result.title).toBe('base64encryptedtitle');
    expect(result.titleEpochNumber).toBe(3);
  });

  it('rejects empty title', () => {
    expect(() =>
      updateConversationRequestSchema.parse({ title: '', titleEpochNumber: 1 })
    ).toThrow();
  });

  it('rejects missing title', () => {
    expect(() => updateConversationRequestSchema.parse({ titleEpochNumber: 1 })).toThrow();
  });

  it('rejects missing titleEpochNumber', () => {
    expect(() => updateConversationRequestSchema.parse({ title: 'enc' })).toThrow();
  });

  it('rejects non-positive titleEpochNumber', () => {
    expect(() =>
      updateConversationRequestSchema.parse({ title: 'enc', titleEpochNumber: 0 })
    ).toThrow();
  });
});

describe('rotationSchema', () => {
  const validRotation = {
    expectedEpoch: 1,
    epochPublicKey: 'base64epochpubkey',
    confirmationHash: 'base64confirmhash',
    chainLink: 'base64chainlink',
    memberWraps: [
      {
        memberPublicKey: 'base64memberpubkey',
        wrap: 'base64wrap',
      },
    ],
    encryptedTitle: 'base64encryptedtitle',
  };

  it('accepts valid rotation with memberWraps containing only memberPublicKey and wrap', () => {
    const result = rotationSchema.parse(validRotation);
    expect(result.expectedEpoch).toBe(1);
    expect(result.memberWraps).toHaveLength(1);
    expect(result.memberWraps[0]!.memberPublicKey).toBe('base64memberpubkey');
    expect(result.memberWraps[0]!.wrap).toBe('base64wrap');
  });

  it('rejects empty memberWraps array', () => {
    expect(() => rotationSchema.parse({ ...validRotation, memberWraps: [] })).toThrow();
  });

  it('requires memberPublicKey in memberWraps', () => {
    expect(() =>
      rotationSchema.parse({
        ...validRotation,
        memberWraps: [{ wrap: 'base64wrap' }],
      })
    ).toThrow();
  });

  it('requires wrap in memberWraps', () => {
    expect(() =>
      rotationSchema.parse({
        ...validRotation,
        memberWraps: [{ memberPublicKey: 'base64memberpubkey' }],
      })
    ).toThrow();
  });

  it('strips visibleFromEpoch from memberWraps (no longer part of wire format)', () => {
    const result = rotationSchema.parse({
      ...validRotation,
      memberWraps: [
        {
          memberPublicKey: 'base64memberpubkey',
          wrap: 'base64wrap',
          visibleFromEpoch: 1,
        },
      ],
    });
    // Zod strips unknown keys — visibleFromEpoch should not be present
    expect('visibleFromEpoch' in result.memberWraps[0]!).toBe(false);
  });
});

describe('streamChatRequestSchema', () => {
  const validMsgId = '550e8400-e29b-41d4-a716-446655440001';

  it('accepts valid stream request with single model', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: {
        id: validMsgId,
        content: 'Hello, how are you?',
      },
      messagesForInference: [{ role: 'user', content: 'Hello, how are you?' }],
      fundingSource: 'personal_balance',
    });
    expect(result.models).toEqual(['gpt-4']);
    expect(result.userMessage.id).toBe(validMsgId);
    expect(result.userMessage.content).toBe('Hello, how are you?');
    expect(result.messagesForInference).toHaveLength(1);
  });

  it('accepts multiple models', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4', 'claude-3-sonnet', 'gemini-pro'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    expect(result.models).toEqual(['gpt-4', 'claude-3-sonnet', 'gemini-pro']);
  });

  it('rejects empty models array', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: [],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('rejects models array exceeding MAX_SELECTED_MODELS', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('accepts models array at exactly MAX_SELECTED_MODELS', () => {
    const result = streamChatRequestSchema.parse({
      models: ['m1', 'm2', 'm3', 'm4', 'm5'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    expect(result.models).toHaveLength(5);
  });

  it('requires at least one message for inference', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: {
          id: validMsgId,
          content: 'Hello',
        },
        messagesForInference: [],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('accepts multiple messages for inference', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: {
        id: validMsgId,
        content: 'How are you?',
      },
      messagesForInference: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How are you?' },
      ],
      fundingSource: 'personal_balance',
    });
    expect(result.messagesForInference).toHaveLength(3);
  });

  it('rejects missing models', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        userMessage: {
          id: validMsgId,
          content: 'Hello',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('rejects empty user message content', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: {
          id: validMsgId,
          content: '',
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('rejects missing user message content', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: {
          id: validMsgId,
        },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
      })
    ).toThrow();
  });

  it('accepts valid fundingSource values', () => {
    const validMsgId_ = '550e8400-e29b-41d4-a716-446655440001';
    const base = {
      models: ['gpt-4'],
      userMessage: { id: validMsgId_, content: 'Hello' },
      messagesForInference: [{ role: 'user' as const, content: 'Hello' }],
    };

    for (const source of ['owner_balance', 'personal_balance', 'free_allowance', 'trial_fixed']) {
      const result = streamChatRequestSchema.parse({ ...base, fundingSource: source });
      expect(result.fundingSource).toBe(source);
    }
  });

  it('rejects missing fundingSource (required)', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: { id: '550e8400-e29b-41d4-a716-446655440001', content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
      })
    ).toThrow();
  });

  it('rejects invalid fundingSource value', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: { id: '550e8400-e29b-41d4-a716-446655440001', content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'invalid_source',
      })
    ).toThrow();
  });

  it('accepts optional webSearchEnabled boolean', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      webSearchEnabled: true,
    });
    expect(result.webSearchEnabled).toBe(true);
  });

  it('allows omitting webSearchEnabled', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    expect(result.webSearchEnabled).toBeUndefined();
  });

  it('accepts optional customInstructions string', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      customInstructions: 'Always respond in bullet points',
    });
    expect(result.customInstructions).toBe('Always respond in bullet points');
  });

  it('allows omitting customInstructions', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    expect(result.customInstructions).toBeUndefined();
  });

  it('rejects customInstructions exceeding 5000 characters', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        customInstructions: 'x'.repeat(5001),
      })
    ).toThrow();
  });

  it('accepts customInstructions at exactly 5000 characters', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      customInstructions: 'x'.repeat(5000),
    });
    expect(result.customInstructions).toHaveLength(5000);
  });

  it('accepts optional forkId as valid UUID', () => {
    const forkUuid = '660e8400-e29b-41d4-a716-446655440099';
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      forkId: forkUuid,
    });
    expect(result.forkId).toBe(forkUuid);
  });

  it('allows omitting forkId', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    expect(result.forkId).toBeUndefined();
  });

  it('rejects invalid forkId (non-UUID string)', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        forkId: 'not-a-uuid',
      })
    ).toThrow();
  });

  it('does not accept contentEncrypted or iv on userMessage', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: {
        id: validMsgId,
        content: 'Hello',
        contentEncrypted: 'should-be-stripped',
        iv: 'should-be-stripped',
      },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    // Zod strips unknown keys by default
    expect('contentEncrypted' in result.userMessage).toBe(false);
    expect('iv' in result.userMessage).toBe(false);
  });

  it('defaults modality to text when omitted', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
    });
    expect(result.modality).toBe('text');
  });

  it('accepts modality text explicitly', () => {
    const result = streamChatRequestSchema.parse({
      models: ['gpt-4'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      modality: 'text',
    });
    expect(result.modality).toBe('text');
  });

  it('accepts modality image with imageConfig', () => {
    const result = streamChatRequestSchema.parse({
      models: ['google/imagen-4'],
      userMessage: { id: validMsgId, content: 'A cat wearing a hat' },
      messagesForInference: [{ role: 'user', content: 'A cat wearing a hat' }],
      fundingSource: 'personal_balance',
      modality: 'image',
      imageConfig: { aspectRatio: '16:9' },
    });
    expect(result.modality).toBe('image');
    expect(result.imageConfig?.aspectRatio).toBe('16:9');
  });

  it('defaults imageConfig aspectRatio to 1:1', () => {
    const result = streamChatRequestSchema.parse({
      models: ['google/imagen-4'],
      userMessage: { id: validMsgId, content: 'A sunset' },
      messagesForInference: [{ role: 'user', content: 'A sunset' }],
      fundingSource: 'personal_balance',
      modality: 'image',
      imageConfig: {},
    });
    expect(result.imageConfig?.aspectRatio).toBe('1:1');
  });

  it('accepts modality audio with full audioConfig', () => {
    const result = streamChatRequestSchema.parse({
      models: ['openai/tts-1'],
      userMessage: { id: validMsgId, content: 'Hello, world.' },
      messagesForInference: [{ role: 'user', content: 'Hello, world.' }],
      fundingSource: 'personal_balance',
      modality: 'audio',
      audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
    });
    expect(result.modality).toBe('audio');
    expect(result.audioConfig?.format).toBe('mp3');
    expect(result.audioConfig?.maxDurationSeconds).toBe(60);
  });

  it('defaults audioConfig.format to mp3 and maxDurationSeconds to MAX_AUDIO_DURATION_SECONDS', () => {
    const result = streamChatRequestSchema.parse({
      models: ['openai/tts-1'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      modality: 'audio',
      audioConfig: {},
    });
    expect(result.audioConfig?.format).toBe('mp3');
    expect(result.audioConfig?.maxDurationSeconds).toBe(600);
  });

  it('rejects modality audio without audioConfig', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['openai/tts-1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'audio',
      })
    ).toThrow();
  });

  it('rejects audioConfig with invalid format', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['openai/tts-1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'audio',
        audioConfig: { format: 'flac' },
      })
    ).toThrow();
  });

  it('rejects audioConfig with maxDurationSeconds below 1', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['openai/tts-1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 0 },
      })
    ).toThrow();
  });

  it('rejects audioConfig with maxDurationSeconds above 600', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['openai/tts-1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 601 },
      })
    ).toThrow();
  });

  it('rejects audioConfig with non-integer maxDurationSeconds', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['openai/tts-1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 30.5 },
      })
    ).toThrow();
  });

  it('rejects an unknown modality', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['gpt-4'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'holographic',
      })
    ).toThrow();
  });

  it('rejects invalid aspectRatio in imageConfig', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['google/imagen-4'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'image',
        imageConfig: { aspectRatio: '2:1' },
      })
    ).toThrow();
  });

  it('accepts modality video with full videoConfig', () => {
    const result = streamChatRequestSchema.parse({
      models: ['google/veo-3.1'],
      userMessage: { id: validMsgId, content: 'A flock of cranes taking flight' },
      messagesForInference: [{ role: 'user', content: 'A flock of cranes taking flight' }],
      fundingSource: 'personal_balance',
      modality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    });
    expect(result.modality).toBe('video');
    expect(result.videoConfig?.aspectRatio).toBe('16:9');
    expect(result.videoConfig?.durationSeconds).toBe(4);
    expect(result.videoConfig?.resolution).toBe('720p');
  });

  it('rejects modality video without videoConfig', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['google/veo-3.1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'video',
      })
    ).toThrow();
  });

  it('rejects videoConfig with invalid aspectRatio', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['google/veo-3.1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'video',
        videoConfig: { aspectRatio: '3:2', durationSeconds: 4, resolution: '720p' },
      })
    ).toThrow();
  });

  it('rejects videoConfig with out-of-range durationSeconds (0)', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['google/veo-3.1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 0, resolution: '720p' },
      })
    ).toThrow();
  });

  it('rejects videoConfig with out-of-range durationSeconds (9)', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['google/veo-3.1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 9, resolution: '720p' },
      })
    ).toThrow();
  });

  it('rejects videoConfig with invalid resolution', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['google/veo-3.1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '480p' },
      })
    ).toThrow();
  });

  it('rejects modality video with a non-integer durationSeconds', () => {
    expect(() =>
      streamChatRequestSchema.parse({
        models: ['google/veo-3.1'],
        userMessage: { id: validMsgId, content: 'Hello' },
        messagesForInference: [{ role: 'user', content: 'Hello' }],
        fundingSource: 'personal_balance',
        modality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4.5, resolution: '720p' },
      })
    ).toThrow();
  });

  it('accepts modality video at min duration boundary', () => {
    const result = streamChatRequestSchema.parse({
      models: ['google/veo-3.1'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      modality: 'video',
      videoConfig: { aspectRatio: '9:16', durationSeconds: 1, resolution: '1080p' },
    });
    expect(result.videoConfig?.durationSeconds).toBe(1);
  });

  it('accepts modality video at max duration boundary', () => {
    const result = streamChatRequestSchema.parse({
      models: ['google/veo-3.1'],
      userMessage: { id: validMsgId, content: 'Hello' },
      messagesForInference: [{ role: 'user', content: 'Hello' }],
      fundingSource: 'personal_balance',
      modality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 8, resolution: '1080p' },
    });
    expect(result.videoConfig?.durationSeconds).toBe(8);
  });
});

describe('conversationResponseSchema', () => {
  it('accepts valid conversation with epoch fields', () => {
    const result = conversationResponseSchema.parse({
      id: 'conv-123',
      title: 'base64encryptedtitle',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 3,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
    });
    expect(result.id).toBe('conv-123');
    expect(result.title).toBe('base64encryptedtitle');
    expect(result.currentEpoch).toBe(1);
    expect(result.titleEpochNumber).toBe(1);
    expect(result.nextSequence).toBe(3);
  });

  it('rejects missing currentEpoch', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        titleEpochNumber: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing titleEpochNumber', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing nextSequence', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        titleEpochNumber: 1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects zero currentEpoch', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 0,
        titleEpochNumber: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects negative nextSequence', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: -1,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects non-integer epoch values', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
        userId: 'user-456',
        title: 'base64encryptedtitle',
        currentEpoch: 1.5,
        titleEpochNumber: 1,
        nextSequence: 3,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      })
    ).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() =>
      conversationResponseSchema.parse({
        id: 'conv-123',
      })
    ).toThrow();
  });
});

// Helper: build a valid MessageResponse-shaped object with one text content
// item. Override any field for the specific test case.
function buildMessageResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const contentItemOverrides = overrides['contentItemOverrides'] as
    | Record<string, unknown>
    | undefined;
  const base: Record<string, unknown> = {
    id: 'msg-123',
    conversationId: 'conv-456',
    wrappedContentKey: 'base64wrappedkey',
    senderType: 'user',
    senderId: 'user-789',
    epochNumber: 1,
    sequenceNumber: 0,
    parentMessageId: null,
    batchId: 'batch-test-1',
    createdAt: '2024-01-01T00:00:00Z',
    contentItems: [
      {
        id: 'ci-1',
        contentType: 'text',
        position: 0,
        encryptedBlob: 'base64blob',
        storageKey: null,
        mimeType: null,
        sizeBytes: null,
        width: null,
        height: null,
        durationMs: null,
        modelName: null,
        cost: null,
        isSmartModel: false,
        ...contentItemOverrides,
      },
    ],
  };
  const rest = Object.fromEntries(
    Object.entries(overrides).filter(([key]) => key !== 'contentItemOverrides')
  );
  return { ...base, ...rest };
}

describe('messageResponseSchema', () => {
  it('accepts a valid wrap-once message with one text content item', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        contentItemOverrides: { modelName: 'Alice' },
      })
    );
    expect(result.id).toBe('msg-123');
    expect(result.wrappedContentKey).toBe('base64wrappedkey');
    expect(result.senderType).toBe('user');
    expect(result.senderId).toBe('user-789');
    expect(result.contentItems).toHaveLength(1);
    expect(result.contentItems[0]!.contentType).toBe('text');
    expect(result.contentItems[0]!.encryptedBlob).toBe('base64blob');
    expect(result.contentItems[0]!.modelName).toBe('Alice');
    expect(result.contentItems[0]!.cost).toBeNull();
    expect(result.epochNumber).toBe(1);
    expect(result.sequenceNumber).toBe(0);
    expect(result.parentMessageId).toBeNull();
  });

  it('accepts message with non-null parentMessageId', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        id: 'msg-124',
        senderType: 'ai',
        senderId: null,
        sequenceNumber: 1,
        parentMessageId: 'msg-123',
        contentItemOverrides: { cost: '0.00136000' },
      })
    );
    expect(result.parentMessageId).toBe('msg-123');
    expect(result.contentItems[0]!.cost).toBe('0.00136000');
  });

  it('accepts AI message with null senderId and AI-authored content item', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        id: 'msg-124',
        senderType: 'ai',
        senderId: null,
        sequenceNumber: 1,
        contentItemOverrides: {
          modelName: 'anthropic/claude-sonnet-4.6',
          cost: '0.00136000',
        },
      })
    );
    expect(result.senderType).toBe('ai');
    expect(result.senderId).toBeNull();
    expect(result.contentItems[0]!.modelName).toBe('anthropic/claude-sonnet-4.6');
    expect(result.contentItems[0]!.cost).toBe('0.00136000');
  });

  it('accepts a user message whose content item has null cost', () => {
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        id: 'msg-125',
        contentItemOverrides: { cost: null },
      })
    );
    expect(result.contentItems[0]!.cost).toBeNull();
  });

  it('rejects invalid senderType', () => {
    expect(() =>
      messageResponseSchema.parse(buildMessageResponse({ senderType: 'system' }))
    ).toThrow();
  });

  it('rejects missing wrappedContentKey', () => {
    const msg = buildMessageResponse();
    delete msg['wrappedContentKey'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('rejects non-integer epochNumber', () => {
    expect(() => messageResponseSchema.parse(buildMessageResponse({ epochNumber: 1.5 }))).toThrow();
  });

  it('rejects non-integer sequenceNumber', () => {
    expect(() =>
      messageResponseSchema.parse(buildMessageResponse({ sequenceNumber: 0.5 }))
    ).toThrow();
  });

  it('rejects missing epochNumber', () => {
    const msg = buildMessageResponse();
    delete msg['epochNumber'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('rejects zero epochNumber', () => {
    expect(() => messageResponseSchema.parse(buildMessageResponse({ epochNumber: 0 }))).toThrow();
  });

  it('rejects negative sequenceNumber', () => {
    expect(() =>
      messageResponseSchema.parse(buildMessageResponse({ sequenceNumber: -1 }))
    ).toThrow();
  });

  it('rejects missing sequenceNumber', () => {
    const msg = buildMessageResponse();
    delete msg['sequenceNumber'];
    expect(() => messageResponseSchema.parse(msg)).toThrow();
  });

  it('strips unknown old DEK fields like role/content/iv', () => {
    // Zod object strips unknown keys by default
    const result = messageResponseSchema.parse(
      buildMessageResponse({
        role: 'user',
        content: 'plaintext',
        iv: 'oldiv',
        pendingReEncryption: false,
      })
    );
    expect('role' in result).toBe(false);
    expect('content' in result).toBe(false);
    expect('iv' in result).toBe(false);
    expect('pendingReEncryption' in result).toBe(false);
  });
});

describe('conversationListItemSchema', () => {
  it('accepts conversation with accepted true and null inviter', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
    });
    expect(result.accepted).toBe(true);
    expect(result.invitedByUsername).toBeNull();
    expect(result.privilege).toBe('owner');
  });

  it('accepts conversation with accepted false and inviter username', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-2',
      userId: 'user-1',
      title: 'base64title2',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 0,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: false,
      invitedByUsername: 'sarah',
      privilege: 'write',
    });
    expect(result.accepted).toBe(false);
    expect(result.invitedByUsername).toBe('sarah');
    expect(result.privilege).toBe('write');
  });

  it('rejects missing accepted field', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        invitedByUsername: null,
      })
    ).toThrow();
  });

  it('rejects missing invitedByUsername field', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        accepted: true,
        privilege: 'owner',
      })
    ).toThrow();
  });

  it('accepts valid privilege values', () => {
    const base = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
    };

    for (const privilege of ['read', 'write', 'admin', 'owner']) {
      const result = conversationListItemSchema.parse({ ...base, privilege });
      expect(result.privilege).toBe(privilege);
    }
  });

  it('rejects missing privilege field', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        accepted: true,
        invitedByUsername: null,
      })
    ).toThrow();
  });

  it('rejects invalid privilege value', () => {
    expect(() =>
      conversationListItemSchema.parse({
        id: 'conv-1',
        userId: 'user-1',
        title: 'base64title1',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 5,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        accepted: true,
        invitedByUsername: null,
        privilege: 'superadmin',
      })
    ).toThrow();
  });

  it('accepts muted field as boolean', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
      muted: true,
    });
    expect(result.muted).toBe(true);
  });

  it('defaults muted to false when not provided', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
    });
    expect(result.muted).toBe(false);
  });

  it('accepts pinned field as boolean', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
      pinned: true,
    });
    expect(result.pinned).toBe(true);
  });

  it('defaults pinned to false when not provided', () => {
    const result = conversationListItemSchema.parse({
      id: 'conv-1',
      userId: 'user-1',
      title: 'base64title1',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 5,
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      accepted: true,
      invitedByUsername: null,
      privilege: 'owner',
    });
    expect(result.pinned).toBe(false);
  });
});

describe('listConversationsResponseSchema', () => {
  it('accepts empty conversations array', () => {
    const result = listConversationsResponseSchema.parse({ conversations: [], nextCursor: null });
    expect(result.conversations).toEqual([]);
  });

  it('accepts array of conversation list items with accepted, inviter, and privilege fields', () => {
    const result = listConversationsResponseSchema.parse({
      conversations: [
        {
          id: 'conv-1',
          userId: 'user-1',
          title: 'base64title1',
          currentEpoch: 1,
          titleEpochNumber: 1,
          nextSequence: 5,
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          accepted: true,
          invitedByUsername: null,
          privilege: 'owner',
        },
        {
          id: 'conv-2',
          userId: 'user-1',
          title: 'base64title2',
          currentEpoch: 2,
          titleEpochNumber: 2,
          nextSequence: 10,
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
          accepted: false,
          invitedByUsername: 'mike',
          privilege: 'write',
        },
      ],
      nextCursor: null,
    });
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]?.accepted).toBe(true);
    expect(result.conversations[0]?.privilege).toBe('owner');
    expect(result.conversations[1]?.invitedByUsername).toBe('mike');
    expect(result.conversations[1]?.privilege).toBe('write');
  });
});

describe('getConversationResponseSchema', () => {
  const validConversation = {
    id: 'conv-123',
    title: 'base64encryptedtitle',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 2,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  const validMembership = {
    privilege: 'owner',
    muted: false,
    pinned: false,
    accepted: true,
    visibleFromEpoch: 1,
  };

  it('accepts a conversation with membership and forks', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: validMembership,
      forks: [
        { id: 'fork-1', name: 'branch', tipMessageId: null, createdAt: '2024-01-01T00:00:00Z' },
      ],
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.membership.privilege).toBe('owner');
    expect(result.membership.visibleFromEpoch).toBe(1);
    expect(result.forks).toHaveLength(1);
  });

  it('defaults forks to an empty array when omitted', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: validMembership,
    });
    expect(result.forks).toEqual([]);
  });

  it('carries the unaccepted membership state', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: { ...validMembership, accepted: false, privilege: 'write' },
      forks: [],
    });
    expect(result.membership.accepted).toBe(false);
    expect(result.membership.privilege).toBe('write');
  });

  it('strips the retired flat fields', () => {
    const result = getConversationResponseSchema.parse({
      conversation: validConversation,
      membership: validMembership,
      forks: [],
      messages: [],
      callerId: 'user-456',
      invitedByUsername: null,
      accepted: true,
      privilege: 'owner',
    });
    expect('messages' in result).toBe(false);
    expect('callerId' in result).toBe(false);
    expect('invitedByUsername' in result).toBe(false);
  });

  it('rejects a missing membership', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: validConversation,
        forks: [],
      })
    ).toThrow();
  });

  it('rejects an invalid membership privilege', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: validConversation,
        membership: { ...validMembership, privilege: 'invalid_privilege' },
        forks: [],
      })
    ).toThrow();
  });

  it('rejects a membership missing visibleFromEpoch', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: validConversation,
        membership: { privilege: 'owner', muted: false, pinned: false, accepted: true },
        forks: [],
      })
    ).toThrow();
  });

  it('rejects a missing conversation', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        membership: validMembership,
        forks: [],
      })
    ).toThrow();
  });

  it('rejects a conversation missing epoch fields', () => {
    expect(() =>
      getConversationResponseSchema.parse({
        conversation: {
          id: 'conv-123',
          title: 'base64encryptedtitle',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        membership: {
          privilege: 'owner',
          muted: false,
          pinned: false,
          accepted: true,
          visibleFromEpoch: 1,
        },
        forks: [],
      })
    ).toThrow();
  });
});

describe('createConversationResponseSchema', () => {
  const validConversation = {
    id: 'conv-123',
    title: 'base64encryptedtitle',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 0,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };

  it('accepts a created conversation', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      created: true,
    });
    expect(result.conversation.id).toBe('conv-123');
    expect(result.created).toBe(true);
  });

  it('accepts an idempotent (already-existing) return', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      created: false,
    });
    expect(result.created).toBe(false);
  });

  it('strips unknown keys', () => {
    const result = createConversationResponseSchema.parse({
      conversation: validConversation,
      message: buildMessageResponse({
        id: 'msg-1',
        conversationId: 'conv-123',
        senderId: 'user-456',
      }),
      created: true,
    });
    expect('message' in result).toBe(false);
  });

  it('requires created field', () => {
    expect(() =>
      createConversationResponseSchema.parse({
        conversation: validConversation,
      })
    ).toThrow();
  });
});

describe('updateConversationResponseSchema', () => {
  it('accepts updated conversation with epoch fields', () => {
    const result = updateConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        title: 'base64updatedtitle',
        currentEpoch: 2,
        titleEpochNumber: 2,
        nextSequence: 15,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      },
    });
    expect(result.conversation.title).toBe('base64updatedtitle');
    expect(result.conversation.currentEpoch).toBe(2);
  });

  it('rejects a missing conversation field', () => {
    expect(() => updateConversationResponseSchema.parse({})).toThrow();
  });
});

describe('deleteConversationResponseSchema', () => {
  it('accepts deleted true', () => {
    const result = deleteConversationResponseSchema.parse({ deleted: true });
    expect(result.deleted).toBe(true);
  });

  it('accepts deleted false', () => {
    const result = deleteConversationResponseSchema.parse({ deleted: false });
    expect(result.deleted).toBe(false);
  });

  it('rejects missing deleted field', () => {
    expect(() => deleteConversationResponseSchema.parse({})).toThrow();
  });
});

describe('keyChainResponseSchema', () => {
  const validKeyChain = {
    wraps: [{ epochNumber: 3, wrap: 'base64wrap', confirmationHash: 'base64hash' }],
    chainLinks: [{ epochNumber: 3, chainLink: 'base64link', confirmationHash: 'base64linkhash' }],
    currentEpoch: 3,
  };

  it('accepts a valid keychain response', () => {
    const result = keyChainResponseSchema.parse(validKeyChain);
    expect(result.wraps[0]!.epochNumber).toBe(3);
    expect(result.wraps[0]!.wrap).toBe('base64wrap');
    expect(result.chainLinks[0]!.chainLink).toBe('base64link');
    expect(result.currentEpoch).toBe(3);
  });

  it('accepts empty wraps and chainLinks', () => {
    const result = keyChainResponseSchema.parse({ wraps: [], chainLinks: [], currentEpoch: 1 });
    expect(result.wraps).toEqual([]);
    expect(result.chainLinks).toEqual([]);
  });

  it('rejects a wrap missing the wrap ciphertext', () => {
    expect(() =>
      keyChainResponseSchema.parse({
        ...validKeyChain,
        wraps: [{ epochNumber: 3, confirmationHash: 'base64hash' }],
      })
    ).toThrow();
  });

  it('rejects a chain link missing the chainLink ciphertext', () => {
    expect(() =>
      keyChainResponseSchema.parse({
        ...validKeyChain,
        chainLinks: [{ epochNumber: 3, confirmationHash: 'base64linkhash' }],
      })
    ).toThrow();
  });

  it('rejects missing currentEpoch', () => {
    expect(() => keyChainResponseSchema.parse({ wraps: [], chainLinks: [] })).toThrow();
  });

  it('strips the dead visibleFromEpoch field from a wrap (not part of the wire contract)', () => {
    const result = keyChainResponseSchema.parse({
      ...validKeyChain,
      wraps: [
        { epochNumber: 3, wrap: 'base64wrap', confirmationHash: 'base64hash', visibleFromEpoch: 1 },
      ],
    });
    expect('visibleFromEpoch' in result.wraps[0]!).toBe(false);
  });
});

describe('forkResponseSchema', () => {
  it('accepts valid fork response', () => {
    const result = forkResponseSchema.parse({
      id: 'fork-1',
      conversationId: 'conv-1',
      name: 'Main',
      tipMessageId: 'msg-5',
      createdAt: '2026-03-03T00:00:00Z',
    });
    expect(result.id).toBe('fork-1');
    expect(result.name).toBe('Main');
    expect(result.tipMessageId).toBe('msg-5');
  });

  it('accepts fork with null tipMessageId', () => {
    const result = forkResponseSchema.parse({
      id: 'fork-1',
      conversationId: 'conv-1',
      name: 'Fork 1',
      tipMessageId: null,
      createdAt: '2026-03-03T00:00:00Z',
    });
    expect(result.tipMessageId).toBeNull();
  });

  it('rejects missing name', () => {
    expect(() =>
      forkResponseSchema.parse({
        id: 'fork-1',
        conversationId: 'conv-1',
        tipMessageId: null,
        createdAt: '2026-03-03T00:00:00Z',
      })
    ).toThrow();
  });
});

describe('createForkRequestSchema', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';
  const validMsgId = '550e8400-e29b-41d4-a716-446655440001';

  it('accepts valid request with id and fromMessageId', () => {
    const result = createForkRequestSchema.parse({
      id: validId,
      fromMessageId: validMsgId,
    });
    expect(result.id).toBe(validId);
    expect(result.fromMessageId).toBe(validMsgId);
    expect(result.name).toBeUndefined();
  });

  it('accepts optional name', () => {
    const result = createForkRequestSchema.parse({
      id: validId,
      fromMessageId: validMsgId,
      name: 'My Branch',
    });
    expect(result.name).toBe('My Branch');
  });

  it('rejects name exceeding 50 characters', () => {
    expect(() =>
      createForkRequestSchema.parse({
        id: validId,
        fromMessageId: validMsgId,
        name: 'x'.repeat(51),
      })
    ).toThrow();
  });

  it('rejects empty name', () => {
    expect(() =>
      createForkRequestSchema.parse({
        id: validId,
        fromMessageId: validMsgId,
        name: '',
      })
    ).toThrow();
  });

  it('rejects non-UUID id', () => {
    expect(() =>
      createForkRequestSchema.parse({
        id: 'not-a-uuid',
        fromMessageId: validMsgId,
      })
    ).toThrow();
  });

  it('rejects non-UUID fromMessageId', () => {
    expect(() =>
      createForkRequestSchema.parse({
        id: validId,
        fromMessageId: 'not-a-uuid',
      })
    ).toThrow();
  });
});

describe('renameForkRequestSchema', () => {
  it('accepts valid name', () => {
    const result = renameForkRequestSchema.parse({ name: 'My Branch' });
    expect(result.name).toBe('My Branch');
  });

  it('rejects empty name', () => {
    expect(() => renameForkRequestSchema.parse({ name: '' })).toThrow();
  });

  it('rejects name exceeding 50 characters', () => {
    expect(() => renameForkRequestSchema.parse({ name: 'x'.repeat(51) })).toThrow();
  });

  it('rejects missing name', () => {
    expect(() => renameForkRequestSchema.parse({})).toThrow();
  });
});

describe('regenerateRequestSchema', () => {
  const validMsgId = '550e8400-e29b-41d4-a716-446655440001';
  const validTargetId = '550e8400-e29b-41d4-a716-446655440002';
  const validAssistantId = '550e8400-e29b-41d4-a716-446655440099';

  const validRequest = {
    targetMessageId: validTargetId,
    action: 'retry' as const,
    models: ['gpt-4'],
    userMessage: { id: validMsgId, content: 'Hello' },
    messagesForInference: [{ role: 'user' as const, content: 'Hello' }],
    fundingSource: 'personal_balance' as const,
  };

  it('accepts valid retry request', () => {
    const result = regenerateRequestSchema.parse(validRequest);
    expect(result.action).toBe('retry');
    expect(result.targetMessageId).toBe(validTargetId);
    expect(result.models).toEqual(['gpt-4']);
  });

  it('accepts valid edit request', () => {
    const result = regenerateRequestSchema.parse({ ...validRequest, action: 'edit' });
    expect(result.action).toBe('edit');
  });

  it('rejects the legacy "regenerate" action (folded into "retry")', () => {
    expect(() =>
      regenerateRequestSchema.parse({ ...validRequest, action: 'regenerate' })
    ).toThrow();
  });

  it('rejects invalid action', () => {
    expect(() => regenerateRequestSchema.parse({ ...validRequest, action: 'delete' })).toThrow();
  });

  it('accepts multiple models (retry-all)', () => {
    const result = regenerateRequestSchema.parse({
      ...validRequest,
      models: ['gpt-4', 'claude-3-5-sonnet', 'gemini-1.5-pro'],
    });
    expect(result.models).toHaveLength(3);
  });

  it('rejects empty models array', () => {
    expect(() => regenerateRequestSchema.parse({ ...validRequest, models: [] })).toThrow();
  });

  it('rejects more than the max models', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        models: ['a', 'b', 'c', 'd', 'e', 'f'],
      })
    ).toThrow();
  });

  it('accepts optional replaceAssistantId (regenerate-one)', () => {
    const result = regenerateRequestSchema.parse({
      ...validRequest,
      replaceAssistantId: validAssistantId,
    });
    expect(result.replaceAssistantId).toBe(validAssistantId);
  });

  it('allows omitting replaceAssistantId (retry-all)', () => {
    const result = regenerateRequestSchema.parse(validRequest);
    expect(result.replaceAssistantId).toBeUndefined();
  });

  it('rejects non-UUID replaceAssistantId', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        replaceAssistantId: 'not-a-uuid',
      })
    ).toThrow();
  });

  it('accepts optional forkId', () => {
    const forkId = '550e8400-e29b-41d4-a716-446655440003';
    const result = regenerateRequestSchema.parse({ ...validRequest, forkId });
    expect(result.forkId).toBe(forkId);
  });

  it('allows omitting forkId', () => {
    const result = regenerateRequestSchema.parse(validRequest);
    expect(result.forkId).toBeUndefined();
  });

  it('accepts optional webSearchEnabled', () => {
    const result = regenerateRequestSchema.parse({
      ...validRequest,
      webSearchEnabled: true,
    });
    expect(result.webSearchEnabled).toBe(true);
  });

  it('accepts optional customInstructions', () => {
    const result = regenerateRequestSchema.parse({
      ...validRequest,
      customInstructions: 'Be concise',
    });
    expect(result.customInstructions).toBe('Be concise');
  });

  it('rejects customInstructions exceeding 5000 characters', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        customInstructions: 'x'.repeat(5001),
      })
    ).toThrow();
  });

  it('requires at least one message for inference', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        messagesForInference: [],
      })
    ).toThrow();
  });

  it('rejects empty user message content', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        userMessage: { id: validMsgId, content: '' },
      })
    ).toThrow();
  });

  it('rejects non-UUID targetMessageId', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        targetMessageId: 'not-a-uuid',
      })
    ).toThrow();
  });

  it('defaults modality to "text" when omitted', () => {
    const result = regenerateRequestSchema.parse(validRequest);
    expect(result.modality).toBe('text');
  });

  it('accepts modality: image with imageConfig', () => {
    const result = regenerateRequestSchema.parse({
      ...validRequest,
      modality: 'image',
      imageConfig: { aspectRatio: '16:9' },
    });
    expect(result.modality).toBe('image');
    expect(result.imageConfig?.aspectRatio).toBe('16:9');
  });

  it('rejects modality: video without videoConfig', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        modality: 'video',
      })
    ).toThrow();
  });

  it('accepts modality: video with videoConfig', () => {
    const result = regenerateRequestSchema.parse({
      ...validRequest,
      modality: 'video',
      videoConfig: {
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
      },
    });
    expect(result.modality).toBe('video');
    expect(result.videoConfig?.durationSeconds).toBe(5);
  });

  it('rejects modality: audio without audioConfig', () => {
    expect(() =>
      regenerateRequestSchema.parse({
        ...validRequest,
        modality: 'audio',
      })
    ).toThrow();
  });

  it('accepts modality: audio with audioConfig', () => {
    const result = regenerateRequestSchema.parse({
      ...validRequest,
      modality: 'audio',
      audioConfig: { format: 'mp3', maxDurationSeconds: 30 },
    });
    expect(result.modality).toBe('audio');
    expect(result.audioConfig?.format).toBe('mp3');
  });
});

describe('getConversationResponseSchema with forks', () => {
  const validMembership = {
    privilege: 'owner',
    muted: false,
    pinned: false,
    accepted: true,
    visibleFromEpoch: 1,
  };

  it('accepts response with forks array and strips the fork conversationId', () => {
    const result = getConversationResponseSchema.parse({
      conversation: {
        id: 'conv-123',
        title: 'base64title',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 2,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      },
      membership: validMembership,
      forks: [
        {
          id: 'fork-1',
          conversationId: 'conv-123',
          name: 'Main',
          tipMessageId: 'msg-5',
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    });
    expect(result.forks).toHaveLength(1);
    expect(result.forks[0]?.name).toBe('Main');
    expect('conversationId' in (result.forks[0] ?? {})).toBe(false);
  });
});
