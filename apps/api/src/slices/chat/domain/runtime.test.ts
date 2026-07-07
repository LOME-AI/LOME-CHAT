import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_WORKFLOW_CAPABILITIES, createConstraintRegistry } from '../../workflows/index.js';
import { createConversationRuntime, createExecutionResolvers, engineRandom } from './runtime.js';
import { CHAT_TURN_HOOKS, TRIAL_TURN_HOOKS } from './constants.js';
import type { ConversationRuntimeDeps } from './runtime.js';
import type { ChatStores } from '../ports/stores.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { RunContext, WorkflowDefinition } from '@hushbox/shared';

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

/** Redis whose script exec rejects — the fail-closed admission path. */
const rejectingRedis = {
  createScript: () => ({ exec: () => Promise.reject(new Error('redis down')) }),
} as unknown as ConversationRuntimeDeps['redis'];

function deps(overrides: Partial<ConversationRuntimeDeps>): ConversationRuntimeDeps {
  return {
    db: {} as unknown as ConversationRuntimeDeps['db'],
    redis: {} as unknown as ConversationRuntimeDeps['redis'],
    telemetry,
    apiKey: 'k',
    chatStores,
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
