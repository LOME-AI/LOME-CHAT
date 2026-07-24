import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  memberBudgets,
  users,
  wallets,
} from '@hushbox/db';
import { applyPipeline } from '../../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../../middleware/pipeline-session.js';
import { okAsync } from '../../../lib/result/index.js';
import {
  admitRun,
  createBillingStores,
  releaseHold,
  resolveBudgetScopes,
} from '../../billing/index.js';
import { getConversationBudgets } from './budgets.js';
import { createConversationsManifest, createConversationsStores } from '../index.js';
import { createMembershipRevoker } from '../adapters/membership.js';
import { createLinkResolutionAdapter } from '../../../adapters/link-resolution.js';
import { deleteForkMessagesWithinTx } from '../../chat/index.js';
import type { BudgetScope } from '../../billing/index.js';
import type { AppEnv, Bindings } from '../../../lib/context/index.js';
import type { TelemetryEnv } from '../../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from '../ports/realtime.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for budgets route tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];
let userCounter = 0;

const BYTES = new Uint8Array([9, 9, 9]);

interface TestUser {
  userId: string;
  cookie: string;
}

async function newUser(): Promise<TestUser> {
  userCounter += 1;
  const username = `zzb${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}u${String(userCounter)}`;
  const rows = await db
    .insert(users)
    .values({
      email: `${username}@budgets.test`,
      username,
      opaqueRegistration: BYTES,
      publicKey: crypto.getRandomValues(new Uint8Array(32)),
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const sealed = await sealData(
    {
      userId,
      sessionId: `session-${userId}`,
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return { userId, cookie: `${SESSION_COOKIE_NAME}=${sealed}` };
}

function silentRealtime(): RealtimeBroadcast {
  return {
    broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
    evict: () => okAsync(0),
    presence: () => okAsync([]),
    startRun: () => okAsync({ started: true, runId: 'r', deadlineAt: 0 }),
    stopRun: () => okAsync(false),
    upgrade: () => okAsync(new Response(null, { status: 200 })),
  };
}

function createApp(): Hono<AppEnv> {
  const manifest = createConversationsManifest({
    stores: createConversationsStores,
    billing: createBillingStores(),
    revoker: createMembershipRevoker,
    realtime: () => silentRealtime(),
    deleteForkMessages: (writer) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(writer, conversationId, ids),
    linkResolution: (db) => createLinkResolutionAdapter(db),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  app.route(manifest.basePath, manifest.routes);
  return app;
}

const app = createApp();

async function send(
  method: string,
  path: string,
  cookie: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = { cookie, 'content-type': 'application/json' };
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  return app.request(
    path,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    testEnv
  );
}

/** Seeds a conversation owned by `ownerId` with the given active members. */
async function seedConversation(
  ownerId: string,
  members: { userId: string; privilege: 'owner' | 'read' | 'write' | 'admin' }[]
): Promise<{ conversationId: string; memberIds: Map<string, string> }> {
  const conversationId = crypto.randomUUID();
  await db.insert(conversations).values({ id: conversationId, userId: ownerId, title: BYTES });
  createdConversationIds.push(conversationId);
  const memberIds = new Map<string, string>();
  for (const member of members) {
    const rows = await db
      .insert(conversationMembers)
      .values({
        conversationId,
        userId: member.userId,
        privilege: member.privilege,
        visibleFromEpoch: 1,
        acceptedAt: new Date(),
      })
      .returning({ id: conversationMembers.id });
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('member seed failed');
    memberIds.set(member.userId, id);
  }
  return { conversationId, memberIds };
}

async function seedPurchasedWallet(userId: string, balanceNanoUsd: bigint): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  return id;
}

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe('owner-facing budget management', () => {
  it('lets the owner set an individual per-member cap, preserving cumulative spend', async () => {
    const owner = await newUser();
    const memberA = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: memberA.userId, privilege: 'write' },
    ]);
    const memberAId = memberIds.get(memberA.userId);
    if (memberAId === undefined) throw new Error('member A id missing');
    // A pre-existing budget row with accrued spend: the cap set must not reset it.
    await db.insert(memberBudgets).values({
      memberId: memberAId,
      budgetNanoUsd: 100n,
      spentNanoUsd: 30n,
    });

    const response = await send(
      'PUT',
      `/conversations/${conversationId}/member/${memberAId}/budget`,
      owner.cookie,
      { capNanoUsd: '500' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: true });
    const row = await db
      .select({ budget: memberBudgets.budgetNanoUsd, spent: memberBudgets.spentNanoUsd })
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, memberAId))
      .then((rows) => rows[0]);
    expect(row).toEqual({ budget: 500n, spent: 30n });
  });

  it('lets the owner set different caps for different members', async () => {
    const owner = await newUser();
    const memberA = await newUser();
    const memberB = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: memberA.userId, privilege: 'write' },
      { userId: memberB.userId, privilege: 'write' },
    ]);
    const memberAId = memberIds.get(memberA.userId)!;
    const memberBId = memberIds.get(memberB.userId)!;

    await send('PUT', `/conversations/${conversationId}/member/${memberAId}/budget`, owner.cookie, {
      capNanoUsd: '400',
    });
    await send('PUT', `/conversations/${conversationId}/member/${memberBId}/budget`, owner.cookie, {
      capNanoUsd: '900',
    });

    const rows = await db
      .select({ memberId: memberBudgets.memberId, budget: memberBudgets.budgetNanoUsd })
      .from(memberBudgets)
      .where(inArray(memberBudgets.memberId, [memberAId, memberBId]));
    const byMember = new Map(rows.map((r) => [r.memberId, r.budget]));
    expect(byMember.get(memberAId)).toBe(400n);
    expect(byMember.get(memberBId)).toBe(900n);
  });

  it('lets the owner set the per-conversation cap', async () => {
    const owner = await newUser();
    const { conversationId } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
    ]);

    const response = await send('PUT', `/conversations/${conversationId}/budget`, owner.cookie, {
      capNanoUsd: '2000',
    });

    expect(response.status).toBe(200);
    const row = await db
      .select({ cap: conversations.conversationBudgetNanoUsd })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .then((rows) => rows[0]);
    expect(row?.cap).toBe(2000n);
  });

  it('lets an admin non-owner set a per-member cap', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const target = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: admin.userId, privilege: 'admin' },
      { userId: target.userId, privilege: 'write' },
    ]);
    const targetId = memberIds.get(target.userId)!;

    const response = await send(
      'PUT',
      `/conversations/${conversationId}/member/${targetId}/budget`,
      admin.cookie,
      { capNanoUsd: '750' }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: true });
    const row = await db
      .select({ budget: memberBudgets.budgetNanoUsd })
      .from(memberBudgets)
      .where(eq(memberBudgets.memberId, targetId))
      .then((rows) => rows[0]);
    expect(row?.budget).toBe(750n);
  });

  it('refuses an admin non-owner on the owner-only per-conversation cap', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const { conversationId } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: admin.userId, privilege: 'admin' },
    ]);

    const response = await send('PUT', `/conversations/${conversationId}/budget`, admin.cookie, {
      capNanoUsd: '500',
    });

    expect(response.status).toBe(403);
  });

  it('refuses a write member on set-member-cap and set-conversation-cap', async () => {
    const owner = await newUser();
    const writer = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: writer.userId, privilege: 'write' },
    ]);
    const writerId = memberIds.get(writer.userId)!;

    const setMember = await send(
      'PUT',
      `/conversations/${conversationId}/member/${writerId}/budget`,
      writer.cookie,
      { capNanoUsd: '500' }
    );
    const setConversation = await send(
      'PUT',
      `/conversations/${conversationId}/budget`,
      writer.cookie,
      { capNanoUsd: '500' }
    );

    expect(setMember.status).toBe(403);
    expect(setConversation.status).toBe(403);
  });

  it('lets a non-owner member view budgets, scoped to their own figures only', async () => {
    const owner = await newUser();
    const viewer = await newUser();
    const other = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: viewer.userId, privilege: 'read' },
      { userId: other.userId, privilege: 'write' },
    ]);
    const viewerId = memberIds.get(viewer.userId)!;
    const otherId = memberIds.get(other.userId)!;

    await seedPurchasedWallet(owner.userId, 1000n);
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 2000n })
      .where(eq(conversations.id, conversationId));
    await db.insert(conversationSpending).values({ conversationId, spentNanoUsd: 300n });
    await db
      .insert(memberBudgets)
      .values({ memberId: viewerId, budgetNanoUsd: 500n, spentNanoUsd: 100n });
    await db
      .insert(memberBudgets)
      .values({ memberId: otherId, budgetNanoUsd: 700n, spentNanoUsd: 0n });

    const response = await send('GET', `/conversations/${conversationId}/budgets`, viewer.cookie);
    expect(response.status).toBe(200);
    const body: {
      conversationCapNanoUsd: string;
      conversationSpentNanoUsd: string;
      ownerBalanceNanoUsd: string;
      members: { memberId: string; effectiveRemainingNanoUsd: string }[];
    } = await response.json();

    // Conversation-level figures stay visible (they interpret the effective remaining).
    expect(body.conversationCapNanoUsd).toBe('2000');
    expect(body.conversationSpentNanoUsd).toBe('300');
    // The owner's raw balance is exposed even to a non-owner viewer — deliberate
    // legacy parity: the legacy handler returned `ownerBalanceDollars` to any member.
    expect(body.ownerBalanceNanoUsd).toBe('1000');
    // Only the caller's own row — a non-owner never sees another member's figures.
    expect(body.members).toHaveLength(1);
    expect(body.members[0]?.memberId).toBe(viewerId);
    expect(body.members.some((m) => m.memberId === otherId)).toBe(false);
    // viewer: min(500-100=400, 2000-300=1700, 1000) = 400.
    expect(body.members[0]?.effectiveRemainingNanoUsd).toBe('400');
  });

  it('refuses a stranger on the display, set-member-cap, and set-conversation-cap', async () => {
    const owner = await newUser();
    const target = await newUser();
    const stranger = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: target.userId, privilege: 'write' },
    ]);
    const targetId = memberIds.get(target.userId)!;

    const display = await send('GET', `/conversations/${conversationId}/budgets`, stranger.cookie);
    const setMember = await send(
      'PUT',
      `/conversations/${conversationId}/member/${targetId}/budget`,
      stranger.cookie,
      { capNanoUsd: '500' }
    );
    const setConversation = await send(
      'PUT',
      `/conversations/${conversationId}/budget`,
      stranger.cookie,
      { capNanoUsd: '500' }
    );

    expect(display.status).toBe(403);
    expect(setMember.status).toBe(403);
    expect(setConversation.status).toBe(403);
  });

  it('returns caps, spend, owner balance, and effective remaining, excluding the owner', async () => {
    const owner = await newUser();
    const memberA = await newUser();
    const memberB = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: memberA.userId, privilege: 'write' },
      { userId: memberB.userId, privilege: 'write' },
    ]);
    const memberAId = memberIds.get(memberA.userId)!;
    const memberBId = memberIds.get(memberB.userId)!;

    await seedPurchasedWallet(owner.userId, 1000n);
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 2000n })
      .where(eq(conversations.id, conversationId));
    await db.insert(conversationSpending).values({ conversationId, spentNanoUsd: 300n });
    await db
      .insert(memberBudgets)
      .values({ memberId: memberAId, budgetNanoUsd: 500n, spentNanoUsd: 100n });
    await db
      .insert(memberBudgets)
      .values({ memberId: memberBId, budgetNanoUsd: 700n, spentNanoUsd: 0n });

    const response = await send('GET', `/conversations/${conversationId}/budgets`, owner.cookie);
    expect(response.status).toBe(200);
    const body: {
      conversationCapNanoUsd: string;
      conversationSpentNanoUsd: string;
      ownerBalanceNanoUsd: string;
      members: {
        memberId: string;
        privilege: string;
        capNanoUsd: string;
        spentNanoUsd: string;
        effectiveRemainingNanoUsd: string;
      }[];
    } = await response.json();

    expect(body.conversationCapNanoUsd).toBe('2000');
    expect(body.conversationSpentNanoUsd).toBe('300');
    expect(body.ownerBalanceNanoUsd).toBe('1000');
    // The owner is excluded from the member list.
    expect(body.members).toHaveLength(2);
    expect(body.members.some((m) => m.privilege === 'owner')).toBe(false);

    const a = body.members.find((m) => m.memberId === memberAId);
    const b = body.members.find((m) => m.memberId === memberBId);
    // min(member cap remaining, conversation cap remaining, owner balance).
    // A: min(500-100=400, 2000-300=1700, 1000) = 400.
    expect(a).toMatchObject({
      capNanoUsd: '500',
      spentNanoUsd: '100',
      effectiveRemainingNanoUsd: '400',
    });
    // B: min(700, 1700, 1000) = 700.
    expect(b).toMatchObject({
      capNanoUsd: '700',
      spentNanoUsd: '0',
      effectiveRemainingNanoUsd: '700',
    });
  });

  it('rejects a negative cap at the boundary (400)', async () => {
    const owner = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
    ]);
    // Reuse the owner's own membership id — validation fires before any lookup.
    const ownerMemberId = memberIds.get(owner.userId)!;

    const member = await send(
      'PUT',
      `/conversations/${conversationId}/member/${ownerMemberId}/budget`,
      owner.cookie,
      { capNanoUsd: '-5' }
    );
    const conversation = await send(
      'PUT',
      `/conversations/${conversationId}/budget`,
      owner.cookie,
      {
        capNanoUsd: '-1',
      }
    );

    expect(member.status).toBe(400);
    expect(conversation.status).toBe(400);
  });

  it('answers not-found for a missing conversation and a non-member target', async () => {
    const owner = await newUser();
    const { conversationId } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
    ]);

    const missingConversation = await send(
      'PUT',
      `/conversations/${crypto.randomUUID()}/budget`,
      owner.cookie,
      { capNanoUsd: '100' }
    );
    const nonMemberTarget = await send(
      'PUT',
      `/conversations/${conversationId}/member/${crypto.randomUUID()}/budget`,
      owner.cookie,
      { capNanoUsd: '100' }
    );
    // A member-cap set on a conversation that does not exist at all.
    const missingConversationMember = await send(
      'PUT',
      `/conversations/${crypto.randomUUID()}/member/${crypto.randomUUID()}/budget`,
      owner.cookie,
      { capNanoUsd: '100' }
    );

    const missingDisplay = await send(
      'GET',
      `/conversations/${crypto.randomUUID()}/budgets`,
      owner.cookie
    );

    expect(missingConversation.status).toBe(404);
    expect(nonMemberTarget.status).toBe(404);
    expect(missingConversationMember.status).toBe(404);
    expect(missingDisplay.status).toBe(404);
  });

  it('binds effective remaining on the owner balance, clamps overspend, and treats an absent row as zero', async () => {
    const owner = await newUser();
    const overspent = await newUser();
    const unconfigured = await newUser();
    const funded = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: overspent.userId, privilege: 'write' },
      { userId: unconfigured.userId, privilege: 'write' },
      { userId: funded.userId, privilege: 'write' },
    ]);
    const overspentId = memberIds.get(overspent.userId)!;
    const unconfiguredId = memberIds.get(unconfigured.userId)!;
    const fundedId = memberIds.get(funded.userId)!;

    // No owner wallet seeded → owner balance reads as 0 (the `?? 0n` branch).
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: 100_000n })
      .where(eq(conversations.id, conversationId));
    // Overspent: spent exceeds cap → remaining clamps to 0.
    await db
      .insert(memberBudgets)
      .values({ memberId: overspentId, budgetNanoUsd: 100n, spentNanoUsd: 250n });
    // `funded` has ample cap; the owner's 0 balance is the binding constraint.
    await db
      .insert(memberBudgets)
      .values({ memberId: fundedId, budgetNanoUsd: 100_000n, spentNanoUsd: 0n });
    // `unconfigured` has no row at all → cap 0, spend 0.

    const response = await send('GET', `/conversations/${conversationId}/budgets`, owner.cookie);
    expect(response.status).toBe(200);
    const body: {
      ownerBalanceNanoUsd: string;
      members: {
        memberId: string;
        capNanoUsd: string;
        spentNanoUsd: string;
        effectiveRemainingNanoUsd: string;
      }[];
    } = await response.json();

    expect(body.ownerBalanceNanoUsd).toBe('0');
    const find = (id: string): (typeof body.members)[number] => {
      const row = body.members.find((m) => m.memberId === id);
      if (row === undefined) throw new Error('member row missing');
      return row;
    };
    expect(find(overspentId)).toMatchObject({
      capNanoUsd: '100',
      spentNanoUsd: '250',
      effectiveRemainingNanoUsd: '0',
    });
    expect(find(unconfiguredId)).toMatchObject({
      capNanoUsd: '0',
      spentNanoUsd: '0',
      effectiveRemainingNanoUsd: '0',
    });
    // funded: member remaining 100000, conversation remaining 100000, owner 0 → 0.
    expect(find(fundedId)).toMatchObject({
      capNanoUsd: '100000',
      spentNanoUsd: '0',
      effectiveRemainingNanoUsd: '0',
    });
  });
});

describe('hold-aware effective remaining', () => {
  const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  const billingStores = createBillingStores();
  const admissionDeps = { redis, db, stores: billingStores };
  const RUN_CAP = 5;

  /** The production scope resolution — tests never hand-build scope ids. */
  async function resolveScopesFor(params: {
    memberId: string;
    conversationId: string;
    conversationCap: bigint;
    now: Date;
  }): Promise<readonly BudgetScope[]> {
    const resolved = await resolveBudgetScopes(billingStores, db, {
      now: params.now,
      memberBudget: { memberId: params.memberId },
      conversationBudget: {
        conversationId: params.conversationId,
        capNanoUsd: params.conversationCap,
      },
    });
    return resolved._unsafeUnwrap();
  }

  it('serves a remaining under an active scope hold that equals exactly what admission would allow', async () => {
    const owner = await newUser();
    const member = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: member.userId, privilege: 'write' },
    ]);
    const memberId = memberIds.get(member.userId)!;
    const ownerWalletId = await seedPurchasedWallet(owner.userId, 100_000_000_000n);
    const conversationCap = 2_000_000_000n;
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: conversationCap })
      .where(eq(conversations.id, conversationId));
    await db
      .insert(memberBudgets)
      .values({ memberId, budgetNanoUsd: 1_000_000_000n, spentNanoUsd: 0n });

    // Place a REAL admission hold over the same group scopes a run would gate
    // on — the production scope resolution, never hand-built scope ids.
    const now = new Date();
    const scopes = await resolveScopesFor({ memberId, conversationId, conversationCap, now });
    const holdId = crypto.randomUUID();
    const estimate = 300_000_000n;
    const admitted = await admitRun(admissionDeps, {
      walletId: ownerWalletId,
      holdId,
      estimateNanoUsd: estimate,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);

    const response = await send('GET', `/conversations/${conversationId}/budgets`, owner.cookie);
    expect(response.status).toBe(200);
    const body: { members: { effectiveRemainingNanoUsd: string }[] } = await response.json();
    expect(body.members).toHaveLength(1);
    const served = BigInt(body.members[0]?.effectiveRemainingNanoUsd ?? 'missing');
    // The member dimension binds: 1e9 cap − 0 spent − 3e8 held = 7e8 (the
    // conversation dimension is 1.7e9 after the hold; owner balance $100).
    expect(served).toBe(700_000_000n);

    // Behavioral pin: the served remaining IS the admission gate — one nano
    // more refuses on the budget scope, exactly the served amount admits.
    const scopesAfter = await resolveScopesFor({ memberId, conversationId, conversationCap, now });
    const over = await admitRun(admissionDeps, {
      walletId: ownerWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served + 1n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopesAfter,
      now,
    });
    expect(over._unsafeUnwrap()).toEqual({ admitted: false, reason: 'budget-exceeded' });
    const secondHoldId = crypto.randomUUID();
    const at = await admitRun(admissionDeps, {
      walletId: ownerWalletId,
      holdId: secondHoldId,
      estimateNanoUsd: served,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopesAfter,
      now,
    });
    expect(at._unsafeUnwrap().admitted).toBe(true);

    const scopeIds = scopes.map((scope) => scope.scopeId);
    const firstRelease = await releaseHold(redis, { walletId: ownerWalletId, holdId, scopeIds });
    firstRelease._unsafeUnwrap();
    const secondRelease = await releaseHold(redis, {
      walletId: ownerWalletId,
      holdId: secondHoldId,
      scopeIds,
    });
    secondRelease._unsafeUnwrap();
  });

  it('pairs each member with their OWN held sum (distinct per-scope amounts)', async () => {
    // Pins the positional holds↔memberRows pairing: two members with DIFFERENT
    // held amounts (two runs of different estimates against different scope
    // sets), so an index-off pairing (member A shown member B's held sum, or a
    // member shown the conversation's) cannot pass.
    const owner = await newUser();
    const memberA = await newUser();
    const memberB = await newUser();
    const { conversationId, memberIds } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: memberA.userId, privilege: 'write' },
      { userId: memberB.userId, privilege: 'write' },
    ]);
    const memberAId = memberIds.get(memberA.userId)!;
    const memberBId = memberIds.get(memberB.userId)!;
    const ownerWalletId = await seedPurchasedWallet(owner.userId, 100_000_000_000n);
    const conversationCap = 10_000_000_000n;
    await db
      .update(conversations)
      .set({ conversationBudgetNanoUsd: conversationCap })
      .where(eq(conversations.id, conversationId));
    await db
      .insert(memberBudgets)
      .values({ memberId: memberAId, budgetNanoUsd: 1_000_000_000n, spentNanoUsd: 0n });
    await db
      .insert(memberBudgets)
      .values({ memberId: memberBId, budgetNanoUsd: 2_000_000_000n, spentNanoUsd: 0n });

    const now = new Date();
    // Run 1 holds 3e8 against {member A, conversation}; run 2 holds 5e8
    // against {member B, conversation}. Held sums: A=3e8, B=5e8, conv=8e8 —
    // all pairwise distinct, so any transposed readout changes an assertion.
    const scopesA = await resolveScopesFor({
      memberId: memberAId,
      conversationId,
      conversationCap,
      now,
    });
    const scopesB = await resolveScopesFor({
      memberId: memberBId,
      conversationId,
      conversationCap,
      now,
    });
    const holdIdA = crypto.randomUUID();
    const holdIdB = crypto.randomUUID();
    const admittedA = await admitRun(admissionDeps, {
      walletId: ownerWalletId,
      holdId: holdIdA,
      estimateNanoUsd: 300_000_000n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopesA,
      now,
    });
    expect(admittedA._unsafeUnwrap().admitted).toBe(true);
    const admittedB = await admitRun(admissionDeps, {
      walletId: ownerWalletId,
      holdId: holdIdB,
      estimateNanoUsd: 500_000_000n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopesB,
      now,
    });
    expect(admittedB._unsafeUnwrap().admitted).toBe(true);

    try {
      const response = await send('GET', `/conversations/${conversationId}/budgets`, owner.cookie);
      expect(response.status).toBe(200);
      const body: { members: { memberId: string; effectiveRemainingNanoUsd: string }[] } =
        await response.json();
      expect(body.members).toHaveLength(2);
      const remainingOf = (id: string): string => {
        const row = body.members.find((m) => m.memberId === id);
        if (row === undefined) throw new Error('member row missing');
        return row.effectiveRemainingNanoUsd;
      };
      // A: min(1e9 − 0 − 3e8 = 7e8, 10e9 − 0 − 8e8 = 9.2e9, 100e9) = 7e8.
      expect(remainingOf(memberAId)).toBe('700000000');
      // B: min(2e9 − 0 − 5e8 = 1.5e9, 9.2e9, 100e9) = 1.5e9.
      expect(remainingOf(memberBId)).toBe('1500000000');
    } finally {
      const releaseA = await releaseHold(redis, {
        walletId: ownerWalletId,
        holdId: holdIdA,
        scopeIds: scopesA.map((scope) => scope.scopeId),
      });
      releaseA._unsafeUnwrap();
      const releaseB = await releaseHold(redis, {
        walletId: ownerWalletId,
        holdId: holdIdB,
        scopeIds: scopesB.map((scope) => scope.scopeId),
      });
      releaseB._unsafeUnwrap();
    }
  });

  it('reads every scope hold in one Redis script exec (M+1 hashes, one round trip)', async () => {
    const owner = await newUser();
    const memberA = await newUser();
    const memberB = await newUser();
    const { conversationId } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
      { userId: memberA.userId, privilege: 'write' },
      { userId: memberB.userId, privilege: 'write' },
    ]);
    await seedPurchasedWallet(owner.userId, 1000n);

    let execs = 0;
    // A counting seam over the real client: Redis is a true external seam, so
    // instrumenting the script path (not any internal slice) is legitimate.
    const counting = {
      createScript: (source: string) => {
        const script = redis.createScript(source);
        return {
          exec: (keys: string[], args: string[]): Promise<unknown> => {
            execs += 1;
            return script.exec(keys, args);
          },
        };
      },
    } as unknown as Redis;

    const result = await getConversationBudgets(
      { stores: createConversationsStores(db), billing: billingStores, db, redis: counting },
      { conversationId, callerUserId: owner.userId, now: new Date() }
    );
    const view = result._unsafeUnwrap();
    if (!('members' in view)) throw new Error('expected the budgets view, got a refusal');
    // Owner viewer: two member rows + the conversation scope = 3 hashes, 1 exec.
    expect(view.members).toHaveLength(2);
    expect(execs).toBe(1);
  });

  it('fails closed with a typed 503 when Redis is down', async () => {
    const owner = await newUser();
    const { conversationId } = await seedConversation(owner.userId, [
      { userId: owner.userId, privilege: 'owner' },
    ]);
    await seedPurchasedWallet(owner.userId, 1000n);
    const deadEnv = { ...testEnv, UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:9' };

    const response = await app.request(
      `/conversations/${conversationId}/budgets`,
      { headers: { cookie: owner.cookie } },
      deadEnv
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'UNAVAILABLE' });
  });
});
