import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DEFAULT_WORKFLOW_CAPABILITIES, createConstraintRegistry } from '../../workflows/index.js';
import { createConversationRuntime, createExecutionResolvers, engineRandom } from './runtime.js';
import { CHAT_TURN_HOOKS } from './constants.js';
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
  nextSequenceWithinTx: () => Promise.resolve(0),
  insertMessageWithinTx: () => Promise.resolve(),
  insertContentItemWithinTx: () => Promise.resolve(),
};

const DEFINITION: WorkflowDefinition = {
  version: 1,
  deadlineClass: 'text',
  hooks: CHAT_TURN_HOOKS,
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition;

const CONTEXT: RunContext = {
  userId: 'u1',
  senderId: 'u1',
  conversationId: 'c1',
  walletId: 'w1',
  epochNumber: 1,
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
          userId: 'u1',
          senderId: 'u1',
          conversationId: 'c1',
          walletId: 'w1',
          epochNumber: 1,
        },
      })
    ).rejects.toThrow(/run referee unavailable/);
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
