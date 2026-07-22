import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  WorkflowDefinition,
  serializeReasoningText,
} from '@hushbox/shared';
import { DEFAULT_WORKFLOW_CAPABILITIES, createConstraintRegistry } from '../../workflows/index.js';
import { generateEpochKeyPair } from '@hushbox/crypto';
import {
  attachVideoProgress,
  chatSettlementIdentity,
  createConversationRuntime,
  createExecutionResolvers,
  engineRandom,
  prepareStartRequest,
  providerFor,
  usesMockProvider,
  withMediaPutBarrier,
  withPostCommitSnapshotRefresh,
} from './runtime.js';
import { CHAT_TURN_HOOKS, CHAT_TURN_NODE_ID, TRIAL_TURN_HOOKS } from './constants.js';
import type { ChatHookBindings, ConversationRuntimeDeps, HeldStartRequest } from './runtime.js';
import type { MediaPersistPlan } from '@hushbox/shared';
import type { ChatStores } from '../ports/stores.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  InferenceRequest,
  MockDirectives,
  ModelDescriptor,
  RunContext,
} from '@hushbox/shared';

const telemetry: Telemetry = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  emitMetric: vi.fn(),
  captureError: vi.fn(),
};

const chatStores: ChatStores = {
  latestMessageIdWithinTx: () => Promise.resolve(null),
  insertMessageWithinTx: () => Promise.resolve(),
  insertContentItemWithinTx: () => Promise.resolve(),
  messageRefWithinTx: () => Promise.resolve(null),
  deleteAfterSequenceWithinTx: () => Promise.resolve(),
  deleteMessagesByIdWithinTx: () => Promise.resolve(),
};

const DEFINITION: WorkflowDefinition = {
  version: 1,
  deadlineClass: 'text',
  hooks: CHAT_TURN_HOOKS,
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition;

const CONTEXT: RunContext = {
  mode: 'paid',
  userId: 'u1',
  senderId: 'u1',
  conversationId: 'c1',
  walletId: 'w1',
  epochNumber: 1,
  userMessage: { id: 'um1', content: 'hi' },
  runId: 'run-1',
  fence: { id: 'f', executorId: 'e', claims: 1 },
};

/** Redis whose snapshot read and script exec both reject — the fail-closed admission path. */
const rejectingRedis = {
  get: () => Promise.reject(new Error('redis down')),
  createScript: () => ({ exec: () => Promise.reject(new Error('redis down')) }),
} as unknown as ConversationRuntimeDeps['redis'];

/**
 * A db whose only supported read is the admission hook's membership lookup,
 * which returns no member — so no member-budget scope applies and admission
 * proceeds to the balance/run-cap gate the tests actually exercise.
 */
const noMemberDb = {
  select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
} as unknown as ConversationRuntimeDeps['db'];

/** Text-turn paths must never reach storage; a throwing proxy proves it. */
const untouchedStorage = new Proxy(
  {},
  {
    get() {
      throw new Error('storage must not be touched by this path');
    },
  }
) as ConversationRuntimeDeps['storage'];

function deps(overrides: Partial<ConversationRuntimeDeps>): ConversationRuntimeDeps {
  return {
    db: noMemberDb,
    redis: {} as unknown as ConversationRuntimeDeps['redis'],
    telemetry,
    apiKey: 'k',
    isCI: false,
    chatStores,
    storage: untouchedStorage,
    readEpochPublicKey: () => Promise.resolve(null),
    ...overrides,
  };
}

/** A db whose catalog read rejects — the executor build must fail the run. */
const catalogDownDb = {
  select: () => ({ from: () => Promise.reject(new Error('catalog down')) }),
} as unknown as ConversationRuntimeDeps['db'];

/** A db whose key-row insert rejects — the referee surfaces an infra failure. */
const refereeDownDb = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({ returning: () => Promise.reject(new Error('db down')) }),
    }),
  }),
} as unknown as ConversationRuntimeDeps['db'];

const HOOKS = {
  admission: () =>
    Promise.resolve({
      admitted: true as const,
      holdRef: 'h',
      circuit: { estimateNanoUsd: 1n, costCircuitMultiplier: 5n, costCircuitLimitNanoUsd: 5n },
    }),
  settlement: () => Promise.resolve(),
};

describe('usesMockProvider (production-inert gate)', () => {
  const crafted: MockDirectives = {
    classifierResolution: 'x/model',
    classifierFailure: true,
    failingModels: ['m'],
    classifierDelayMs: 5,
  };

  it('selects the mock in dev/E2E when a run carries directives', () => {
    expect(usesMockProvider({ mockProviderEnabled: true }, {})).toBe(true);
    expect(usesMockProvider({ mockProviderEnabled: true }, { classifierResolution: 'a' })).toBe(
      true
    );
  });

  it('selects the real provider in dev/E2E when a run carries NO directives', () => {
    const absent: MockDirectives | undefined = undefined;
    expect(usesMockProvider({ mockProviderEnabled: true }, absent)).toBe(false);
  });

  it('NEVER selects the mock in production, even for a crafted directives body', () => {
    // The paramount safety property: the DO-side env gate is false in production,
    // so no request body content can reach the mock there.
    expect(usesMockProvider({ mockProviderEnabled: false }, crafted)).toBe(false);
    expect(usesMockProvider({ mockProviderEnabled: false }, {})).toBe(false);
  });

  it('defaults to the real provider when the gate is unset (CI-vitest / cassettes)', () => {
    expect(usesMockProvider({}, crafted)).toBe(false);
  });
});

describe('providerFor (per-run provider selection)', () => {
  function languageDescriptor(id: string): ModelDescriptor {
    return {
      id,
      provider: 'p',
      version: '1',
      inputs: ['text'],
      outputs: ['text'],
      parameters: {},
      behaviors: [],
      limits: {},
      pricing: {},
      zdrReachable: true,
      releasedAt: 1_700_000_000,
      fetchedAt: 0,
    };
  }
  function classifierRequest(model: string): InferenceRequest {
    return {
      model,
      inputs: [{ modality: 'text', text: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nchoose` }],
      parameters: {},
      outputs: ['text'],
    };
  }
  async function classifierText(provider: ReturnType<typeof providerFor>): Promise<string> {
    const model = 'base/model';
    let text = '';
    for await (const event of provider.infer(classifierRequest(model), languageDescriptor(model))) {
      if (event.kind === 'text-delta') text += event.content;
    }
    return text;
  }

  it('varies mock classifier behavior per run by the run’s directives (A vs B)', async () => {
    const dev = { mockProviderEnabled: true, apiKey: '' } as const;
    const a = await classifierText(providerFor(dev, { classifierResolution: 'model-A' }));
    const b = await classifierText(providerFor(dev, { classifierResolution: 'model-B' }));
    expect(a).toBe('model-A');
    expect(b).toBe('model-B');
    expect(a).not.toBe(b);
  });

  it('fails a directed model’s generation on the mock (a distinct per-run behavior)', async () => {
    const dev = { mockProviderEnabled: true, apiKey: '' } as const;
    const model = 'base/model';
    const textRequest: InferenceRequest = {
      model,
      inputs: [{ modality: 'text', text: 'hello' }],
      parameters: {},
      outputs: ['text'],
    };
    const provider = providerFor(dev, { failingModels: [model] });
    const stream = provider.infer(textRequest, languageDescriptor(model));
    const drain = async (): Promise<void> => {
      for await (const event of stream) expect(event).toBeDefined();
    };
    await expect(drain()).rejects.toThrow();
  });

  it('returns the real provider in production regardless of a crafted directives body', () => {
    // No network is driven here — the decisive guarantee is that the gate the
    // real branch is chosen through is false, so the mock is never constructed.
    const production = { mockProviderEnabled: false, apiKey: 'k' } as const;
    expect(usesMockProvider(production, { classifierResolution: 'model-A' })).toBe(false);
    expect(typeof providerFor(production, { classifierResolution: 'model-A' }).infer).toBe(
      'function'
    );
  });

  it('threads the held-stream release awaitable into the per-run mock provider', async () => {
    const dev = { mockProviderEnabled: true, apiKey: '' } as const;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const model = 'base/model';
    const request: InferenceRequest = {
      model,
      inputs: [{ modality: 'text', text: 'hello' }],
      parameters: {},
      outputs: ['text'],
    };
    const provider = providerFor(dev, { holdPrimaryStream: true }, () => gate);
    const iterator = provider.infer(request, languageDescriptor(model))[Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(first.done).toBe(false);

    let settled = false;
    const secondPull = (async () => {
      const result = await iterator.next();
      settled = true;
      return result;
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    releaseGate();
    await secondPull;
    expect(settled).toBe(true);
  });

  it('threads deps.isDevServer so the mock applies default delays ONLY on a dev server', async () => {
    vi.useFakeTimers();
    try {
      const model = 'base/model';
      const request: InferenceRequest = {
        model,
        inputs: [{ modality: 'text', text: 'a prompt long enough to force several echo chunks' }],
        parameters: {},
        outputs: ['text'],
      };
      const drain = async (provider: ReturnType<typeof providerFor>): Promise<void> => {
        for await (const event of provider.infer(request, languageDescriptor(model))) {
          expect(event).toBeDefined();
        }
      };

      // Dev server → the 60ms inter-chunk default applies (no directive set), so
      // a multi-chunk echo cannot settle until the timers advance.
      const devServer = { mockProviderEnabled: true, apiKey: '', isDevServer: true } as const;
      let devSettled = false;
      const devPending = (async (): Promise<void> => {
        await drain(providerFor(devServer, {}));
        devSettled = true;
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(devSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(60 * 50);
      await devPending;
      expect(devSettled).toBe(true);

      // isDevServer omitted (E2E / vitest / CI branch) → instant: settles with no advance.
      const notDevServer = { mockProviderEnabled: true, apiKey: '' } as const;
      let plainSettled = false;
      const plainPending = (async (): Promise<void> => {
        await drain(providerFor(notDevServer, {}));
        plainSettled = true;
      })();
      await vi.advanceTimersByTimeAsync(0);
      expect(plainSettled).toBe(true);
      await plainPending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('conversation runtime executor', () => {
  it('fails the run when the model catalog snapshot is unavailable', async () => {
    const runtime = createConversationRuntime(deps({ db: catalogDownDb }));
    const handle = runtime.executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks: HOOKS,
      runKey: 'k',
      emit: () => {},
    });
    await expect(handle.done).rejects.toThrow(/catalog/);
  });

  it('attaches (and terminally stops) the video progress wiring on a media-classed run', async () => {
    vi.useFakeTimers();
    try {
      const mediaDefinition = { ...DEFINITION, deadlineClass: 'media' } as WorkflowDefinition;
      const runtime = createConversationRuntime(deps({ db: catalogDownDb }));
      const handle = runtime.executor.start({
        definition: mediaDefinition,
        inputs: {},
        hooks: HOOKS,
        runKey: 'k',
        emit: () => {},
      });
      await expect(handle.done).rejects.toThrow(/catalog/);
      // The terminal sink cleared the wrapper — a killed run leaks no timer.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('attachVideoProgress (start-request wiring)', () => {
  it('returns the very same request for a text-classed run (byte-identical path)', () => {
    const request: HeldStartRequest = {
      definition: DEFINITION,
      inputs: {},
      hooks: HOOKS,
      runKey: 'k',
      emit: () => {},
    };
    const attached = attachVideoProgress(request);
    expect(attached.request).toBe(request);
  });

  it('wraps emit for a media-classed run and injects video progress frames', () => {
    vi.useFakeTimers();
    try {
      const frames: Parameters<HeldStartRequest['emit']>[0][] = [];
      const mediaDefinition = WorkflowDefinition.parse({
        version: 1,
        deadlineClass: 'media',
        hooks: { admission: 'chat', settlement: 'chat' },
        nodes: [
          {
            id: 'answer',
            type: 'modelCall',
            version: 1,
            out: 'out',
            model: 'video-model',
            params: { durationSeconds: 9 },
            in: { node: 'input', port: 'prompt' },
          },
        ],
        edges: [],
      });
      const request: HeldStartRequest = {
        definition: mediaDefinition,
        inputs: {},
        hooks: HOOKS,
        runKey: 'k',
        emit: (frame) => frames.push(frame),
      };
      const attached = attachVideoProgress(request);
      expect(attached.request).not.toBe(request);
      attached.request.emit({
        streamId: 'answer#0',
        cursor: 1,
        event: { kind: 'stream-start', modelId: 'video-model', outputModality: 'video' },
      });
      vi.advanceTimersByTime(8000);
      expect(frames.map((frame) => frame.event.kind)).toEqual(['stream-start', 'media-progress']);
      attached.stopProgress();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('conversation runtime claimRun (infra failure)', () => {
  it('rethrows a non-conflict referee failure as unavailable', async () => {
    const runtime = createConversationRuntime(deps({ db: refereeDownDb }));
    await expect(
      runtime.claimRun({
        runKey: 'k',
        runId: 'r',
        bodyHash: 'h',
        identity: {
          mode: 'paid',
          userId: 'u1',
          senderId: 'u1',
          conversationId: 'c1',
          walletId: 'w1',
          epochNumber: 1,
          userMessage: { id: 'um1', content: 'hi' },
        },
      })
    ).rejects.toThrow(/run referee unavailable/);
  });

  it('scopes a trial claim on the session id (reaching the referee with the trial identity)', async () => {
    const runtime = createConversationRuntime(deps({ db: refereeDownDb }));
    // The trial branch derives the key-row scope from the session id; the fake
    // referee then rejects, proving the trial identity flowed through the claim.
    await expect(
      runtime.claimRun({
        runKey: 'k',
        runId: 'r',
        bodyHash: 'h',
        identity: { mode: 'trial', sessionId: 's1' },
      })
    ).rejects.toThrow(/run referee unavailable/);
  });
});

describe('conversation runtime bindHooks (policy dispatch)', () => {
  const TRIAL_CONTEXT: RunContext = {
    mode: 'trial',
    sessionId: 's1',
    runId: 'run-1',
    fence: { id: 'f', executorId: 'e', claims: 1 },
  };

  it('fails fast when the definition declares an unregistered policy', () => {
    const runtime = createConversationRuntime(deps({}));
    const unknownDefinition = {
      ...DEFINITION,
      hooks: { admission: 'mystery', settlement: 'mystery' },
    } as unknown as WorkflowDefinition;
    expect(() => runtime.bindHooks(CONTEXT, unknownDefinition)).toThrow(/no policy registered/);
  });

  it('binds the chat settlement for a fork-scoped run context', () => {
    const runtime = createConversationRuntime(deps({}));
    const hooks = runtime.bindHooks({ ...CONTEXT, forkId: 'fork-1' }, DEFINITION);
    expect(typeof hooks.settlement).toBe('function');
  });

  it('binds the chat settlement for a regenerate run context', () => {
    const runtime = createConversationRuntime(deps({}));
    const hooks = runtime.bindHooks(
      { ...CONTEXT, regenerate: { action: 'retry', targetMessageId: 'anchor-1' } },
      DEFINITION
    );
    expect(typeof hooks.settlement).toBe('function');
  });

  it('fails fast when a chat definition is bound under a non-paid identity', () => {
    const runtime = createConversationRuntime(deps({}));
    expect(() => runtime.bindHooks(TRIAL_CONTEXT, DEFINITION)).toThrow(/paid run identity/);
  });

  const TRIAL_DEFINITION = { ...DEFINITION, hooks: TRIAL_TURN_HOOKS } as WorkflowDefinition;

  it('binds the trial policy for a trial definition under a trial identity', () => {
    const runtime = createConversationRuntime(deps({}));
    const hooks = runtime.bindHooks(TRIAL_CONTEXT, TRIAL_DEFINITION);
    expect(typeof hooks.admission).toBe('function');
    expect(typeof hooks.settlement).toBe('function');
  });

  it('fails fast when a trial definition is bound under a non-trial identity', () => {
    const runtime = createConversationRuntime(deps({}));
    expect(() => runtime.bindHooks(CONTEXT, TRIAL_DEFINITION)).toThrow(/trial run identity/);
  });
});

describe('createExecutionResolvers', () => {
  it('resolves no sub-workflow for any ref', () => {
    const resolvers = createExecutionResolvers(
      createConstraintRegistry(DEFAULT_WORKFLOW_CAPABILITIES)
    );
    expect(resolvers.subWorkflows.resolve('anything')).toBeUndefined();
  });

  it('delegates schema lookups to the constraint registry (both arms)', () => {
    const constraints = createConstraintRegistry({
      ...DEFAULT_WORKFLOW_CAPABILITIES,
      schemas: [{ name: 'probe', version: 1, schema: z.string() }],
    });
    const resolvers = createExecutionResolvers(constraints);
    expect(resolvers.schemas.resolveSchema('probe')).toBeDefined();
    expect(resolvers.schemas.resolveSchema('missing')).toBeUndefined();
  });
});

describe('engineRandom', () => {
  it('returns a value in [0, 1)', () => {
    const value = engineRandom();
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
  });
});

describe('conversation runtime admission (fail-closed)', () => {
  it('maps a Redis-down admission failure to ADMISSION_UNAVAILABLE', async () => {
    const runtime = createConversationRuntime(deps({ redis: rejectingRedis }));
    const hooks = runtime.bindHooks(CONTEXT, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: 1n as never });
    expect(decision).toEqual({ admitted: false, code: 'ADMISSION_UNAVAILABLE' });
  });

  it('honors an injected clock and id source', () => {
    const now = (): Date => new Date('2026-07-05T00:00:00Z');
    const newId = (): string => 'fixed-id';
    const runtime = createConversationRuntime(deps({ now, newId }));
    // bindHooks closes over the injected clock; claimRun over the injected id —
    // constructing them exercises the provided-vs-default branches.
    expect(typeof runtime.bindHooks(CONTEXT, DEFINITION).settlement).toBe('function');
    expect(typeof runtime.claimRun).toBe('function');
  });
});

/** Redis whose admission script grants — drives the hold-readout grant path. */
const grantingRedis = {
  get: () => Promise.resolve({ balanceNanoUsd: '1000000000', ledgerSeq: 1, type: 'purchased' }),
  createScript: () => ({ exec: () => Promise.resolve('admitted') }),
} as unknown as ConversationRuntimeDeps['redis'];

/** A db whose key-row update matches (or misses) the fence. */
function keyRowUpdateDb(rows: readonly unknown[]): ConversationRuntimeDeps['db'] {
  return {
    update: () => ({
      set: () => ({ where: () => ({ returning: () => Promise.resolve(rows) }) }),
    }),
  } as unknown as ConversationRuntimeDeps['db'];
}

const keyRowDownDb = {
  update: () => ({
    set: () => ({ where: () => ({ returning: () => Promise.reject(new Error('db down')) }) }),
  }),
} as unknown as ConversationRuntimeDeps['db'];

const FENCE = { id: 'f', executorId: 'e', claims: 1 };

describe('conversation runtime admission (hold identity on the grant)', () => {
  it('carries the wallet-hold identity on the admission grant', async () => {
    const runtime = createConversationRuntime(deps({ redis: grantingRedis }));
    const hooks = runtime.bindHooks(CONTEXT, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: 1n as never });
    expect(decision).toMatchObject({
      admitted: true,
      hold: { walletId: 'w1', holdId: 'run-1', scopeIds: [] },
    });
  });
});

describe('conversation runtime executor (admitted propagation)', () => {
  it('settles admitted as an internal failure when the executor build fails', async () => {
    const runtime = createConversationRuntime(deps({ db: catalogDownDb }));
    const handle = runtime.executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks: HOOKS,
      runKey: 'k',
      emit: () => {},
    });
    await expect(handle.admitted).resolves.toEqual({ admitted: false, code: 'INTERNAL' });
    await expect(handle.done).rejects.toThrow(/catalog/);
  });
});

describe('conversation runtime money capabilities', () => {
  it('releases a hold through Redis (wallet hash plus every scope hash)', async () => {
    const hdel = vi.fn(() => Promise.resolve(1));
    const runtime = createConversationRuntime(
      deps({ redis: { hdel } as unknown as ConversationRuntimeDeps['redis'] })
    );
    await runtime.releaseHold({ walletId: 'w1', holdId: 'run-1', scopeIds: ['s1'] });
    expect(hdel).toHaveBeenCalledTimes(2);
  });

  it('swallows a release failure (the hold TTL is the backstop)', async () => {
    const hdel = vi.fn(() => Promise.reject(new Error('redis down')));
    const runtime = createConversationRuntime(
      deps({ redis: { hdel } as unknown as ConversationRuntimeDeps['redis'] })
    );
    await expect(
      runtime.releaseHold({ walletId: 'w1', holdId: 'run-1', scopeIds: [] })
    ).resolves.toBeUndefined();
  });

  it('reports alive when the heartbeat touch matches the fence', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowUpdateDb([{ id: 'f' }]) }));
    await expect(runtime.heartbeat(FENCE)).resolves.toBe('alive');
  });

  it('reports lost when the heartbeat touch matches no row', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowUpdateDb([]) }));
    await expect(runtime.heartbeat(FENCE)).resolves.toBe('lost');
  });

  it('treats a heartbeat store failure as alive (never stops a healthy run)', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowDownDb }));
    await expect(runtime.heartbeat(FENCE)).resolves.toBe('alive');
  });

  it('resolves failRun on the fenced flip and on a fence miss alike', async () => {
    await expect(
      createConversationRuntime(deps({ db: keyRowUpdateDb([{ id: 'f' }]) })).failRun(FENCE)
    ).resolves.toBeUndefined();
    await expect(
      createConversationRuntime(deps({ db: keyRowUpdateDb([]) })).failRun(FENCE)
    ).resolves.toBeUndefined();
  });

  it('swallows a failRun store failure (the lease lapse is the backstop)', async () => {
    const runtime = createConversationRuntime(deps({ db: keyRowDownDb }));
    await expect(runtime.failRun(FENCE)).resolves.toBeUndefined();
  });
});

describe('post-commit snapshot refresh (chat settlement wrap)', () => {
  const REQUEST = { runKey: 'k', outputs: {}, charges: [] };

  it('refreshes the wallet snapshot only after the settlement commits', async () => {
    const calls: string[] = [];
    const walletDb = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ balanceNanoUsd: 5n, ledgerSeq: 2n, type: 'purchased' }]),
        }),
      }),
    } as unknown as ConversationRuntimeDeps['db'];
    const casRedis = {
      createScript: () => ({
        exec: () => {
          calls.push('refresh');
          return Promise.resolve(1);
        },
      }),
    } as unknown as ConversationRuntimeDeps['redis'];
    const hook = withPostCommitSnapshotRefresh(
      () => {
        calls.push('settle');
        return Promise.resolve();
      },
      { db: walletDb, redis: casRedis, telemetry },
      'w1'
    );
    await hook(REQUEST);
    expect(calls).toEqual(['settle', 'refresh']);
  });

  it('never fails a settled run when the refresh fails', async () => {
    const hook = withPostCommitSnapshotRefresh(
      () => Promise.resolve(),
      { db: noMemberDb, redis: rejectingRedis, telemetry },
      'w1'
    );
    await expect(hook(REQUEST)).resolves.toBeUndefined();
  });

  it('propagates a settlement failure without attempting the refresh', async () => {
    const exec = vi.fn(() => Promise.resolve(1));
    const casRedis = {
      createScript: () => ({ exec }),
    } as unknown as ConversationRuntimeDeps['redis'];
    const hook = withPostCommitSnapshotRefresh(
      () => Promise.reject(new Error('settlement boom')),
      { db: noMemberDb, redis: casRedis, telemetry },
      'w1'
    );
    await expect(hook(REQUEST)).rejects.toThrow('settlement boom');
    expect(exec).not.toHaveBeenCalled();
  });
});

const MEDIA_DEFINITION: WorkflowDefinition = {
  version: 1,
  deadlineClass: 'media',
  hooks: CHAT_TURN_HOOKS,
  nodes: [
    { id: CHAT_TURN_NODE_ID, type: 'modelCall', model: 'x/img', params: { aspectRatio: '1:1' } },
  ],
  edges: [],
} as unknown as WorkflowDefinition;

const EPOCH_KEYS = generateEpochKeyPair();

describe('chatSettlementIdentity (mediaPlans threading)', () => {
  const context = { ...CONTEXT, mode: 'paid' as const };

  it('carries no mediaPlans for a text run', () => {
    const identity = chatSettlementIdentity(context);
    expect('mediaPlans' in identity).toBe(false);
    expect(identity.conversationId).toBe('c1');
    expect(identity.runId).toBe('run-1');
  });

  it('carries the SAME plans instance the mappers fill for a media run', () => {
    const plans = new Map<string, MediaPersistPlan>();
    const identity = chatSettlementIdentity(context, plans);
    expect(identity.mediaPlans).toBe(plans);
  });
});

describe('bindHooks media wiring', () => {
  it('attaches no mediaPersist and reads no epoch key for a text definition', () => {
    const readEpochPublicKey = vi.fn(() => Promise.resolve(null));
    const runtime = createConversationRuntime(deps({ readEpochPublicKey }));
    const bindings: ChatHookBindings = runtime.bindHooks(CONTEXT, DEFINITION);
    expect(bindings.mediaPersist).toBeUndefined();
    expect(readEpochPublicKey).not.toHaveBeenCalled();
  });

  it('attaches a mediaPersist whose mint pre-mints per-node plans for a media definition', async () => {
    const readEpochPublicKey = vi.fn(() =>
      Promise.resolve(EPOCH_KEYS.publicKey as Uint8Array | null)
    );
    const runtime = createConversationRuntime(deps({ readEpochPublicKey }));
    const bindings: ChatHookBindings = runtime.bindHooks(CONTEXT, MEDIA_DEFINITION);
    expect(bindings.mediaPersist).toBeDefined();
    // Binding is cheap and sync — the epoch read happens only at mint.
    expect(readEpochPublicKey).not.toHaveBeenCalled();
    await bindings.mediaPersist?.mint();
    expect(readEpochPublicKey).toHaveBeenCalledTimes(1);
    expect(bindings.mediaPersist?.mapFilePartFor(CHAT_TURN_NODE_ID)).toBeDefined();
    expect(bindings.mediaPersist?.mapFilePartFor('unknown-node')).toBeUndefined();
  });
});

describe('withMediaPutBarrier', () => {
  const REQUEST = { runKey: 'k', outputs: {}, charges: [] };

  it('awaits the puts before settling', async () => {
    const order: string[] = [];
    const hook = withMediaPutBarrier(
      () => {
        order.push('settle');
        return Promise.resolve();
      },
      () => {
        order.push('flush');
        return Promise.resolve();
      }
    );
    await hook(REQUEST);
    expect(order).toEqual(['flush', 'settle']);
  });

  it('rejects without settling when a put failed', async () => {
    const settle = vi.fn(() => Promise.resolve());
    const hook = withMediaPutBarrier(settle, () => Promise.reject(new Error('put lost')));
    await expect(hook(REQUEST)).rejects.toThrow('put lost');
    expect(settle).not.toHaveBeenCalled();
  });
});

describe('prepareStartRequest', () => {
  const baseRequest = {
    definition: DEFINITION,
    inputs: {},
    hooks: HOOKS,
    runKey: 'run-key',
    emit: vi.fn(),
  } as unknown as HeldStartRequest;

  it('returns the request untouched for a run without mediaPersist', async () => {
    const prepared = await prepareStartRequest(baseRequest);
    expect(prepared).toBe(baseRequest);
    expect(prepared.mapFilePartFor).toBeUndefined();
  });

  it('mints before returning and threads the mapper resolver for a media run', async () => {
    const mint = vi.fn(() => Promise.resolve());
    const mapper = vi.fn();
    const mapFilePartFor = vi.fn(() => mapper);
    const request = {
      ...baseRequest,
      hooks: { ...HOOKS, mediaPersist: { mint, mapFilePartFor } },
    } as unknown as HeldStartRequest;
    const prepared = await prepareStartRequest(request);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(prepared.mapFilePartFor?.(CHAT_TURN_NODE_ID)).toBe(mapper);
    expect(mapFilePartFor).toHaveBeenCalledWith(CHAT_TURN_NODE_ID);
  });

  it('strips embedded reasoning from resent assistant history before the run starts', async () => {
    const request = {
      ...baseRequest,
      history: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: serializeReasoningText('inner thoughts', 'the answer') },
      ],
    } as unknown as HeldStartRequest;
    const prepared = await prepareStartRequest(request);
    expect(prepared.history).toEqual([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'the answer' },
    ]);
  });

  it('strips history for a media run too — the mint path carries the stripped request', async () => {
    const mint = vi.fn(() => Promise.resolve());
    const request = {
      ...baseRequest,
      history: [
        { role: 'assistant', content: serializeReasoningText('inner thoughts', 'the answer') },
      ],
      hooks: { ...HOOKS, mediaPersist: { mint, mapFilePartFor: vi.fn() } },
    } as unknown as HeldStartRequest;
    const prepared = await prepareStartRequest(request);
    expect(prepared.history).toEqual([{ role: 'assistant', content: 'the answer' }]);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('returns the very same request when the resent history embeds no reasoning', async () => {
    const request = {
      ...baseRequest,
      history: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'plain answer' },
      ],
    } as unknown as HeldStartRequest;
    const prepared = await prepareStartRequest(request);
    expect(prepared).toBe(request);
  });
});
