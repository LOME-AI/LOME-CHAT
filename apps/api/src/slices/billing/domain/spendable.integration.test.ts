import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { eq, inArray } from 'drizzle-orm';
import { spendableFundsNanoUsd } from '@hushbox/shared';
import {
  LOCAL_NEON_DEV_CONFIG,
  allowanceSpending,
  conversationMembers,
  conversationSpending,
  conversations,
  createDb,
  memberBudgets,
  users,
  wallets,
} from '@hushbox/db';
import { okAsync } from '../../../lib/result/index.js';
import { sweepLeakedTestWallets } from '../__tests__/orphan-wallet-sweep.js';
import { createBillingStores } from '../adapters/stores.js';
import { BILLING_KEYS } from './keys.js';
import { admitRun } from './admission.js';
import { DAILY_ALLOWANCE_NANO_USD } from './constants.js';
import { utcDayKey } from './period.js';
import {
  conversationBudgetScopeId,
  memberBudgetScopeId,
  resolveBudgetScopes,
} from './budget-resolution.js';
import {
  holdReadoutAt,
  readActiveHolds,
  readBudgetScopeHolds,
  readFundingSnapshot,
  readGuestFundingSnapshot,
} from './spendable.js';
import type { AdmissionDeps, BudgetScope } from './admission.js';
import type {
  BudgetScopeHoldRef,
  ConversationFundingFacts,
  ConversationFundingReader,
  FundingSnapshot,
} from './spendable.js';
import type { WalletType } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error(
    'DATABASE_URL, UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for spendable tests'
  );
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
const deadRedis = new Redis({ url: 'http://localhost:1', token: 'token', retry: false });
const stores = createBillingStores();
const deps: AdmissionDeps = { redis, db, stores };
const NOW = new Date('2026-07-03T12:00:00Z');
/** The next UTC calendar day — a different allowance day key, same seeded rows. */
const NEXT_DAY = new Date('2026-07-04T00:00:01Z');
const RUN_CAP = 5;

/** The one scope id an allowance-only resolve yields, for keying its holds hash. */
function soleScopeId(scopes: readonly BudgetScope[]): string {
  const scopeId = scopes[0]?.scopeId;
  if (scopeId === undefined || scopes.length !== 1) {
    throw new Error('allowance resolve should yield exactly one scope');
  }
  return scopeId;
}

const BYTES = new Uint8Array([1, 2, 3]);
const createdUserIds: string[] = [];
const createdWalletIds: string[] = [];
const createdConversationIds: string[] = [];

async function createUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const rows = await db
    .insert(users)
    .values({
      email: `spend${suffix}@spendable.test`,
      username: `spend${suffix}`,
      opaqueRegistration: BYTES,
      publicKey: BYTES,
      passwordWrappedPrivateKey: BYTES,
      recoveryWrappedPrivateKey: BYTES,
    })
    .returning({ id: users.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user seed failed');
  createdUserIds.push(id);
  return id;
}

async function seedWallet(
  userId: string,
  balanceNanoUsd: bigint,
  type: WalletType = 'purchased'
): Promise<string> {
  const rows = await db
    .insert(wallets)
    .values({ userId, type, balanceNanoUsd, ledgerSeq: 0n })
    .returning({ id: wallets.id });
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('wallet seed failed');
  createdWalletIds.push(id);
  return id;
}

/**
 * The composition-root reader, stubbed at its port seam: it answers the facts
 * the conversations slice would resolve. `unusedReader` throws, so a test
 * asserting the self-funded arm also proves no conversation read is issued.
 */
function factsReader(facts: ConversationFundingFacts | null): ConversationFundingReader {
  return () => okAsync(facts);
}

const unusedReader: ConversationFundingReader = () => {
  throw new Error('conversation funding read issued without a conversation id');
};

async function view(userId: string): Promise<FundingSnapshot> {
  const result = await readFundingSnapshot(deps, {
    userId,
    conversationFunding: unusedReader,
    now: NOW,
  });
  return result._unsafeUnwrap();
}

beforeAll(async () => {
  await sweepLeakedTestWallets(db);
});

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    // The member-budget and conversation-spending rows cascade from here.
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdWalletIds.length > 0) {
    await Promise.all(
      createdWalletIds.map((walletId) =>
        redis.del(
          BILLING_KEYS.walletSnapshot.buildKey(walletId),
          BILLING_KEYS.walletHolds.buildKey(walletId)
        )
      )
    );
    await db.delete(wallets).where(inArray(wallets.id, createdWalletIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('readActiveHolds', () => {
  it('sums active holds per key', async () => {
    const key = BILLING_KEYS.walletHolds.buildKey(`ah-${crypto.randomUUID()}`);
    const active = String(NOW.getTime() + 60_000);
    await redis.hset(key, { a: `100:${active}`, b: `250:${active}` });
    const result = await readActiveHolds(redis, [key], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 350n }]);
    await redis.del(key);
  });

  it('prunes expired holds on read and excludes them from the sum', async () => {
    const key = BILLING_KEYS.walletHolds.buildKey(`ah-${crypto.randomUUID()}`);
    await redis.hset(key, {
      live: `100:${String(NOW.getTime() + 60_000)}`,
      gone: `900:${String(NOW.getTime() - 1)}`,
    });
    const result = await readActiveHolds(redis, [key], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 100n }]);
    expect(await redis.hgetall(key)).toEqual({ live: `100:${String(NOW.getTime() + 60_000)}` });
    await redis.del(key);
  });

  it('reads an absent hash as zero holds', async () => {
    const key = BILLING_KEYS.walletHolds.buildKey(`ah-${crypto.randomUUID()}`);
    const result = await readActiveHolds(redis, [key], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 0n }]);
  });

  it('reads multiple keys in one round trip, pairing each key with its own readout', async () => {
    const first = BILLING_KEYS.scopeHolds.buildKey(`ah-${crypto.randomUUID()}`);
    const second = BILLING_KEYS.scopeHolds.buildKey(`ah-${crypto.randomUUID()}`);
    await redis.hset(first, { a: `7:${String(NOW.getTime() + 60_000)}` });
    const result = await readActiveHolds(redis, [first, second], NOW);
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: 7n }, { heldNanoUsd: 0n }]);
    await redis.del(first);
  });

  it('answers an empty key list without touching Redis', async () => {
    const result = await readActiveHolds(deadRedis, [], NOW);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const result = await readActiveHolds(deadRedis, ['billing:admission:wallet:x'], NOW);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('readBudgetScopeHolds', () => {
  it('reads the member and conversation scope holds admission places, one readout per ref in order', async () => {
    const memberId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const userId = await createUser();
    const walletId = await seedWallet(userId, 10_000_000_000n);
    const estimate = 300_000_000n;
    const memberScopeKey = BILLING_KEYS.scopeHolds.buildKey(memberBudgetScopeId(memberId));
    const conversationScopeKey = BILLING_KEYS.scopeHolds.buildKey(
      conversationBudgetScopeId(conversationId)
    );

    const admitted = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: estimate,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [
        { scopeId: memberBudgetScopeId(memberId), remainingNanoUsd: 1_000_000_000n },
        { scopeId: conversationBudgetScopeId(conversationId), remainingNanoUsd: 2_000_000_000n },
      ],
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);

    const result = await readBudgetScopeHolds(
      redis,
      [
        { scope: 'member', memberId },
        { scope: 'conversation', conversationId },
      ],
      NOW
    );
    expect(result._unsafeUnwrap()).toEqual([{ heldNanoUsd: estimate }, { heldNanoUsd: estimate }]);
    await redis.del(memberScopeKey, conversationScopeKey);
  });

  it('issues exactly one Redis script exec regardless of the number of scopes', async () => {
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
    } as unknown as typeof redis;

    const scopes: BudgetScopeHoldRef[] = [
      { scope: 'conversation', conversationId: crypto.randomUUID() },
      { scope: 'member', memberId: crypto.randomUUID() },
      { scope: 'member', memberId: crypto.randomUUID() },
    ];
    const result = await readBudgetScopeHolds(counting, scopes, NOW);
    expect(result._unsafeUnwrap()).toHaveLength(3);
    expect(execs).toBe(1);
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const result = await readBudgetScopeHolds(
      deadRedis,
      [{ scope: 'member', memberId: crypto.randomUUID() }],
      NOW
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('holdReadoutAt', () => {
  it('returns the readout at the index', () => {
    expect(holdReadoutAt([{ heldNanoUsd: 5n }], 0)).toEqual({ heldNanoUsd: 5n });
  });

  it('throws on a missing readout — a defect, never a legal state', () => {
    expect(() => holdReadoutAt([], 0)).toThrow('holds readout missing');
  });
});

describe('readFundingSnapshot — owner-funded means owner-priced (BILLING §Group Funding 1)', () => {
  const OWNER_BALANCE = 5_000_000_000n; // $5 in the owner's purchased wallet
  const MEMBER_CAP = 900_000_000n; // $0.90 per-member allowance
  const CONVERSATION_CAP = 4_000_000_000n; // $4 conversation allowance

  /**
   * A group conversation whose sender is a FREE-tier member (zero balance):
   * every served figure must be the owner's, so a sender-scoped read is
   * detectable by value alone.
   */
  interface GroupSeedOptions {
    ownerBalanceNanoUsd?: bigint;
    memberCapNanoUsd?: bigint;
    memberSpentNanoUsd?: bigint;
    conversationCapNanoUsd?: bigint;
    conversationSpentNanoUsd?: bigint;
    /** Omits the durable member-budget row entirely (an unconfigured member). */
    withoutMemberBudget?: boolean;
    /** Omits the owner's purchased wallet (no pool for the group to draw). */
    withoutOwnerWallet?: boolean;
  }

  /** Resolved seed values, so the seeder itself carries no default branches. */
  function seedValues(options: GroupSeedOptions): {
    ownerBalanceNanoUsd: bigint;
    memberCapNanoUsd: bigint;
    memberSpentNanoUsd: bigint;
    conversationCapNanoUsd: bigint;
    conversationSpentNanoUsd: bigint;
    withMemberBudget: boolean;
    withOwnerWallet: boolean;
  } {
    return {
      ownerBalanceNanoUsd: options.ownerBalanceNanoUsd ?? OWNER_BALANCE,
      memberCapNanoUsd: options.memberCapNanoUsd ?? MEMBER_CAP,
      memberSpentNanoUsd: options.memberSpentNanoUsd ?? 0n,
      conversationCapNanoUsd: options.conversationCapNanoUsd ?? CONVERSATION_CAP,
      conversationSpentNanoUsd: options.conversationSpentNanoUsd ?? 0n,
      withMemberBudget: options.withoutMemberBudget !== true,
      withOwnerWallet: options.withoutOwnerWallet !== true,
    };
  }

  async function seedGroup(options: GroupSeedOptions = {}): Promise<{
    senderUserId: string;
    ownerUserId: string;
    ownerWalletId: string | null;
    conversation: ConversationFundingFacts;
  }> {
    const seed = seedValues(options);
    const ownerUserId = await createUser();
    const senderUserId = await createUser();
    const ownerWalletId = seed.withOwnerWallet
      ? await seedWallet(ownerUserId, seed.ownerBalanceNanoUsd)
      : null;
    // The sender's own wallets: a zero purchased balance makes them free-tier,
    // so a served `tier: 'paid'` can only have come from the owner.
    await seedWallet(senderUserId, 0n);
    const conversationId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId: ownerUserId,
      title: BYTES,
      conversationBudgetNanoUsd: seed.conversationCapNanoUsd,
    });
    createdConversationIds.push(conversationId);
    const memberRows = await db
      .insert(conversationMembers)
      .values({
        conversationId,
        userId: senderUserId,
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: NOW,
      })
      .returning({ id: conversationMembers.id });
    const memberId = memberRows[0]?.id;
    if (memberId === undefined) throw new Error('member seed failed');
    if (seed.withMemberBudget) {
      await db.insert(memberBudgets).values({
        memberId,
        budgetNanoUsd: seed.memberCapNanoUsd,
        spentNanoUsd: seed.memberSpentNanoUsd,
      });
    }
    await db.insert(conversationSpending).values({
      conversationId,
      spentNanoUsd: seed.conversationSpentNanoUsd,
    });
    return {
      senderUserId,
      ownerUserId,
      ownerWalletId,
      conversation: {
        conversationId,
        memberId,
        ownerUserId,
        conversationBudgetNanoUsd: seed.conversationCapNanoUsd,
      },
    };
  }

  async function snapshot(
    userId: string,
    conversation?: ConversationFundingFacts
  ): Promise<FundingSnapshot> {
    const result = await readFundingSnapshot(deps, {
      userId,
      ...(conversation === undefined ? {} : { conversationId: conversation.conversationId }),
      conversationFunding: factsReader(conversation ?? null),
      now: NOW,
    });
    return result._unsafeUnwrap();
  }

  it("serves the group's hold-aware remaining, not the sender's own wallet", async () => {
    const group = await seedGroup({ memberSpentNanoUsd: 100_000_000n });
    const served = await snapshot(group.senderUserId, group.conversation);
    // The member dimension binds: $0.90 cap − $0.10 spent = $0.80, below both
    // the conversation allowance and the owner's balance.
    expect(served.spendableNanoUsd).toBe(800_000_000n);
  });

  it("serves the PAYER's tier, not the free-tier sender's", async () => {
    const group = await seedGroup();
    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.payerTier).toBe('paid');
  });

  it('names the owner as the payer of a funded group turn', async () => {
    const group = await seedGroup();
    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.payer).toBe('owner');
  });

  it('subtracts an active member-scope hold from the served group remaining', async () => {
    const group = await seedGroup();
    const estimate = 300_000_000n;
    const scopeKey = BILLING_KEYS.scopeHolds.buildKey(
      memberBudgetScopeId(group.conversation.memberId)
    );
    await redis.hset(scopeKey, { run: `${String(estimate)}:${String(NOW.getTime() + 60_000)}` });

    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.spendableNanoUsd).toBe(MEMBER_CAP - estimate);
    await redis.del(scopeKey);
  });

  it('reports the held amount as exactly what holds took off the group remaining', async () => {
    const group = await seedGroup();
    const estimate = 250_000_000n;
    const scopeKey = BILLING_KEYS.scopeHolds.buildKey(
      conversationBudgetScopeId(group.conversation.conversationId)
    );
    await redis.hset(scopeKey, { run: `${String(estimate)}:${String(NOW.getTime() + 60_000)}` });

    const served = await snapshot(group.senderUserId, group.conversation);
    // The conversation dimension ($4 − $0.25) still exceeds the member cap, so
    // the min does not move: holds that do not bind report as zero held.
    expect(served.heldNanoUsd).toBe(0n);
    await redis.del(scopeKey);
  });

  it('reports the binding hold as held, so spendable + held is the hold-blind remaining', async () => {
    const group = await seedGroup();
    const estimate = 300_000_000n;
    const scopeKey = BILLING_KEYS.scopeHolds.buildKey(
      memberBudgetScopeId(group.conversation.memberId)
    );
    await redis.hset(scopeKey, { run: `${String(estimate)}:${String(NOW.getTime() + 60_000)}` });

    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.spendableNanoUsd + served.heldNanoUsd).toBe(MEMBER_CAP);
    await redis.del(scopeKey);
  });

  it('serves the figure admission gates the group turn on', async () => {
    const group = await seedGroup({ memberSpentNanoUsd: 100_000_000n });
    const served = await snapshot(group.senderUserId, group.conversation);
    const scopes = [
      { scopeId: memberBudgetScopeId(group.conversation.memberId), remainingNanoUsd: 800_000_000n },
      {
        scopeId: conversationBudgetScopeId(group.conversation.conversationId),
        remainingNanoUsd: CONVERSATION_CAP,
      },
    ];
    if (group.ownerWalletId === null) throw new Error('owner wallet expected');
    const refused = await admitRun(deps, {
      walletId: group.ownerWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd + 1n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(refused._unsafeUnwrap()).toEqual({ admitted: false, reason: 'budget-exceeded' });
    const admitted = await admitRun(deps, {
      walletId: group.ownerWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);
    await redis.del(
      BILLING_KEYS.scopeHolds.buildKey(memberBudgetScopeId(group.conversation.memberId)),
      BILLING_KEYS.scopeHolds.buildKey(
        conversationBudgetScopeId(group.conversation.conversationId)
      ),
      BILLING_KEYS.walletHolds.buildKey(group.ownerWalletId),
      BILLING_KEYS.walletSnapshot.buildKey(group.ownerWalletId)
    );
  });

  it('falls back to the sender as payer once the group allowance is exhausted', async () => {
    const group = await seedGroup({ memberSpentNanoUsd: MEMBER_CAP });
    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.payer).toBe('self');
  });

  it("serves the sender's own free-tier figures on fall-through", async () => {
    const group = await seedGroup({ memberSpentNanoUsd: MEMBER_CAP });
    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.payerTier).toBe('free');
  });

  it('treats a negative owner balance as zero group headroom (BILLING §Group Funding 6e)', async () => {
    const group = await seedGroup({ ownerBalanceNanoUsd: -1_000_000n });
    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.payer).toBe('self');
  });

  it('reads an unconfigured member budget as zero headroom, never unlimited', async () => {
    const group = await seedGroup({ withoutMemberBudget: true });
    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.payer).toBe('self');
  });

  it('reads an owner with no purchased wallet as zero headroom', async () => {
    const group = await seedGroup({ withoutOwnerWallet: true });
    const served = await snapshot(group.senderUserId, group.conversation);
    expect(served.payer).toBe('self');
  });

  it('serves the caller as payer when the conversation has no group funding for them', async () => {
    // What an owner (or a non-member) resolves to: the conversations read
    // answers null, so the caller's own wallet is the payer.
    const userId = await createUser();
    await seedWallet(userId, 1_000_000_000n);
    const result = await readFundingSnapshot(deps, {
      userId,
      conversationId: crypto.randomUUID(),
      conversationFunding: factsReader(null),
      now: NOW,
    });
    expect(result._unsafeUnwrap().payer).toBe('self');
  });

  it('serves the caller as payer when no conversation context is given', async () => {
    const userId = await createUser();
    await seedWallet(userId, 1_000_000_000n);
    const served = await snapshot(userId);
    expect(served.payer).toBe('self');
  });

  it("serves the caller's own tier when no conversation context is given", async () => {
    const userId = await createUser();
    await seedWallet(userId, 1_000_000_000n);
    const served = await snapshot(userId);
    expect(served.payerTier).toBe('paid');
  });

  it('serves the free tier for a caller with a zero purchased balance', async () => {
    const userId = await createUser();
    await seedWallet(userId, 0n);
    const served = await snapshot(userId);
    expect(served.payerTier).toBe('free');
  });

  it('fails closed with a typed unavailable error when Redis is down mid-group-read', async () => {
    const group = await seedGroup();
    const result = await readFundingSnapshot(
      { redis: deadRedis, db, stores },
      {
        userId: group.senderUserId,
        conversationId: group.conversation.conversationId,
        conversationFunding: factsReader(group.conversation),
        now: NOW,
      }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('readGuestFundingSnapshot — a link guest is served its payer (BILLING §Group Funding 1, 6)', () => {
  const OWNER_BALANCE = 5_000_000_000n; // $5 in the owner's purchased wallet
  const LINK_ALLOWANCE = 900_000_000n; // $0.90 allocated to the link's member row

  /**
   * A conversation whose owner funds it and one member row carrying the link's
   * allowance. The row is seeded as a plain member because the producer
   * consumes only its `memberId` — whether that row belongs to a user or to a
   * shared link is resolved a layer up, and the route tests exercise the real
   * link-guest row end to end.
   */
  async function seedFundedLink(
    options: { linkAllowanceNanoUsd?: bigint; ownerBalanceNanoUsd?: bigint } = {}
  ): Promise<{ ownerWalletId: string; conversation: ConversationFundingFacts }> {
    const ownerUserId = await createUser();
    const ownerWalletId = await seedWallet(
      ownerUserId,
      options.ownerBalanceNanoUsd ?? OWNER_BALANCE
    );
    const conversationId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: conversationId,
      userId: ownerUserId,
      title: BYTES,
      conversationBudgetNanoUsd: 4_000_000_000n,
    });
    createdConversationIds.push(conversationId);
    const memberRows = await db
      .insert(conversationMembers)
      .values({
        conversationId,
        userId: await createUser(),
        privilege: 'write',
        visibleFromEpoch: 1,
        acceptedAt: NOW,
      })
      .returning({ id: conversationMembers.id });
    const memberId = memberRows[0]?.id;
    if (memberId === undefined) throw new Error('member seed failed');
    await db.insert(memberBudgets).values({
      memberId,
      budgetNanoUsd: options.linkAllowanceNanoUsd ?? LINK_ALLOWANCE,
      spentNanoUsd: 0n,
    });
    await db.insert(conversationSpending).values({ conversationId, spentNanoUsd: 0n });
    return {
      ownerWalletId,
      conversation: {
        conversationId,
        memberId,
        ownerUserId,
        conversationBudgetNanoUsd: 4_000_000_000n,
      },
    };
  }

  it("serves the owner as payer, at the owner's tier", async () => {
    const seeded = await seedFundedLink();
    const served = await readGuestFundingSnapshot(deps, {
      conversation: seeded.conversation,
      now: NOW,
    });
    expect(served._unsafeUnwrap().payer).toBe('owner');
    expect(served._unsafeUnwrap().payerTier).toBe('paid');
  });

  it("serves the link's hold-aware remaining as the guest's spendable", async () => {
    const seeded = await seedFundedLink();
    const served = await readGuestFundingSnapshot(deps, {
      conversation: seeded.conversation,
      now: NOW,
    });
    expect(served._unsafeUnwrap().spendableNanoUsd).toBe(LINK_ALLOWANCE);
  });

  it('serves an unallocated link zero spendable, never unlimited', async () => {
    const seeded = await seedFundedLink({ linkAllowanceNanoUsd: 0n });
    const served = await readGuestFundingSnapshot(deps, {
      conversation: seeded.conversation,
      now: NOW,
    });
    expect(served._unsafeUnwrap().spendableNanoUsd).toBe(0n);
  });

  it('serves the figure admission gates the guest turn on', async () => {
    // The two-sided pin: the served number IS the gate. An estimate of exactly
    // the served spendable admits; one nano more refuses. Nothing between the
    // read and the gate may re-derive it.
    const seeded = await seedFundedLink();
    const read = await readGuestFundingSnapshot(deps, {
      conversation: seeded.conversation,
      now: NOW,
    });
    const served = read._unsafeUnwrap();
    const scopes = [
      {
        scopeId: memberBudgetScopeId(seeded.conversation.memberId),
        remainingNanoUsd: LINK_ALLOWANCE,
      },
      {
        scopeId: conversationBudgetScopeId(seeded.conversation.conversationId),
        remainingNanoUsd: 4_000_000_000n,
      },
    ];
    const refused = await admitRun(deps, {
      walletId: seeded.ownerWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd + 1n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(refused._unsafeUnwrap()).toEqual({ admitted: false, reason: 'budget-exceeded' });
    const admitted = await admitRun(deps, {
      walletId: seeded.ownerWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);
    await redis.del(
      BILLING_KEYS.scopeHolds.buildKey(memberBudgetScopeId(seeded.conversation.memberId)),
      BILLING_KEYS.scopeHolds.buildKey(
        conversationBudgetScopeId(seeded.conversation.conversationId)
      ),
      BILLING_KEYS.walletHolds.buildKey(seeded.ownerWalletId),
      BILLING_KEYS.walletSnapshot.buildKey(seeded.ownerWalletId)
    );
  });

  it('reports an active member-scope hold as held, so spendable + held is the hold-blind remaining', async () => {
    const seeded = await seedFundedLink();
    const estimate = 300_000_000n;
    const scopeKey = BILLING_KEYS.scopeHolds.buildKey(
      memberBudgetScopeId(seeded.conversation.memberId)
    );
    await redis.hset(scopeKey, { run: `${String(estimate)}:${String(NOW.getTime() + 60_000)}` });
    const read = await readGuestFundingSnapshot(deps, {
      conversation: seeded.conversation,
      now: NOW,
    });
    const served = read._unsafeUnwrap();
    expect(served.spendableNanoUsd + served.heldNanoUsd).toBe(LINK_ALLOWANCE);
    await redis.del(scopeKey);
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const seeded = await seedFundedLink();
    const result = await readGuestFundingSnapshot(
      { redis: deadRedis, db, stores },
      { conversation: seeded.conversation, now: NOW }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('readFundingSnapshot — the self-funded arm', () => {
  it('serves the exact effectiveSpendable minus held sum admission gates with under an active hold', async () => {
    const balance = 2_000_000_000n; // $2
    const estimate = 700_000_000n; // $0.70 hold
    const userId = await createUser();
    const walletId = await seedWallet(userId, balance);
    const admitted = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: estimate,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [],
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);

    const served = await view(userId);
    expect(served.spendableNanoUsd).toBe(spendableFundsNanoUsd(balance, 'paid') - estimate);
    expect(served.heldNanoUsd).toBe(estimate);
    expect(Object.keys(served).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'heldNanoUsd',
      'payer',
      'payerTier',
      'spendableNanoUsd',
    ]);

    // Behavioral pin: the served number IS the admission gate — an estimate of
    // exactly the served spendable admits, one nano more refuses.
    const gateAt = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd + 1n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [],
      now: NOW,
    });
    expect(gateAt._unsafeUnwrap()).toEqual({ admitted: false, reason: 'insufficient-balance' });
    const gateWithin = await admitRun(deps, {
      walletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: [],
      now: NOW,
    });
    expect(gateWithin._unsafeUnwrap().admitted).toBe(true);
  });

  it('prunes expired holds on read and serves the full spendable', async () => {
    const balance = 1_000_000_000n;
    const userId = await createUser();
    const walletId = await seedWallet(userId, balance);
    const holdsKey = BILLING_KEYS.walletHolds.buildKey(walletId);
    await redis.hset(holdsKey, { stale: `400000000:${String(NOW.getTime() - 1)}` });

    const served = await view(userId);
    expect(served.heldNanoUsd).toBe(0n);
    expect(served.spendableNanoUsd).toBe(spendableFundsNanoUsd(balance, 'paid'));
    // The prune deleted the only field, so the hash itself is gone.
    expect(await redis.hgetall(holdsKey)).toBeNull();
  });

  it('serves a negative spendable when holds exceed the cushion instead of clamping', async () => {
    const balance = 100_000_000n;
    const held = 700_000_000n; // past balance + cushion
    const userId = await createUser();
    const walletId = await seedWallet(userId, balance);
    const holdsKey = BILLING_KEYS.walletHolds.buildKey(walletId);
    await redis.hset(holdsKey, { run: `${String(held)}:${String(NOW.getTime() + 60_000)}` });

    const served = await view(userId);
    expect(served.spendableNanoUsd).toBe(spendableFundsNanoUsd(balance, 'paid') - held);
    expect(served.spendableNanoUsd < 0n).toBe(true);
    expect(await redis.exists(BILLING_KEYS.walletSnapshot.buildKey(walletId))).toBe(1);
    await redis.del(holdsKey);
  });

  it('answers not_found for a user without a purchased wallet', async () => {
    const userId = await createUser();
    const result = await readFundingSnapshot(deps, {
      userId,
      conversationFunding: unusedReader,
      now: NOW,
    });
    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const userId = await createUser();
    await seedWallet(userId, 1_000_000_000n);
    const result = await readFundingSnapshot(
      { redis: deadRedis, db, stores },
      { userId, conversationFunding: unusedReader, now: NOW }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('readFundingSnapshot — the free-tier arm (BILLING §Funding, §User Tiers)', () => {
  /** The wallets a free payer holds: an unfunded purchased wallet plus the free one. */
  async function seedFreePayer(purchasedBalanceNanoUsd = 0n): Promise<{
    userId: string;
    freeWalletId: string;
  }> {
    const userId = await createUser();
    await seedWallet(userId, purchasedBalanceNanoUsd);
    const freeWalletId = await seedWallet(userId, 0n, 'free');
    return { userId, freeWalletId };
  }

  /**
   * The budget scopes the chat admission hook emits for a self-funded free-tier
   * turn — resolved through the same call, so a gate pin cannot drift into a
   * re-derivation of the served arithmetic.
   */
  async function allowanceScopes(userId: string, now: Date): Promise<readonly BudgetScope[]> {
    const scopes = await resolveBudgetScopes(stores, db, { now, allowance: { userId } });
    return scopes._unsafeUnwrap();
  }

  async function viewAt(userId: string, now: Date): Promise<FundingSnapshot> {
    const result = await readFundingSnapshot(deps, {
      userId,
      conversationFunding: unusedReader,
      now,
    });
    return result._unsafeUnwrap();
  }

  it("serves the day's remaining allowance as a free payer's spendable", async () => {
    const { userId } = await seedFreePayer();

    const served = await view(userId);
    expect(served.payerTier).toBe('free');
    expect(served.spendableNanoUsd).toBe(DAILY_ALLOWANCE_NANO_USD);
  });

  it("subtracts the day's spend from the served allowance", async () => {
    const { userId } = await seedFreePayer();
    await db
      .insert(allowanceSpending)
      .values({ userId, day: utcDayKey(NOW), spentNanoUsd: 30_000_000n });

    const served = await view(userId);
    expect(served.spendableNanoUsd).toBe(DAILY_ALLOWANCE_NANO_USD - 30_000_000n);
    expect(served.heldNanoUsd).toBe(0n);
  });

  it("reports an allowance-scope hold as held, so spendable + held is the day's remaining", async () => {
    const estimate = 20_000_000n;
    const { userId, freeWalletId } = await seedFreePayer();
    const scopes = await allowanceScopes(userId, NOW);
    const admitted = await admitRun(deps, {
      walletId: freeWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: estimate,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);

    const served = await view(userId);
    expect(served.heldNanoUsd).toBe(estimate);
    expect(served.spendableNanoUsd + served.heldNanoUsd).toBe(DAILY_ALLOWANCE_NANO_USD);
    await redis.del(BILLING_KEYS.scopeHolds.buildKey(soleScopeId(scopes)));
  });

  it('serves the figure admission gates a free-tier turn on', async () => {
    const { userId, freeWalletId } = await seedFreePayer();
    await db
      .insert(allowanceSpending)
      .values({ userId, day: utcDayKey(NOW), spentNanoUsd: 10_000_000n });
    const served = await view(userId);
    const scopes = await allowanceScopes(userId, NOW);

    const refused = await admitRun(deps, {
      walletId: freeWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd + 1n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(refused._unsafeUnwrap()).toEqual({ admitted: false, reason: 'budget-exceeded' });
    const admitted = await admitRun(deps, {
      walletId: freeWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);
    await redis.del(
      BILLING_KEYS.scopeHolds.buildKey(soleScopeId(scopes)),
      BILLING_KEYS.walletHolds.buildKey(freeWalletId),
      BILLING_KEYS.walletSnapshot.buildKey(freeWalletId)
    );
  });

  it('serves an overdrawn purchased wallet the allowance figure admission gates its turn on', async () => {
    // A purchased balance at or below zero cannot fund a turn, so the send path
    // draws the free wallet and the daily allowance is the whole gate.
    const { userId, freeWalletId } = await seedFreePayer(-600_000_000n);
    const served = await view(userId);
    expect(served.payerTier).toBe('free');
    expect(served.spendableNanoUsd).toBe(DAILY_ALLOWANCE_NANO_USD);
    const scopes = await allowanceScopes(userId, NOW);

    const refused = await admitRun(deps, {
      walletId: freeWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd + 1n,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(refused._unsafeUnwrap()).toEqual({ admitted: false, reason: 'budget-exceeded' });
    const admitted = await admitRun(deps, {
      walletId: freeWalletId,
      holdId: crypto.randomUUID(),
      estimateNanoUsd: served.spendableNanoUsd,
      deadlineSeconds: 300,
      concurrentRunCap: RUN_CAP,
      budgets: scopes,
      now: NOW,
    });
    expect(admitted._unsafeUnwrap().admitted).toBe(true);
    await redis.del(
      BILLING_KEYS.scopeHolds.buildKey(soleScopeId(scopes)),
      BILLING_KEYS.walletHolds.buildKey(freeWalletId),
      BILLING_KEYS.walletSnapshot.buildKey(freeWalletId)
    );
  });

  it('fails closed with a typed unavailable error when Redis is down', async () => {
    const { userId } = await seedFreePayer();
    const result = await readFundingSnapshot(
      { redis: deadRedis, db, stores },
      { userId, conversationFunding: unusedReader, now: NOW }
    );
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('serves the next UTC day a full allowance, writing nothing to reset it', async () => {
    const { userId } = await seedFreePayer();
    await db
      .insert(allowanceSpending)
      .values({ userId, day: utcDayKey(NOW), spentNanoUsd: DAILY_ALLOWANCE_NANO_USD });
    const exhausted = await view(userId);
    expect(exhausted.spendableNanoUsd).toBe(0n);

    const served = await viewAt(userId, NEXT_DAY);
    expect(served.spendableNanoUsd).toBe(DAILY_ALLOWANCE_NANO_USD);
    // No row exists for the new day and the exhausted one is untouched: the day
    // key alone moves the figure, so nothing has to run at midnight.
    const rows = await db
      .select({ day: allowanceSpending.day, spentNanoUsd: allowanceSpending.spentNanoUsd })
      .from(allowanceSpending)
      .where(eq(allowanceSpending.userId, userId));
    expect(rows).toEqual([{ day: utcDayKey(NOW), spentNanoUsd: DAILY_ALLOWANCE_NANO_USD }]);
  });
});
