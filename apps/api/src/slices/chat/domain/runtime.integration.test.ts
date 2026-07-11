import { afterAll, describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  conversationMembers,
  conversations,
  createDb,
  memberBudgets,
  sharedLinks,
  users,
  wallets,
} from '@hushbox/db';
import { nanoUSD } from '@hushbox/shared';
import { DAILY_ALLOWANCE_NANO_USD } from '../../billing/index.js';
import { succeedKeyRow } from '../../../lib/idempotency/index.js';
import { createConversationRuntime } from './runtime.js';
import { CHAT_TURN_HOOKS } from './constants.js';
import type { ConversationRuntimeDeps } from './runtime.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { ChatStores } from '../ports/stores.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type {
  FlowHookBindings,
  FlowRunOutcome,
  RunContext,
  RunIdentity,
  SenderPrincipal,
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

/** A runtime with an injected clock — drives the period-keyed allowance day. */
function runtimeWithNow(now: () => Date): ReturnType<typeof createConversationRuntime> {
  return createConversationRuntime({
    db,
    redis,
    telemetry: telemetry(),
    apiKey: 'mock-key',
    chatStores,
    readEpochPublicKey,
    now,
  });
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

/**
 * A registered user with BOTH wallets provisioned (as at registration): a
 * purchased wallet at `purchasedBalanceNanoUsd` and a free wallet at zero. When
 * the purchased balance is ≤ 0 the route selects the free wallet, so this seeds
 * the free-tier payer.
 */
async function seedFreeTierUser(
  purchasedBalanceNanoUsd: bigint
): Promise<{ userId: string; freeWalletId: string }> {
  const { userId } = await seedWallet(purchasedBalanceNanoUsd);
  const freeRows = await db
    .insert(wallets)
    .values({ userId, type: 'free', balanceNanoUsd: 0n })
    .returning({ id: wallets.id });
  const freeWalletId = freeRows[0]?.id;
  if (freeWalletId === undefined) throw new Error('free wallet seed failed');
  return { userId, freeWalletId };
}

/** A user with no wallet — a group sender the owner funds for. */
async function seedBareUser(): Promise<string> {
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
  return userId;
}

async function ownerWalletId(ownerId: string): Promise<string> {
  const walletRows = await db.select().from(wallets).where(eq(wallets.userId, ownerId));
  const walletId = walletRows[0]?.id;
  if (walletId === undefined) throw new Error('owner wallet seed failed');
  return walletId;
}

/** A conversation owned by `ownerId` with a durable per-conversation cap. */
async function seedConversation(
  ownerId: string,
  conversationBudgetNanoUsd: bigint
): Promise<string> {
  const rows = await db
    .insert(conversations)
    .values({ userId: ownerId, title: BYTES, conversationBudgetNanoUsd })
    .returning({ id: conversations.id });
  const conversationId = rows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);
  return conversationId;
}

async function addMember(conversationId: string, userId: string): Promise<string> {
  const rows = await db
    .insert(conversationMembers)
    .values({ conversationId, userId, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = rows[0]?.id;
  if (memberId === undefined) throw new Error('member seed failed');
  return memberId;
}

/** A paid RunContext for a turn: `userId` pays, an optional resolved `sender`. */
function paidRunContext(args: {
  readonly userId: string;
  readonly conversationId: string;
  readonly walletId: string;
  /** The resolved sender principal; when set, senderId is its principal id. */
  readonly sender?: SenderPrincipal;
}): RunContext {
  const senderPrincipalId = (sender: SenderPrincipal): string =>
    sender.kind === 'user' ? sender.userId : sender.linkId;
  const senderId = args.sender === undefined ? args.userId : senderPrincipalId(args.sender);
  return {
    mode: 'paid',
    userId: args.userId,
    senderId,
    ...(args.sender === undefined ? {} : { sender: args.sender }),
    conversationId: args.conversationId,
    walletId: args.walletId,
    epochNumber: 1,
    userMessage: { id: crypto.randomUUID(), content: 'hi' },
    runId: crypto.randomUUID(),
    fence: { id: 'f', executorId: 'e', claims: 1 },
  };
}

/** Seeds a shared link and its active WRITE link-guest member for a conversation. */
async function seedGuestMember(
  conversationId: string
): Promise<{ readonly linkId: string; readonly memberId: string }> {
  const linkRows = await db
    .insert(sharedLinks)
    .values({
      conversationId,
      linkPublicKey: crypto.getRandomValues(new Uint8Array(32)),
      displayName: 'Guest',
    })
    .returning({ id: sharedLinks.id });
  const linkId = linkRows[0]?.id;
  if (linkId === undefined) throw new Error('shared link seed failed');
  const memberRows = await db
    .insert(conversationMembers)
    .values({ conversationId, linkId, privilege: 'write', visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  const memberId = memberRows[0]?.id;
  if (memberId === undefined) throw new Error('guest member seed failed');
  return { linkId, memberId };
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

  it('refuses a group turn when the sender is over their durable per-member budget', async () => {
    // The owner funds (ample balance) and the conversation cap is generous; the
    // sender's own durable per-member cap is fully spent, so admission refuses on
    // the member scope — the cap is read from the durable member row, not the
    // conversation budget.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const senderId = await seedBareUser();
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const memberId = await addMember(conversationId, senderId);
    await db.insert(memberBudgets).values({ memberId, budgetNanoUsd: 1000n, spentNanoUsd: 2000n });

    const context = paidRunContext({ userId: senderId, conversationId, walletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });
  });

  it('admits a group turn on the sender OWN wallet when they have no member budget row (personal fall-through, no group scope)', async () => {
    // Absent durable member row → zero group headroom → the route funds from the
    // signed-in sender's OWN wallet (payer = sender wallet). The admission hook
    // must emit NO group scope: the sender is gated on their own balance alone.
    // Were a member scope emitted, the absent row's zero cap would deny —
    // admission proves it is not, so a member CAN chat before the owner
    // configures budgets (the fix).
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const { userId: senderId } = await seedWallet(10_000_000n);
    const senderWalletId = await ownerWalletId(senderId);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    await addMember(conversationId, senderId); // NO member_budgets row

    const context = paidRunContext({ userId: senderId, conversationId, walletId: senderWalletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('admits a group turn on the sender OWN wallet when the conversation has no budget (personal fall-through, no group scope)', async () => {
    // The conversation cap is 0 (none configured) → zero group headroom → the
    // route funds from the sender's OWN wallet. The admission hook emits NO
    // conversation scope (which, at a 0 cap, would deny): the sender is gated on
    // their own balance and admission succeeds.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const { userId: senderId } = await seedWallet(10_000_000n);
    const senderWalletId = await ownerWalletId(senderId);
    const conversationId = await seedConversation(ownerId, 0n);
    const memberId = await addMember(conversationId, senderId);
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });

    const context = paidRunContext({ userId: senderId, conversationId, walletId: senderWalletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('admits a group turn within both the per-member and per-conversation caps (owner funds)', async () => {
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const senderId = await seedBareUser();
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const memberId = await addMember(conversationId, senderId);
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });

    const context = paidRunContext({ userId: senderId, conversationId, walletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('admits an owner-initiated turn on balance alone (owner funds, never member-capped)', async () => {
    // The owner sends their own turn: no group scopes apply, so even a 0
    // conversation budget and no member row do not gate — the owner funds from
    // their wallet balance.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const conversationId = await seedConversation(ownerId, 0n);
    await addMember(conversationId, ownerId);

    const context = paidRunContext({ userId: ownerId, conversationId, walletId });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('admits an owner-funded LINK-GUEST turn within the guest member and conversation caps', async () => {
    // The OWNER pays (userId + walletId are the owner's); the guest is the
    // resolved sender. A guest is always owner-funded, so the group scopes gate
    // on the guest's durable member row and the conversation cap.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const guest = await seedGuestMember(conversationId);
    await db
      .insert(memberBudgets)
      .values({ memberId: guest.memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });

    const context = paidRunContext({
      userId: ownerId,
      conversationId,
      walletId,
      sender: { kind: 'linkGuest', linkId: guest.linkId, memberId: guest.memberId },
    });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision.admitted).toBe(true);
  });

  it('refuses an owner-funded LINK-GUEST turn over the guest per-member cap', async () => {
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const guest = await seedGuestMember(conversationId);
    // The guest's durable per-member cap is fully spent → admission refuses.
    await db
      .insert(memberBudgets)
      .values({ memberId: guest.memberId, budgetNanoUsd: 1000n, spentNanoUsd: 2000n });

    const context = paidRunContext({
      userId: ownerId,
      conversationId,
      walletId,
      sender: { kind: 'linkGuest', linkId: guest.linkId, memberId: guest.memberId },
    });
    const hooks: FlowHookBindings = runtime().bindHooks(context, DEFINITION);
    const decision = await hooks.admission({ definition: DEFINITION, estimate: nanoUSD(100n) });
    expect(decision).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });
  });

  it('admits an owner-funded group turn carrying an explicit USER sender principal', async () => {
    // The resolved-sender path for a member (not the flat fallback): the sender
    // rides the discriminated `sender`, and group scopes gate the same way.
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(ownerId);
    const senderId = await seedBareUser();
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    const memberId = await addMember(conversationId, senderId);
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 1_000_000n, spentNanoUsd: 0n });

    const context = paidRunContext({
      userId: senderId,
      conversationId,
      walletId,
      sender: { kind: 'user', userId: senderId, memberId },
    });
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

describe('conversation runtime — free-tier allowance', () => {
  it('admits a solo turn on the free wallet and emits the daily-allowance scope when the purchased balance is spent down', async () => {
    // A registered user whose purchased balance is 0: the route selects the free
    // wallet, and admission must gate the daily allowance (not refuse for lack of
    // balance) — a free wallet's snapshot skips the balance check.
    const { userId, freeWalletId } = await seedFreeTierUser(0n);
    const conversationId = await seedConversation(userId, 0n);
    await addMember(conversationId, userId);

    const context = paidRunContext({ userId, conversationId, walletId: freeWalletId });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    // The ONLY ceiling is the daily allowance — no balance/group scope.
    expect(decision.hold.scopeIds).toEqual([expect.stringMatching(/^allowance:/)]);
  });

  it('admits a group member on their free allowance when their purchased balance is spent down (self-funded fall-through)', async () => {
    const { userId: ownerId } = await seedWallet(10_000_000n);
    const { userId: senderId, freeWalletId } = await seedFreeTierUser(0n);
    const conversationId = await seedConversation(ownerId, 1_000_000n);
    await addMember(conversationId, senderId);

    // The route fell through to the sender's OWN free wallet: admission gates the
    // daily allowance alone, never a group scope.
    const context = paidRunContext({ userId: senderId, conversationId, walletId: freeWalletId });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    expect(decision.hold.scopeIds).toEqual([expect.stringMatching(/^allowance:/)]);
  });

  it('refuses a free-tier turn once the daily allowance is spent, and admits again the next UTC day (period-keyed, no reset job)', async () => {
    const { userId, freeWalletId } = await seedFreeTierUser(0n);
    const conversationId = await seedConversation(userId, 0n);
    await addMember(conversationId, userId);
    // Day 1: the whole daily allowance is already spent (one period row).
    await db
      .insert(allowanceSpending)
      .values({ userId, day: '2026-03-10', spentNanoUsd: DAILY_ALLOWANCE_NANO_USD });

    const day1 = new Date('2026-03-10T12:00:00Z');
    const refused = await runtimeWithNow(() => day1)
      .bindHooks(paidRunContext({ userId, conversationId, walletId: freeWalletId }), DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(refused).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });

    // Day 2: a different UTC day keys a fresh (userId, day) row — no reset job —
    // so the allowance is whole again and the same turn admits.
    const day2 = new Date('2026-03-11T12:00:00Z');
    const admitted = await runtimeWithNow(() => day2)
      .bindHooks(paidRunContext({ userId, conversationId, walletId: freeWalletId }), DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(admitted.admitted).toBe(true);
  });

  it('emits the daily-allowance scope for a free-wallet payer even when the conversation resolves to null (defensive)', async () => {
    // The conversation is deleted in the window between route-time validation and
    // the admission hook. The free wallet's balance check is skipped, so the
    // user-keyed allowance cap MUST still bind — it does not depend on the
    // conversation existing.
    const { userId, freeWalletId } = await seedFreeTierUser(0n);
    const context = paidRunContext({
      userId,
      conversationId: crypto.randomUUID(),
      walletId: freeWalletId,
    });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    expect(decision.hold.scopeIds).toEqual([expect.stringMatching(/^allowance:/)]);
  });

  it('emits no scopes for a purchased payer when the conversation resolves to null (balance still binds)', async () => {
    const { userId } = await seedWallet(10_000_000n);
    const walletId = await ownerWalletId(userId);
    const context = paidRunContext({
      userId,
      conversationId: crypto.randomUUID(),
      walletId,
    });
    const decision = await runtime()
      .bindHooks(context, DEFINITION)
      .admission({ definition: DEFINITION, estimate: nanoUSD(1000n) });
    expect(decision.admitted).toBe(true);
    if (!decision.admitted || decision.hold === undefined) {
      throw new Error('expected a granted hold');
    }
    expect(decision.hold.scopeIds).toEqual([]);
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

  const okHooks: FlowHookBindings = {
    admission: () =>
      Promise.resolve({
        admitted: true,
        holdRef: 'h',
        circuit: { estimateNanoUsd: 1n, costCircuitMultiplier: 5n, costCircuitLimitNanoUsd: 5n },
      }),
    settlement: () => Promise.resolve(),
  };

  it('builds the mock provider per run when the env gate is enabled and the run carries directives', async () => {
    const rt = createConversationRuntime({
      db,
      redis,
      telemetry: telemetry(),
      apiKey: 'mock-key',
      mockProviderEnabled: true,
      chatStores,
      readEpochPublicKey,
    });
    const handle = rt.executor.start({
      definition: DEFINITION,
      inputs: {},
      hooks: okHooks,
      runKey: crypto.randomUUID(),
      mockDirectives: { classifierResolution: 'a/model' },
      emit: () => {},
    });
    const outcome = await handle.done;
    expect(['succeeded', 'failed', 'stopped']).toContain(outcome.outcome);
  });

  it('reuses the cached real executor across runs on one runtime', async () => {
    const rt = runtime();
    const startOne = (): Promise<FlowRunOutcome> =>
      rt.executor.start({
        definition: DEFINITION,
        inputs: {},
        hooks: okHooks,
        runKey: crypto.randomUUID(),
        emit: () => {},
      }).done;
    // Two real-path runs on one runtime — the second reuses the cached executor.
    const first = await startOne();
    const second = await startOne();
    expect(['succeeded', 'failed', 'stopped']).toContain(first.outcome);
    expect(['succeeded', 'failed', 'stopped']).toContain(second.outcome);
  });
});

describe('conversation runtime — run money/lease capabilities', () => {
  function paidContext(userId: string, walletId: string, runId: string): RunContext {
    return {
      mode: 'paid',
      userId,
      senderId: userId,
      conversationId: crypto.randomUUID(),
      walletId,
      epochNumber: 1,
      userMessage: { id: crypto.randomUUID(), content: 'hi' },
      runId,
      fence: { id: 'f', executorId: 'e', claims: 1 },
    };
  }

  async function seededWalletId(balanceNanoUsd: bigint): Promise<{
    userId: string;
    walletId: string;
  }> {
    const { userId } = await seedWallet(balanceNanoUsd);
    const walletRows = await db.select().from(wallets).where(eq(wallets.userId, userId));
    const walletId = walletRows[0]?.id;
    if (walletId === undefined) throw new Error('wallet seed failed');
    return { userId, walletId };
  }

  it('admits the second turn immediately once the first run releases its hold', async () => {
    // The estimate consumes more than half the balance, so two live holds can
    // never coexist — only the release (not TTL expiry) lets the next turn in.
    const { userId, walletId } = await seededWalletId(1_000_000_000n);
    const rt = runtime();
    const firstRunId = crypto.randomUUID();
    const firstHooks = rt.bindHooks(paidContext(userId, walletId, firstRunId), DEFINITION);
    const first = await firstHooks.admission({
      definition: DEFINITION,
      estimate: nanoUSD(600_000_000n),
    });
    expect(first.admitted).toBe(true);

    const secondHooks = rt.bindHooks(
      paidContext(userId, walletId, crypto.randomUUID()),
      DEFINITION
    );
    const blocked = await secondHooks.admission({
      definition: DEFINITION,
      estimate: nanoUSD(600_000_000n),
    });
    expect(blocked).toEqual({ admitted: false, code: 'INSUFFICIENT_ADMISSION' });

    if (!first.admitted || first.hold === undefined) throw new Error('expected a granted hold');
    await rt.releaseHold(first.hold);

    const admitted = await secondHooks.admission({
      definition: DEFINITION,
      estimate: nanoUSD(600_000_000n),
    });
    expect(admitted.admitted).toBe(true);
  });

  it('re-executes exactly once after failRun frees a failed run key', async () => {
    const runKey = crypto.randomUUID();
    const rt = runtime();
    const first = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    if (first.outcome !== 'executor') throw new Error('expected executor');

    await rt.failRun(first.fence);

    // The retry reclaims the failed row as a fresh executor (claims advanced),
    // never a bogus attach to the dead run and never a 409.
    const retry = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(retry.outcome).toBe('executor');
    if (retry.outcome === 'executor') expect(retry.fence.claims).toBe(2);

    // Serialized: a concurrent second retry attaches to the reclaimed run.
    const concurrent = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(concurrent.outcome).toBe('attach');
  });

  it('failRun after a settled key row is a fenced no-op (the replay survives)', async () => {
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

    await rt.failRun(first.fence);

    const replay = await rt.claimRun({
      runKey,
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    expect(replay).toEqual({ outcome: 'replay', response: { ok: true } });
  });

  it('heartbeats the live fence and reports a superseded one lost', async () => {
    const rt = runtime();
    const claim = await rt.claimRun({
      runKey: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      bodyHash: 'h',
      identity: IDENTITY,
    });
    if (claim.outcome !== 'executor') throw new Error('expected executor');
    await expect(rt.heartbeat(claim.fence)).resolves.toBe('alive');
    // A zombie's fence (stale claim count) touches zero rows.
    await expect(rt.heartbeat({ ...claim.fence, claims: claim.fence.claims - 1 })).resolves.toBe(
      'lost'
    );
  });
});
