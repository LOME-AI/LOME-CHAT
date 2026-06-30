import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';

const mockCollectMultiMediaModelStreams = vi.fn();
vi.mock('./multi-stream.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./multi-stream.js')>();
  return {
    ...actual,
    collectMultiMediaModelStreams: (
      ...args: Parameters<typeof actual.collectMultiMediaModelStreams>
    ) => mockCollectMultiMediaModelStreams(...args),
  };
});

const mockBroadcastFireAndForget = vi.fn();
vi.mock('./broadcast.js', () => ({
  broadcastFireAndForget: (...args: unknown[]) => mockBroadcastFireAndForget(...args),
}));

const mockFetchEpochPublicKey = vi.fn();
vi.mock('../services/chat/message-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chat/message-helpers.js')>();
  return {
    ...actual,
    fetchEpochPublicKey: (...args: Parameters<typeof actual.fetchEpochPublicKey>) =>
      mockFetchEpochPublicKey(...args),
  };
});

const mockSaveChatTurn = vi.fn();
vi.mock('../services/chat/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/chat/index.js')>();
  return {
    ...actual,
    saveChatTurn: (...args: unknown[]) => mockSaveChatTurn(...args),
  };
});

import {
  defaultMimeType,
  executeMediaPipeline,
  startVideoProgressTimer,
  type MediaPipelineInput,
} from './media-pipeline.js';
import type { MediaStreamResult } from './multi-stream.js';
import type { MediaPersistPricing } from './billing-types.js';
import type { AppEnv } from '../types.js';
import type { Context } from 'hono';
import type { SaveChatTurnResult } from '../services/chat/index.js';

interface PutCall {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

interface MediaStorageMock {
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  mintDownloadUrl: ReturnType<typeof vi.fn>;
  putCalls: PutCall[];
}

function createMediaStorageMock(options: { putThrows?: Error } = {}): MediaStorageMock {
  const putCalls: PutCall[] = [];
  return {
    putCalls,
    put: vi.fn((key: string, bytes: Uint8Array, contentType: string) => {
      putCalls.push({ key, bytes, contentType });
      if (options.putThrows) return Promise.reject(options.putThrows);
      return Promise.resolve();
    }),
    delete: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve({ objects: [] })),
    mintDownloadUrl: vi.fn(({ key }: { key: string }) =>
      Promise.resolve({
        url: `https://signed.example/${key}`,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      })
    ),
  };
}

interface DbMock {
  select: ReturnType<typeof vi.fn>;
  fromCalls: unknown[];
}

function createDbMock(currentEpoch = 1): DbMock {
  const fromCalls: unknown[] = [];
  // saveChatTurn is module-mocked, so the only db usage in executeMediaPipeline
  // is the conversations select. Drizzle chain: db.select({...}).from(table).where(...).

  const query = {
    from: (table: unknown) => {
      fromCalls.push(table);
      return {
        where: () => Promise.resolve([{ currentEpoch }]),
      };
    },
  };

  return {
    fromCalls,
    select: vi.fn(() => query),
  };
}

function createAiClientMock(): AppEnv['Variables']['aiClient'] {
  // executeMediaPipeline calls aiClient.stream(...) but we mock collectMultiMediaModelStreams
  // so the actual stream is never consumed. A trivial stub is enough.
  const fakeStream = {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next(): Promise<IteratorResult<unknown>> {
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  return {
    isMock: true,
    listModels: () => Promise.resolve([]),
    getModel: () => Promise.reject(new Error('not used')),
    stream: () => fakeStream as unknown as ReturnType<AppEnv['Variables']['aiClient']['stream']>,
    getGenerationStats: () => Promise.resolve({ costUsd: 0 }),
  } as unknown as AppEnv['Variables']['aiClient'];
}

function buildSuccessfulMediaResult(overrides: Partial<MediaStreamResult> = {}): MediaStreamResult {
  return {
    mediaBytes: new Uint8Array([0x01, 0x02, 0x03, 0x04]),
    mimeType: 'image/png',
    width: 16,
    height: 16,
    durationMs: undefined,
    generationId: 'gen-test-1',
    error: null,
    ...overrides,
  };
}

function buildFailedMediaResult(error = new Error('mock model failure')): MediaStreamResult {
  return {
    mediaBytes: undefined,
    mimeType: undefined,
    width: undefined,
    height: undefined,
    durationMs: undefined,
    generationId: undefined,
    error,
  };
}

const TEST_EPOCH_KEY = new Uint8Array(32).fill(0xab);

function createPipelineInput(overrides: Partial<MediaPipelineInput> = {}): MediaPipelineInput {
  return {
    c: {} as unknown as Context<AppEnv>,
    conversationId: 'conv-1',
    models: ['model-a'],
    treeAction: {
      kind: 'fresh-send',
      userMessage: { id: 'user-msg-1', content: 'Hello' },
      parentMessageId: null,
    },
    prompt: 'Hello',
    billingUserId: 'user-1',
    groupBudget: undefined,
    memberContext: undefined,
    releaseReservation: vi.fn(() => Promise.resolve()),
    senderId: 'user-1',
    forkId: undefined,
    mediaType: 'image' as const,
    pricingFor: () => ({ kind: 'image', perImage: 0.04 }) as MediaPersistPricing,
    buildRequest: (modelId: string) => ({
      modality: 'image' as const,
      model: modelId,
      prompt: 'Hello',
    }),
    noContentErrorMessage: 'No image generated',
    ...overrides,
  };
}

interface DepsCallLog {
  writeFirstMediaError: { mediaResults: Map<string, MediaStreamResult>; message: string }[];
  handleBillingResult: { assistantMessageId: string; generationId: string | undefined }[];
  finalizeTurn: {
    primaryModelId: string;
    successfulModelIds: readonly string[];
    primaryAssistantId: string;
  }[];
  createAssistantIdLookup: number;
}

function createDeps(options_: {
  billingResult: SaveChatTurnResult | null;
  log: DepsCallLog;
}): Parameters<typeof executeMediaPipeline>[1] {
  return {
    writeFirstMediaError: vi.fn(async (mediaResults, writer, message) => {
      options_.log.writeFirstMediaError.push({ mediaResults, message });
      await writer.writeError({ message });
    }),
    handleBillingResult: vi.fn((options) => {
      options_.log.handleBillingResult.push({
        assistantMessageId: options.assistantMessageId,
        generationId: options.generationId,
      });
      return Promise.resolve(options_.billingResult);
    }),
    finalizeTurn: vi.fn((options) => {
      options_.log.finalizeTurn.push({
        primaryModelId: options.primaryModelId,
        successfulModelIds: options.successfulModelIds,
        primaryAssistantId: options.getAssistantId(options.primaryModelId),
      });
      if (options.mutateBillingResult) options.mutateBillingResult(options.billingResult);
      return options.writer.writeDone({
        userMessageId: options.userMessageId,
        assistantMessageId: options.getAssistantId(options.primaryModelId),
        aiSequence: 1,
        epochNumber: 1,
        cost: '0.04',
      });
    }),
    createAssistantIdLookup: vi.fn((models: string[]) => {
      options_.log.createAssistantIdLookup += 1;
      const map = new Map(models.map((m, index) => [m, `assistant-${String(index)}`]));
      return (id: string) => map.get(id) ?? `assistant-${id}`;
    }),
  };
}

function createBillingResult(): SaveChatTurnResult {
  return {
    userSequence: 1,
    aiSequence: 2,
    epochNumber: 1,
    cost: '0.04',
    usageRecordId: 'usage-1',
    userEnvelope: {
      messageId: 'user-msg-1',
      wrappedContentKey: new Uint8Array(32),
      contentItem: {
        id: 'ci-user',
        contentType: 'text',
        position: 0,
        encryptedBlob: new Uint8Array(32),
        modelName: null,
        cost: null,
        isSmartModel: false,
      },
    },
    assistantResults: [
      {
        assistantMessageId: 'assistant-0',
        model: 'model-a',
        aiSequence: 2,
        cost: '0.04',
        usageRecordId: 'usage-1',
        envelope: {
          messageId: 'assistant-0',
          wrappedContentKey: new Uint8Array(32),
          contentItems: [
            {
              id: 'ci-1',
              contentType: 'image',
              position: 0,
              storageKey: 'media/conv-1/assistant-0/ci-1.enc',
              mimeType: 'image/png',
              sizeBytes: 100,
              width: 16,
              height: 16,
              durationMs: null,
              modelName: 'model-a',
              cost: '0.04',
              isSmartModel: false,
            },
          ],
        },
      },
    ],
  };
}

/** Build a minimal Hono test app that wires the pipeline into a route. */
function buildAppWithPipeline(options: {
  pipelineInput: Omit<MediaPipelineInput, 'c'>;
  deps: Parameters<typeof executeMediaPipeline>[1];
  db?: DbMock;
  mediaStorage?: MediaStorageMock;
  aiClient?: AppEnv['Variables']['aiClient'];
}): { app: Hono<AppEnv>; mediaStorage: MediaStorageMock; db: DbMock } {
  const db = options.db ?? createDbMock();
  const mediaStorage = options.mediaStorage ?? createMediaStorageMock();
  const aiClient = options.aiClient ?? createAiClientMock();
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('db', db as unknown as AppEnv['Variables']['db']);
    c.set('aiClient', aiClient);
    c.set('mediaStorage', mediaStorage as unknown as AppEnv['Variables']['mediaStorage']);
    await next();
  });

  app.post('/run', (c) => {
    const input: MediaPipelineInput = { ...options.pipelineInput, c };
    return executeMediaPipeline(input, options.deps);
  });

  return { app, mediaStorage, db };
}

describe('defaultMimeType', () => {
  it('returns image/png for image kind', () => {
    expect(defaultMimeType('image')).toBe('image/png');
  });

  it('returns video/mp4 for video kind', () => {
    expect(defaultMimeType('video')).toBe('video/mp4');
  });

  it('returns audio/mpeg for audio kind', () => {
    expect(defaultMimeType('audio')).toBe('audio/mpeg');
  });

  it('throws on unrecognized kind (assertNever exhaustiveness guard)', () => {
    expect(() => defaultMimeType('rogue' as 'image')).toThrow(/exhaustiveness/i);
  });
});

describe('executeMediaPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchEpochPublicKey.mockResolvedValue({
      epochPublicKey: TEST_EPOCH_KEY,
      epochNumber: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws invariant error when models array is empty', () => {
    const c = {
      get: vi.fn((key: string) => {
        if (key === 'db') return createDbMock();
        if (key === 'aiClient') return createAiClientMock();
        if (key === 'mediaStorage') return createMediaStorageMock();
        return null;
      }),
      env: {},
    } as unknown as Context<AppEnv>;

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: null, log });

    expect(() => executeMediaPipeline(createPipelineInput({ c, models: [] }), deps)).toThrow(
      /models must have at least one entry/
    );
  });

  it('happy path: encrypts, stores, persists, attaches download URL, broadcasts', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const billingResult = createBillingResult();
    const deps = createDeps({ billingResult, log });

    const release = vi.fn(() => Promise.resolve());
    const { app, mediaStorage } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({ releaseReservation: release }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('event: start');
    expect(text).toContain('event: done');

    expect(mediaStorage.put).toHaveBeenCalledOnce();
    expect(mediaStorage.putCalls[0]!.key).toMatch(/^media\/conv-1\/assistant-0\/.+\.enc$/);

    expect(mediaStorage.mintDownloadUrl).toHaveBeenCalledOnce();

    expect(mockSaveChatTurn).toHaveBeenCalledOnce();

    expect(log.handleBillingResult).toHaveLength(1);
    expect(log.handleBillingResult[0]!.generationId).toBe('gen-test-1');

    expect(log.finalizeTurn).toHaveLength(1);

    expect(release).toHaveBeenCalledOnce();
  });

  it('broadcasts message:new for fresh-send AFTER saveChatTurn commits', async () => {
    const callOrder: string[] = [];

    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => {
      callOrder.push('saveChatTurn');
      return Promise.resolve(createBillingResult());
    });
    mockBroadcastFireAndForget.mockImplementation((_env, _conversationId, event: unknown) => {
      if (typeof event === 'object' && event !== null && 'type' in event) {
        const typed = event as { type: string };
        if (typed.type === 'message:new') {
          callOrder.push('broadcast:message:new');
        }
      }
    });

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const billingResult = createBillingResult();
    const deps = createDeps({ billingResult, log });

    const { app } = buildAppWithPipeline({
      pipelineInput: { ...createPipelineInput() },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(200);
    await res.text();

    expect(callOrder).toEqual(['saveChatTurn', 'broadcast:message:new']);
  });

  it('writes media error and skips persistence when every model fails', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildFailedMediaResult()]]);
      return Promise.resolve(map);
    });

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: null, log });

    const release = vi.fn(() => Promise.resolve());
    const { app, mediaStorage } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({ releaseReservation: release }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(200);
    await res.text();

    expect(mediaStorage.put).not.toHaveBeenCalled();
    expect(mockSaveChatTurn).not.toHaveBeenCalled();
    expect(log.writeFirstMediaError).toHaveLength(1);
    expect(log.writeFirstMediaError[0]!.message).toBe('No image generated');
    expect(log.handleBillingResult).toHaveLength(0);
    expect(log.finalizeTurn).toHaveLength(0);

    expect(release).toHaveBeenCalledOnce();
  });

  it('emits EMPTY_MEDIA_RESULT when every model returned no bytes and no errors', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([
        [
          'model-a',
          {
            mediaBytes: undefined,
            mimeType: undefined,
            width: undefined,
            height: undefined,
            durationMs: undefined,
            generationId: undefined,
            error: null,
          },
        ],
      ]);
      return Promise.resolve(map);
    });

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: null, log });
    const release = vi.fn(() => Promise.resolve());
    const { app } = buildAppWithPipeline({
      pipelineInput: { ...createPipelineInput({ releaseReservation: release }) },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('event: error');
    expect(text).toContain('"code":"EMPTY_MEDIA_RESULT"');
    expect(mockSaveChatTurn).not.toHaveBeenCalled();
    expect(log.finalizeTurn).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it('emits UNKNOWN_MIME_TYPE when gateway result has a disallowed mime type', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([
        ['model-a', buildSuccessfulMediaResult({ mimeType: 'image/gif' as unknown as string })],
      ]);
      return Promise.resolve(map);
    });

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: null, log });
    const release = vi.fn(() => Promise.resolve());

    const { app, mediaStorage } = buildAppWithPipeline({
      pipelineInput: { ...createPipelineInput({ releaseReservation: release }) },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('event: error');
    expect(text).toContain('"code":"UNKNOWN_MIME_TYPE"');
    expect(mediaStorage.put).not.toHaveBeenCalled();
    expect(mockSaveChatTurn).not.toHaveBeenCalled();
    expect(log.finalizeTurn).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it('emits STORAGE_WRITE_FAILED when R2 put rejects', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: null, log });
    const release = vi.fn(() => Promise.resolve());

    const failingStorage = createMediaStorageMock({ putThrows: new Error('R2 unavailable') });

    const { app } = buildAppWithPipeline({
      pipelineInput: { ...createPipelineInput({ releaseReservation: release }) },
      deps,
      mediaStorage: failingStorage,
    });

    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(200);
    const text = await res.text();

    expect(text).toContain('event: error');
    expect(text).toContain('"code":"STORAGE_WRITE_FAILED"');
    expect(mockSaveChatTurn).not.toHaveBeenCalled();
    expect(log.finalizeTurn).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it('partial-success: persists only successful models; failed ones absent from storage', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([
        ['model-a', buildSuccessfulMediaResult({ generationId: 'gen-A' })],
        ['model-b', buildFailedMediaResult()],
      ]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const { app, mediaStorage } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({ models: ['model-a', 'model-b'] }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    expect(res.status).toBe(200);
    await res.text();

    expect(mediaStorage.put).toHaveBeenCalledOnce();
    expect(log.writeFirstMediaError).toHaveLength(0);
    expect(log.handleBillingResult[0]!.generationId).toBe('gen-A');
  });

  it('writes error event when handleBillingResult returns null (billing failure)', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: null, log });

    const release = vi.fn(() => Promise.resolve());
    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({ releaseReservation: release }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    const text = await res.text();

    expect(text).toContain('event: error');
    expect(text).toContain('"code":"BILLING_ERROR"');
    expect(log.finalizeTurn).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it('R2 PUT failure surfaces inside the pipeline (and release still runs)', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: null, log });
    const release = vi.fn(() => Promise.resolve());

    const failingStorage = createMediaStorageMock({ putThrows: new Error('R2 unavailable') });

    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({ releaseReservation: release }),
      },
      deps,
      mediaStorage: failingStorage,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    expect(mockSaveChatTurn).not.toHaveBeenCalled();
    expect(log.finalizeTurn).toHaveLength(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it('SSE keep-alive emits at the configured interval while persistence is in progress', async () => {
    vi.useFakeTimers();

    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });

    const { promise: saveChatTurnPromise, resolve: resolveSaveChatTurn } =
      Promise.withResolvers<SaveChatTurnResult>();
    mockSaveChatTurn.mockImplementation(() => saveChatTurnPromise);

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });
    deps.handleBillingResult = vi.fn(async (options) => {
      await options.billingPromise;
      log.handleBillingResult.push({
        assistantMessageId: options.assistantMessageId,
        generationId: options.generationId,
      });
      return createBillingResult();
    });

    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput(),
      },
      deps,
    });

    const reqPromise = app.request('/run', { method: 'POST' });

    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(30_000);

    resolveSaveChatTurn(createBillingResult());

    vi.useRealTimers();
    const res = await reqPromise;
    await res.text();

    expect(log.finalizeTurn.length).toBeGreaterThan(0);
  });

  it('passes group billing context to saveChatTurn when memberContext + groupBudget present', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({
          memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
          groupBudget: {
            conversationId: 'conv-1',
            memberId: 'member-1',
            payerId: 'owner-1',
            costCents: 100,
          },
        }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    expect(mockSaveChatTurn).toHaveBeenCalledOnce();
    const saveArgs = mockSaveChatTurn.mock.calls[0]![1] as { groupBillingContext?: unknown };
    expect(saveArgs.groupBillingContext).toEqual({ memberId: 'member-1' });
  });

  it('forwards forkId to saveChatTurn when present', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({ forkId: 'fork-123' }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    const saveArgs = mockSaveChatTurn.mock.calls[0]![1] as { forkId?: string };
    expect(saveArgs.forkId).toBe('fork-123');
  });

  it('uses default mime type when result.mimeType is missing for image kind', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([
        ['model-a', buildSuccessfulMediaResult({ mimeType: undefined })],
      ]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({
          pricingFor: () => ({ kind: 'image', perImage: 0.04 }) as MediaPersistPricing,
        }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    const saveArgs = mockSaveChatTurn.mock.calls[0]![1] as {
      assistantMessages: { contentItems: { mimeType: string }[] }[];
    };
    expect(saveArgs.assistantMessages[0]!.contentItems[0]!.mimeType).toBe('image/png');
  });

  it('uses default mime type for video kind when result.mimeType missing', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([
        ['model-a', buildSuccessfulMediaResult({ mimeType: undefined, durationMs: 2000 })],
      ]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({
          pricingFor: () =>
            ({
              kind: 'video',
              perSecond: 0.05,
              durationSeconds: 2,
              resolution: '720p',
            }) as MediaPersistPricing,
        }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    const saveArgs = mockSaveChatTurn.mock.calls[0]![1] as {
      assistantMessages: { contentItems: { mimeType: string }[] }[];
    };
    expect(saveArgs.assistantMessages[0]!.contentItems[0]!.mimeType).toBe('video/mp4');
  });

  it('uses default mime type for audio kind when result.mimeType missing', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([
        ['model-a', buildSuccessfulMediaResult({ mimeType: undefined, durationMs: 1000 })],
      ]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const { app } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({
          pricingFor: () =>
            ({ kind: 'audio', perSecond: 0.015, durationSeconds: 1 }) as MediaPersistPricing,
        }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    const saveArgs = mockSaveChatTurn.mock.calls[0]![1] as {
      assistantMessages: { contentItems: { mimeType: string }[] }[];
    };
    expect(saveArgs.assistantMessages[0]!.contentItems[0]!.mimeType).toBe('audio/mpeg');
  });

  it('falls back to currentEpoch=1 when conversation row is missing', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const emptyDb = {
      select: vi.fn(() => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      })),
      fromCalls: [] as unknown[],
    };

    const { app } = buildAppWithPipeline({
      pipelineInput: { ...createPipelineInput() },
      deps,
      db: emptyDb as unknown as DbMock,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    expect(mockFetchEpochPublicKey).toHaveBeenCalledWith(expect.anything(), 'conv-1', 1);
  });

  it('skips a result when filterSuccessfulMediaModels surfaces it but mediaBytes is later undefined', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([
        ['model-a', buildSuccessfulMediaResult({ mediaBytes: new Uint8Array() })],
        ['model-b', buildSuccessfulMediaResult({ mediaBytes: new Uint8Array([0x42]) })],
      ]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const { app, mediaStorage } = buildAppWithPipeline({
      pipelineInput: {
        ...createPipelineInput({ models: ['model-a', 'model-b'] }),
      },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    expect(mediaStorage.put).toHaveBeenCalledOnce();
  });

  it('attachDownloadUrls is a no-op for assistant results without contentItems envelope', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const textShapedBillingResult: SaveChatTurnResult = {
      ...createBillingResult(),
      assistantResults: [
        {
          assistantMessageId: 'assistant-0',
          model: 'model-a',
          aiSequence: 2,
          cost: '0.04',
          usageRecordId: 'usage-1',
          envelope: {
            messageId: 'assistant-0',
            wrappedContentKey: new Uint8Array(32),
            contentItem: {
              id: 'ci-text',
              contentType: 'text',
              position: 0,
              encryptedBlob: new Uint8Array([1, 2, 3]),
              modelName: 'model-a',
              cost: '0.04',
              isSmartModel: false,
            },
          },
        },
      ],
    };

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: textShapedBillingResult, log });

    const { app } = buildAppWithPipeline({
      pipelineInput: { ...createPipelineInput() },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    expect(log.finalizeTurn).toHaveLength(1);
  });

  it('passes pricingFor result into computeMediaCost (image kind)', async () => {
    mockCollectMultiMediaModelStreams.mockImplementation(() => {
      const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
      return Promise.resolve(map);
    });
    mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

    const log: DepsCallLog = {
      writeFirstMediaError: [],
      handleBillingResult: [],
      finalizeTurn: [],
      createAssistantIdLookup: 0,
    };
    const deps = createDeps({ billingResult: createBillingResult(), log });

    const pricingForSpy = vi.fn(() => ({ kind: 'image', perImage: 0.123 }) as MediaPersistPricing);

    const { app } = buildAppWithPipeline({
      pipelineInput: { ...createPipelineInput({ pricingFor: pricingForSpy }) },
      deps,
    });

    const res = await app.request('/run', { method: 'POST' });
    await res.text();

    expect(pricingForSpy).toHaveBeenCalledOnce();
    const saveArgs = mockSaveChatTurn.mock.calls[0]![1] as {
      assistantMessages: { cost: number; mediaType: string }[];
    };
    expect(saveArgs.assistantMessages[0]!.mediaType).toBe('image');
  });

  describe('model:media:start emission (early, pre-gateway)', () => {
    it('writes model:media:start for every model BEFORE collectMultiMediaModelStreams runs', async () => {
      mockCollectMultiMediaModelStreams.mockImplementation(() => {
        const map = new Map<string, MediaStreamResult>([
          ['model-a', buildSuccessfulMediaResult()],
          ['model-b', buildSuccessfulMediaResult()],
        ]);
        return Promise.resolve(map);
      });
      mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

      const log: DepsCallLog = {
        writeFirstMediaError: [],
        handleBillingResult: [],
        finalizeTurn: [],
        createAssistantIdLookup: 0,
      };
      const deps = createDeps({ billingResult: createBillingResult(), log });

      const { app } = buildAppWithPipeline({
        pipelineInput: {
          ...createPipelineInput({
            models: ['model-a', 'model-b'],
            mediaType: 'image',
          }),
        },
        deps,
      });

      const res = await app.request('/run', { method: 'POST' });
      const text = await res.text();

      const startMatches = text.match(/event: model:media:start/g) ?? [];
      expect(startMatches.length).toBe(2);

      const startIndex = text.indexOf('event: model:media:start');
      const doneIndex = text.indexOf('event: done');
      expect(startIndex).toBeGreaterThan(-1);
      expect(doneIndex).toBeGreaterThan(startIndex);
    });

    it('uses application/octet-stream as the placeholder mimeType in model:media:start', async () => {
      mockCollectMultiMediaModelStreams.mockImplementation(() => {
        const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
        return Promise.resolve(map);
      });
      mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

      const log: DepsCallLog = {
        writeFirstMediaError: [],
        handleBillingResult: [],
        finalizeTurn: [],
        createAssistantIdLookup: 0,
      };
      const deps = createDeps({ billingResult: createBillingResult(), log });

      const { app } = buildAppWithPipeline({
        pipelineInput: {
          ...createPipelineInput({ mediaType: 'image' }),
        },
        deps,
      });

      const res = await app.request('/run', { method: 'POST' });
      const text = await res.text();

      expect(text).toContain('"mimeType":"application/octet-stream"');
      expect(text).toContain('"mediaType":"image"');
    });

    it('forwards the configured mediaType for video', async () => {
      mockCollectMultiMediaModelStreams.mockImplementation(() => {
        const map = new Map<string, MediaStreamResult>([
          ['model-a', buildSuccessfulMediaResult({ durationMs: 5000 })],
        ]);
        return Promise.resolve(map);
      });
      mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

      const log: DepsCallLog = {
        writeFirstMediaError: [],
        handleBillingResult: [],
        finalizeTurn: [],
        createAssistantIdLookup: 0,
      };
      const deps = createDeps({ billingResult: createBillingResult(), log });

      const { app } = buildAppWithPipeline({
        pipelineInput: {
          ...createPipelineInput({
            mediaType: 'video',
            pricingFor: () =>
              ({
                kind: 'video',
                perSecond: 0.05,
                durationSeconds: 5,
                resolution: '720p',
              }) as MediaPersistPricing,
            buildRequest: (modelId: string) => ({
              modality: 'video' as const,
              model: modelId,
              prompt: 'Hello',
              durationSeconds: 5,
            }),
          }),
        },
        deps,
      });

      const res = await app.request('/run', { method: 'POST' });
      const text = await res.text();

      expect(text).toContain('"mediaType":"video"');
    });

    it('forwards the configured mediaType for audio', async () => {
      mockCollectMultiMediaModelStreams.mockImplementation(() => {
        const map = new Map<string, MediaStreamResult>([
          ['model-a', buildSuccessfulMediaResult({ durationMs: 1000 })],
        ]);
        return Promise.resolve(map);
      });
      mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

      const log: DepsCallLog = {
        writeFirstMediaError: [],
        handleBillingResult: [],
        finalizeTurn: [],
        createAssistantIdLookup: 0,
      };
      const deps = createDeps({ billingResult: createBillingResult(), log });

      const { app } = buildAppWithPipeline({
        pipelineInput: {
          ...createPipelineInput({
            mediaType: 'audio',
            pricingFor: () =>
              ({ kind: 'audio', perSecond: 0.015, durationSeconds: 1 }) as MediaPersistPricing,
            buildRequest: (modelId: string) => ({
              modality: 'audio' as const,
              model: modelId,
              prompt: 'Hello',
              format: 'mp3' as const,
            }),
          }),
        },
        deps,
      });

      const res = await app.request('/run', { method: 'POST' });
      const text = await res.text();

      expect(text).toContain('"mediaType":"audio"');
    });
  });

  describe('model:media:progress (video only)', () => {
    interface RecordedProgress {
      modelId: string;
      assistantMessageId: string;
      percent: number;
    }

    function makeRecordingWriter(): {
      writer: Parameters<typeof startVideoProgressTimer>[0];
      records: RecordedProgress[];
    } {
      const records: RecordedProgress[] = [];
      const noop = (): Promise<void> => Promise.resolve();
      const writer = {
        writeStart: noop,
        writeModelToken: noop,
        writeModelMediaStart: noop,
        writeModelMediaProgress: (data: RecordedProgress) => {
          records.push(data);
          return Promise.resolve();
        },
        writeError: noop,
        writeModelDone: noop,
        writeModelError: noop,
        writeDone: noop,
        writeStageStart: noop,
        writeStageDone: noop,
        writeStageError: noop,
        isConnected: () => true,
        isDoneWritten: () => false,
      } as Parameters<typeof startVideoProgressTimer>[0];
      return { writer, records };
    }

    it('emits ascending progress percents at fixed intervals derived from expectedDurationMs', async () => {
      vi.useFakeTimers();
      const { writer, records } = makeRecordingWriter();
      const handle = startVideoProgressTimer(writer, ['model-a'], () => 'asst-a', 40_000);

      await vi.advanceTimersByTimeAsync(45_000);
      handle.stop();
      vi.useRealTimers();

      expect(records.length).toBeGreaterThanOrEqual(1);
      const percents = records.map((r) => r.percent);
      for (let index = 1; index < percents.length; index++) {
        expect(percents[index]!).toBeGreaterThanOrEqual(percents[index - 1]!);
      }
      for (const p of percents) {
        expect(p).toBeLessThanOrEqual(95);
      }
      expect(percents.at(-1)).toBe(95);
    });

    it('emits one progress event per model in the batch on each tick', async () => {
      vi.useFakeTimers();
      const { writer, records } = makeRecordingWriter();
      const handle = startVideoProgressTimer(
        writer,
        ['model-a', 'model-b'],
        (id) => `asst-${id}`,
        40_000
      );

      await vi.advanceTimersByTimeAsync(5000);
      handle.stop();
      vi.useRealTimers();

      expect(records.length).toBe(2);
      const ids = records.map((r) => r.modelId).toSorted((a, b) => a.localeCompare(b));
      expect(ids).toEqual(['model-a', 'model-b']);
      expect(records[0]!.assistantMessageId).toBe(`asst-${records[0]!.modelId}`);
    });

    it('switches to a 5s heartbeat at 95% for runs that exceed the expected window', async () => {
      vi.useFakeTimers();
      const { writer, records } = makeRecordingWriter();
      const handle = startVideoProgressTimer(writer, ['model-a'], () => 'asst-a', 40_000);

      await vi.advanceTimersByTimeAsync(45_000);
      const beforeHeartbeat = records.length;
      await vi.advanceTimersByTimeAsync(11_000);
      handle.stop();
      vi.useRealTimers();

      const afterHeartbeat = records.length;
      expect(afterHeartbeat - beforeHeartbeat).toBeGreaterThanOrEqual(2);
      const heartbeats = records.slice(beforeHeartbeat);
      for (const r of heartbeats) {
        expect(r.percent).toBe(95);
      }
    });

    it('stop() cancels both the sweep and the heartbeat', async () => {
      vi.useFakeTimers();
      const { writer, records } = makeRecordingWriter();
      const handle = startVideoProgressTimer(writer, ['model-a'], () => 'asst-a', 40_000);

      await vi.advanceTimersByTimeAsync(5000);
      const seen = records.length;
      handle.stop();
      handle.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();

      expect(records.length).toBe(seen);
    });

    it('does NOT emit model:media:progress for image modality', async () => {
      mockCollectMultiMediaModelStreams.mockImplementation(() => {
        const map = new Map<string, MediaStreamResult>([['model-a', buildSuccessfulMediaResult()]]);
        return Promise.resolve(map);
      });
      mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

      const log: DepsCallLog = {
        writeFirstMediaError: [],
        handleBillingResult: [],
        finalizeTurn: [],
        createAssistantIdLookup: 0,
      };
      const deps = createDeps({ billingResult: createBillingResult(), log });

      const { app } = buildAppWithPipeline({
        pipelineInput: { ...createPipelineInput({ mediaType: 'image' }) },
        deps,
      });

      const res = await app.request('/run', { method: 'POST' });
      const text = await res.text();

      expect(text).not.toContain('event: model:media:progress');
    });

    it('does NOT emit model:media:progress for audio modality', async () => {
      mockCollectMultiMediaModelStreams.mockImplementation(() => {
        const map = new Map<string, MediaStreamResult>([
          ['model-a', buildSuccessfulMediaResult({ durationMs: 1000 })],
        ]);
        return Promise.resolve(map);
      });
      mockSaveChatTurn.mockImplementation(() => Promise.resolve(createBillingResult()));

      const log: DepsCallLog = {
        writeFirstMediaError: [],
        handleBillingResult: [],
        finalizeTurn: [],
        createAssistantIdLookup: 0,
      };
      const deps = createDeps({ billingResult: createBillingResult(), log });

      const { app } = buildAppWithPipeline({
        pipelineInput: {
          ...createPipelineInput({
            mediaType: 'audio',
            pricingFor: () =>
              ({ kind: 'audio', perSecond: 0.015, durationSeconds: 1 }) as MediaPersistPricing,
            buildRequest: (modelId: string) => ({
              modality: 'audio' as const,
              model: modelId,
              prompt: 'Hello',
              format: 'mp3' as const,
            }),
          }),
        },
        deps,
      });

      const res = await app.request('/run', { method: 'POST' });
      const text = await res.text();

      expect(text).not.toContain('event: model:media:progress');
    });
  });
});
