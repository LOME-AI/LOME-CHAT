import { describe, it, expect, vi } from 'vitest';
import {
  decideFundingSource,
  reserveGroupBudgetWithGuard,
  reservePersonalBudgetWithGuard,
  reserveMediaBilling,
} from './billing-reservation.js';
import type { Context } from 'hono';
import type { AppEnv } from '../types.js';
import type { BuildBillingResult, MemberContext } from '../services/billing/index.js';

interface MockRedisForBilling {
  get: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
}

interface MockBillingContext {
  c: Context<AppEnv>;
  jsonSpy: ReturnType<typeof vi.fn>;
}

function createMockBillingContext(redis: MockRedisForBilling): MockBillingContext {
  const jsonSpy = vi.fn((body: unknown, status?: number) =>
    Response.json(body, {
      status: typeof status === 'number' ? status : 200,
    })
  );
  const c = {
    get: vi.fn((key: string) => {
      if (key === 'redis') return redis;
      return null;
    }),
    env: {
      AI_GATEWAY_API_KEY: 'test-key',
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    } as AppEnv['Bindings'],
    json: jsonSpy,
  } as unknown as Context<AppEnv>;
  return { c, jsonSpy };
}

function makeBillingResult(
  overrides: Partial<BuildBillingResult['input']> = {}
): BuildBillingResult {
  return {
    input: {
      tier: 'paid',
      balanceCents: 100_000,
      freeAllowanceCents: 0,
      isPremiumModel: false,
      estimatedMinimumCostCents: 0,
      ...overrides,
    },
    rawUserBalanceCents: overrides.balanceCents ?? 100_000,
    rawFreeAllowanceCents: overrides.freeAllowanceCents ?? 0,
  };
}

function makeGroupBillingResult(
  overrides: Partial<BuildBillingResult['input']> = {},
  groupBudgetOverrides: Partial<NonNullable<BuildBillingResult['groupBudgetContext']>> = {}
): BuildBillingResult {
  return {
    input: {
      tier: 'paid',
      balanceCents: 100_000,
      freeAllowanceCents: 0,
      isPremiumModel: false,
      estimatedMinimumCostCents: 0,
      group: {
        effectiveCents: 5000,
        ownerTier: 'paid',
        ownerBalanceCents: 50_000,
      },
      ...overrides,
    },
    rawUserBalanceCents: overrides.balanceCents ?? 100_000,
    rawFreeAllowanceCents: overrides.freeAllowanceCents ?? 0,
    groupBudgetContext: {
      conversationBudget: '500.00',
      conversationSpent: '0.00',
      memberBudget: '100.00',
      memberSpent: '0.00',
      ownerBalanceCents: 50_000,
      ...groupBudgetOverrides,
    },
  };
}

const FAKE_DENIAL_RESPONSE = Response.json(
  { code: 'INSUFFICIENT_BALANCE' },
  {
    status: 402,
  }
);

const handleBillingDenial = vi.fn(() => FAKE_DENIAL_RESPONSE);

describe('decideFundingSource', () => {
  it('returns proceed when paid tier has sufficient balance for personal billing', () => {
    const { c } = createMockBillingContext({ get: vi.fn(), eval: vi.fn() });
    const billingResult = makeBillingResult({ balanceCents: 100_000, isPremiumModel: false });

    const result = decideFundingSource({
      c,
      billingResult,
      worstCaseCents: 100,
      clientFundingSource: 'personal_balance',
      handleBillingDenial,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.fundingSource).toBe('personal_balance');
      expect(result.isGroupBilling).toBe(false);
      expect(result.payerTier).toBe('paid');
    }
  });

  it('returns denial when balance insufficient (calls handleBillingDenial)', () => {
    const { c } = createMockBillingContext({ get: vi.fn(), eval: vi.fn() });
    const billingResult = makeBillingResult({ balanceCents: 0 });
    const denialHandler = vi.fn(() => FAKE_DENIAL_RESPONSE);

    const result = decideFundingSource({
      c,
      billingResult,
      worstCaseCents: 5000,
      clientFundingSource: 'personal_balance',
      handleBillingDenial: denialHandler,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response).toBe(FAKE_DENIAL_RESPONSE);
    }
    expect(denialHandler).toHaveBeenCalledOnce();
    expect(denialHandler).toHaveBeenCalledWith(c, 'insufficient_balance', billingResult.input);
  });

  it('returns 409 mismatch when client funding source disagrees with server resolution', () => {
    const { c, jsonSpy } = createMockBillingContext({ get: vi.fn(), eval: vi.fn() });
    const billingResult = makeBillingResult({ balanceCents: 100_000 });

    const result = decideFundingSource({
      c,
      billingResult,
      worstCaseCents: 100,
      // Server will resolve to personal_balance; client claims free_allowance
      clientFundingSource: 'free_allowance',
      handleBillingDenial,
    });

    expect(result.success).toBe(false);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'BILLING_MISMATCH',
        details: { serverFundingSource: 'personal_balance' },
      }),
      409
    );
  });

  it('detects group billing with owner_balance funding when group budget present', () => {
    const { c } = createMockBillingContext({ get: vi.fn(), eval: vi.fn() });
    const billingResult = makeGroupBillingResult();

    const result = decideFundingSource({
      c,
      billingResult,
      worstCaseCents: 100,
      clientFundingSource: 'owner_balance',
      handleBillingDenial,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.fundingSource).toBe('owner_balance');
      expect(result.isGroupBilling).toBe(true);
      expect(result.payerTier).toBe('paid');
    }
  });

  it('mutates billingResult.input.estimatedMinimumCostCents to passed worstCaseCents', () => {
    const { c } = createMockBillingContext({ get: vi.fn(), eval: vi.fn() });
    const billingResult = makeBillingResult({ balanceCents: 100_000 });

    decideFundingSource({
      c,
      billingResult,
      worstCaseCents: 1234,
      clientFundingSource: 'personal_balance',
      handleBillingDenial,
    });

    expect(billingResult.input.estimatedMinimumCostCents).toBe(1234);
  });
});

describe('reservePersonalBudgetWithGuard', () => {
  function createReservationCtx(
    redis: MockRedisForBilling,
    billingResult: BuildBillingResult,
    worstCaseCents = 1000
  ): {
    ctx: Parameters<typeof reservePersonalBudgetWithGuard>[0];
    jsonSpy: ReturnType<typeof vi.fn>;
  } {
    const { c, jsonSpy } = createMockBillingContext(redis);
    const ctx = {
      redis: redis as unknown as Parameters<typeof reservePersonalBudgetWithGuard>[0]['redis'],
      c,
      billingResult,
      worstCaseCents,
      payerTier: 'paid' as const,
    };
    return { ctx, jsonSpy };
  }

  it('happy path: reserves and returns success when balance covers reservation', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      // First eval = reserve (returns new total in cents); subsequent calls
      // would only happen on the rollback path.
      eval: vi.fn().mockResolvedValueOnce(1000),
    };
    const billingResult = makeBillingResult({ balanceCents: 100_000 });
    const { ctx } = createReservationCtx(redis, billingResult, 1000);

    const result = await reservePersonalBudgetWithGuard(ctx, 'user-1', 'personal_balance');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.worstCaseCents).toBe(1000);
      expect(result.billingUserId).toBe('user-1');
    }
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('TOCTOU guard: rolls back when post-reservation balance below cushion', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      // Reservation total exceeds balance by far more than the cushion (50 cents for paid)
      eval: vi
        .fn()
        .mockResolvedValueOnce(200_000) // reserve returns total > balance
        .mockResolvedValueOnce(199_000), // release decrements
    };
    const billingResult = makeBillingResult({ balanceCents: 100_000 });
    const { ctx, jsonSpy } = createReservationCtx(redis, billingResult, 1000);

    const result = await reservePersonalBudgetWithGuard(ctx, 'user-1', 'personal_balance');

    expect(result.success).toBe(false);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BALANCE_RESERVED' }),
      402
    );
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('uses freeAllowanceCents as available when fundingSource is free_allowance', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi.fn().mockResolvedValueOnce(50),
    };
    const billingResult = makeBillingResult({
      tier: 'free',
      balanceCents: 0,
      freeAllowanceCents: 100,
    });
    const { ctx } = createReservationCtx({ ...redis }, billingResult, 50);
    ctx.payerTier = 'free';

    const result = await reservePersonalBudgetWithGuard(ctx, 'user-1', 'free_allowance');

    expect(result.success).toBe(true);
  });

  it('paid tier cushion absorbs small overshoot', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      // Reservation 100_010, balance 100_000 → overshoot 10 cents (within paid 50c cushion)
      eval: vi.fn().mockResolvedValueOnce(100_010),
    };
    const billingResult = makeBillingResult({ balanceCents: 100_000 });
    const { ctx } = createReservationCtx(redis, billingResult, 100_010);

    const result = await reservePersonalBudgetWithGuard(ctx, 'user-1', 'personal_balance');

    expect(result.success).toBe(true);
  });
});

describe('reserveGroupBudgetWithGuard', () => {
  const memberContext: MemberContext = {
    memberId: 'member-1',
    ownerId: 'owner-1',
  };

  function createReservationCtx(
    redis: MockRedisForBilling,
    billingResult: BuildBillingResult,
    worstCaseCents = 1000
  ): {
    ctx: Parameters<typeof reserveGroupBudgetWithGuard>[0];
    jsonSpy: ReturnType<typeof vi.fn>;
  } {
    const { c, jsonSpy } = createMockBillingContext(redis);
    const ctx = {
      redis: redis as unknown as Parameters<typeof reserveGroupBudgetWithGuard>[0]['redis'],
      c,
      billingResult,
      worstCaseCents,
      payerTier: 'paid' as const,
    };
    return { ctx, jsonSpy };
  }

  it('happy path: reserves group budget atomically and returns success', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      // Three calls: member, conversation, payer reservations (each returns the new total)
      eval: vi
        .fn()
        .mockResolvedValueOnce(1000) // member total
        .mockResolvedValueOnce(1000) // conversation total
        .mockResolvedValueOnce(1000), // payer total
    };
    const billingResult = makeGroupBillingResult();
    const { ctx } = createReservationCtx(redis, billingResult, 1000);

    const result = await reserveGroupBudgetWithGuard(ctx, memberContext, 'conv-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.billingUserId).toBe('owner-1');
      expect(result.groupBudget).toBeDefined();
      expect(result.groupBudget?.payerId).toBe('owner-1');
      expect(result.groupBudget?.memberId).toBe('member-1');
      expect(result.groupBudget?.conversationId).toBe('conv-1');
    }
  });

  it('TOCTOU guard: rolls back via releaseGroupBudget when conversation budget exhausted', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      // Reservation returns totals that exceed conversation budget
      eval: vi
        .fn()
        .mockResolvedValueOnce(60_000) // member total exceeds budget by far
        .mockResolvedValueOnce(60_000) // conversation total
        .mockResolvedValueOnce(60_000) // payer total
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0),
    };
    const billingResult = makeGroupBillingResult(
      {},
      {
        conversationBudget: '500.00', // 50_000 cents
        conversationSpent: '0.00',
      }
    );
    const { ctx, jsonSpy } = createReservationCtx(redis, billingResult, 60_000);

    const result = await reserveGroupBudgetWithGuard(ctx, memberContext, 'conv-1');

    expect(result.success).toBe(false);
    expect(jsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BALANCE_RESERVED' }),
      402
    );
    expect(redis.eval).toHaveBeenCalledTimes(6);
  });

  it('throws invariant error when groupBudgetContext missing', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0),
    };
    // Build a result without groupBudgetContext to trigger the invariant
    const billingResult = makeBillingResult({ balanceCents: 100_000 });
    const { ctx } = createReservationCtx(redis, billingResult, 1000);

    await expect(reserveGroupBudgetWithGuard(ctx, memberContext, 'conv-1')).rejects.toThrow(
      /groupBudgetContext required/
    );
  });
});

describe('reserveMediaBilling (orchestrator)', () => {
  it('routes to personal reservation for non-group billing', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi.fn().mockResolvedValueOnce(1000),
    };
    const { c } = createMockBillingContext(redis);
    const billingResult = makeBillingResult({ balanceCents: 100_000 });

    const result = await reserveMediaBilling(
      c,
      {
        billingResult,
        userId: 'user-1',
        worstCaseCents: 1000,
        clientFundingSource: 'personal_balance',
      },
      handleBillingDenial
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.billingUserId).toBe('user-1');
      expect(result.groupBudget).toBeUndefined();
    }
  });

  it('routes to group reservation when isGroupBilling and memberContext+conversationId present', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi
        .fn()
        .mockResolvedValueOnce(1000)
        .mockResolvedValueOnce(1000)
        .mockResolvedValueOnce(1000),
    };
    const { c } = createMockBillingContext(redis);
    const billingResult = makeGroupBillingResult();

    const result = await reserveMediaBilling(
      c,
      {
        billingResult,
        userId: 'user-1',
        worstCaseCents: 1000,
        clientFundingSource: 'owner_balance',
        memberContext: { memberId: 'member-1', ownerId: 'owner-1' },
        conversationId: 'conv-1',
      },
      handleBillingDenial
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.billingUserId).toBe('owner-1');
      expect(result.groupBudget).toBeDefined();
    }
  });

  it('short-circuits on funding source decision denial without touching redis', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi.fn(),
    };
    const { c } = createMockBillingContext(redis);
    const billingResult = makeBillingResult({ balanceCents: 0 });
    const denialHandler = vi.fn(() => FAKE_DENIAL_RESPONSE);

    const result = await reserveMediaBilling(
      c,
      {
        billingResult,
        userId: 'user-1',
        worstCaseCents: 100_000,
        clientFundingSource: 'personal_balance',
      },
      denialHandler
    );

    expect(result.success).toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
    expect(denialHandler).toHaveBeenCalledOnce();
  });

  it('falls back to personal reservation when group context advertised but memberContext missing', async () => {
    // When isGroupBilling resolves true but memberContext/conversationId not supplied,
    // the orchestrator should fall through to personal reservation.
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi.fn().mockResolvedValueOnce(1000),
    };
    const { c } = createMockBillingContext(redis);
    const billingResult = makeGroupBillingResult();

    const result = await reserveMediaBilling(
      c,
      {
        billingResult,
        userId: 'user-1',
        worstCaseCents: 1000,
        clientFundingSource: 'owner_balance',
        // memberContext + conversationId omitted
      },
      handleBillingDenial
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.groupBudget).toBeUndefined();
    }
  });
});

describe('release flow exercised through reservation guards', () => {
  it('rolling back a personal reservation calls release exactly once', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi
        .fn()
        // Reserve: way over balance + cushion → guard fails
        .mockResolvedValueOnce(1_000_000)
        // Release returns a smaller value
        .mockResolvedValueOnce(0),
    };
    const { c } = createMockBillingContext(redis);
    const billingResult = makeBillingResult({ balanceCents: 100_000 });

    const result = await reservePersonalBudgetWithGuard(
      {
        redis: redis as unknown as Parameters<typeof reservePersonalBudgetWithGuard>[0]['redis'],
        c,
        billingResult,
        worstCaseCents: 100_000,
        payerTier: 'paid',
      },
      'user-1',
      'personal_balance'
    );

    expect(result.success).toBe(false);
    // exactly two eval invocations: forward + release. No "double release".
    expect(redis.eval).toHaveBeenCalledTimes(2);
  });

  it('rolling back a group reservation triggers exactly three release decrements', async () => {
    const redis: MockRedisForBilling = {
      get: vi.fn(),
      eval: vi
        .fn()
        .mockResolvedValueOnce(1_000_000)
        .mockResolvedValueOnce(1_000_000)
        .mockResolvedValueOnce(1_000_000)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0),
    };
    const { c } = createMockBillingContext(redis);
    const billingResult = makeGroupBillingResult();

    const result = await reserveGroupBudgetWithGuard(
      {
        redis: redis as unknown as Parameters<typeof reserveGroupBudgetWithGuard>[0]['redis'],
        c,
        billingResult,
        worstCaseCents: 1_000_000,
        payerTier: 'paid',
      },
      { memberId: 'member-1', ownerId: 'owner-1' },
      'conv-1'
    );

    expect(result.success).toBe(false);
    // 3 forward + 3 release = 6
    expect(redis.eval).toHaveBeenCalledTimes(6);
  });
});
