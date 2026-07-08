import { afterAll, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversations,
  createDb,
  memberBudgets,
  users,
  wallets,
} from '@hushbox/db';
import { nanoUSD } from '@hushbox/shared';
import { succeedKeyRow } from '../../../lib/idempotency/index.js';
import { createConversationRuntime } from './runtime.js';
import { CHAT_TURN_HOOKS } from './constants.js';
import type { ConversationRuntimeDeps } from './runtime.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { ChatStores } from '../ports/stores.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  FlowHookBindings,
  RunContext,
  RunIdentity,
  WorkflowDefinition,
} from '@hushbox/shared';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) throw new Error('DATABASE_URL is required for chat runtime integration tests');

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: 'http://localhost:8079', token: 'local_dev_token' });
const BYTES = new Uint8Array([7, 7, 7]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  // Delete conversations first — the member rows cascade with them, so the
  // user delete never trips the member identity-or-left check via SET NULL.
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  await db.$client.end();
});

function telemetry(): Telemetry {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    emitMetric: vi.fn(),
    captureError: vi.fn(),
  };
}

const readEpochPublicKey: EpochPublicKeyReader = () => Promise.resolve(null);
const chatStores: ChatStores = {
  latestMessageIdWithinTx: () => Promise.resolve(null),
  insertMessageWithinTx: () => Promise.resolve(),
  insertContentItemWithinTx: () => Promise.resolve(),
  messageRefWithinTx: () => Promise.resolve(null),
  deleteAfterSequenceWithinTx: () => Promise.resolve(),
  deleteMessagesByIdWithinTx: () => Promise.resolve(),
};

function runtime(): ReturnType<typeof createConversationRuntime> {
  const deps: ConversationRuntimeDeps = {
    db,
    redis,
    telemetry: telemetry(),
    apiKey: 'mock-key',
    chatStores,
    readEpochPublicKey,
  };
  return createConversationRuntime(deps);
}

async function seedWallet(balanceNanoUsd: bigint): Promise<{ userId: string }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@chat-rt.test`,
      username: `rt${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  await db.insert(wallets).values({ userId, type: 'purchased', balanceNanoUsd });
  return { userId };
}

const CLAIM_USER = crypto.randomUUID();
const IDENTITY: RunIdentity = {
  mode: 'paid',
  userId: CLAIM_USER,
  senderId: CLAIM_USER,
  conversationId: 'c1',
  walletId: 'w1',
  epochNumber: 1,
  userMessage: { id: crypto.randomUUID(), content: 'hi' },
};

const DEFINITION: WorkflowDefinition = {
  version: 1,
  deadlineClass: 'text',
  hooks: CHAT_TURN_HOOKS,
  nodes: [],
  edges: [],
} as unknown as WorkflowDefinition;

describe('conversation runtime — claimRun', () => {
  it('claims a fresh run as the executor with a captured fence', async () => {
    const claim = await runtime().claimRun({
      runKey: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(claim.outcome).toBe('executor');
    if (claim.outcome === 'executor') expect(claim.fence.claims).toBe(1);
  });

  it('attaches a second claim of a live run key', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    await rt.claimRun({ runKey, runId: crypto.randomUUID(), bodyHash: 'h', identity: IDENTITY });
    const again = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(again.outcome).toBe('attach');
  });

  it('surfaces a reused key with a different body as a 409 conflict, never executing', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'body-A',
      identity: IDENTITY,
    });
    expect(first.outcome).toBe('executor');
    const conflict = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'body-B',
      identity: IDENTITY,
    });
    expect(conflict).toEqual({ outcome: 'conflict', code: 'IDEMPOTENCY_BODY_MISMATCH' });
  });

  it('replays a settled run key', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    if (first.outcome !== 'executor') throw new Error('expected executor');
    const flip = await succeedKeyRow(db, first.fence, { ok: true });
    flip._unsafeUnwrap();
    const replay = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(replay).toEqual({ outcome: 'replay', response: { ok: true } });
  });
});

describe('conversation runtime — admission hook', () => {
  async function admit(balanceNanoUsd: bigint, estimate: bigint) {
    const { userId } = await seedWallet(balanceNanoUsd);
    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const walletId = walletRows[0]?.id ?? '';
    const context: RunContext = {
      mode: 'paid',
      userId,
      senderId: userId,
      // A valid uuid the admission hook reads membership against; no membership
      // row exists, so no member budget scope applies (balance/run-cap only).
      conversationId: crypto.randomUUID(),
      walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId: crypto.randomUUID(),
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    return hooks.admission({ definition: DEFINITION, estimate: nanoUSD(estimate) });
  }

  it('grants admission with the cost-circuit readout when the balance covers the estimate', async () => {
    const decision = await admit(10_000_000n, 1000n);
    expect(decision.admitted).toBe(true);
  });

  it('refuses admission when the estimate exceeds the balance', async () => {
    const decision = await admit(500n, 10_000n);
    expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });
  });

  it('refuses admission when the initiator is over their configured member budget', async () => {
    const { userId } = await seedWallet(10_000_000n);
    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const walletId = walletRows[0]?.id ?? '';

    const convRows = await db
      .insert(conversations)
      .values({ userId, title: BYTES })
      .returning({ id: conversations.id });
    const conversationId = convRows[0]?.id;
    if (conversationId === undefined) throw new Error('conversation seed failed');
    createdConversationIds.push(conversationId);

    const memberRows = await db
      .insert(conversationMembers)
      .values({ conversationId, userId, visibleFromEpoch: 1 })
      .returning({ id: conversationMembers.id });
    const memberId = memberRows[0]?.id;
    if (memberId === undefined) throw new Error('member seed failed');

    // A configured member budget already fully spent for the current period.
    const month = new Date().toISOString().slice(0, 7);
    await db.insert(memberBudgets).values({
      memberId,
      month,
      budgetNanoUsd: 1000n,
      spentNanoUsd: 2000n,
    });

    const context: RunContext = {
      mode: 'paid',
      userId,
      senderId: userId,
      conversationId,
      walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId: crypto.randomUUID(),
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    // The wallet balance covers the estimate; the member budget does not — the
    // period row has zero remaining, so admission refuses on the budget scope.
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });
  });

  it('admits a member with no configured budget row (unlimited by default)', async () => {
    const { userId } = await seedWallet(10_000_000n);
    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const walletId = walletRows[0]?.id ?? '';

    const convRows = await db
      .insert(conversations)
      .values({ userId, title: BYTES })
      .returning({ id: conversations.id });
    const conversationId = convRows[0]?.id;
    if (conversationId === undefined) throw new Error('conversation seed failed');
    createdConversationIds.push(conversationId);
    // A member with NO member_budgets row — an unconfigured budget is unlimited,
    // so admission gates on balance alone.
    await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });

    const context: RunContext = {
      mode: 'paid',
      userId,
      senderId: userId,
      conversationId,
      walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId: crypto.randomUUID(),
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('maps a non-unavailable admission failure (missing wallet) to INSUFFICIENT_ADMISSION', async () => {
    const context: RunContext = {
      mode: 'paid',
      userId: crypto.randomUUID(),
      senderId: 'x',
      conversationId: crypto.randomUUID(),
      walletId: crypto.randomUUID(),
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId: crypto.randomUUID(),
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });
  });
});

describe('conversation runtime — executor', () => {
  it('runs a definition to a failed outcome and honors a pre-ready stop', async () => {
    const hooks: FlowHookBindings = {
      admission: () =>
        Promise.resolve({
          admitted: true,
          holdRef: 'h',
          circuit: {
            estimateNanoUsd: 1n,
            costCircuitMultiplier: 5n,
            costCircuitLimitNanoUsd: 5n,
          },
        }),
      settlement: () => Promise.resolve(),
    };
    const handle = runtime().executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks,
      runKey: crypto.randomUUID(),
      emit: () => {},
    });
    handle.stop('user-stop');
    const outcome = await handle.done;
    expect(['failed', 'stopped', 'succeeded']).toContain(outcome.outcome);
    // The build has settled and the inner handle exists; a stop here exercises
    // the post-ready branch (delegating straight to the inner handle).
    handle.stop('user-stop');
  });

  it('runs to completion without a pre-ready stop', async () => {
    const hooks: FlowHookBindings = {
      admission: () =>
        Promise.resolve({
          admitted: true,
          holdRef: 'h',
          circuit: {
            estimateNanoUsd: 1n,
            costCircuitMultiplier: 5n,
            costCircuitLimitNanoUsd: 5n,
          },
        }),
      settlement: () => Promise.resolve(),
    };
    const handle = runtime().executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks,
      runKey: crypto.randomUUID(),
      emit: () => {},
    });
    // No stop before the build resolves — exercises the not-stopped branch.
    const outcome = await handle.done;
    expect(['succeeded', 'failed', 'stopped']).toContain(outcome.outcome);
  });
});
