/**
 * The one adapter hook: the single place `apps/web` calls the money layer's
 * producer. Everything these tests assert is about the ADAPTER — what it feeds
 * the producer and how it behaves while its inputs load. The verdicts
 * themselves belong to the producer and are pinned in `packages/shared`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { useTurnOptions, CATALOG_INSTANT_MS } from '@/hooks/billing/use-turn-options';
import type { Model, PromptBasis, UserTier } from '@hushbox/shared';

const mockSpendableCalls: (string | null)[] = [];

const { mockSpendable, mockTierInfo, mockModelsData, mockSelection, mockModality, mockEffort } =
  vi.hoisted(() => ({
    mockSpendable: { current: undefined as unknown },
    mockTierInfo: { current: { tier: 'paid' } as { tier: UserTier } },
    mockModelsData: { current: undefined as unknown },
    mockSelection: { current: [] as { id: string; name: string }[] },
    mockModality: { current: 'text' as string },
    mockEffort: { current: undefined as string | undefined },
    mockOwnWallet: { current: undefined as unknown },
    mockBudgets: { current: { data: undefined, isPending: false } as unknown },
  }));

// Argument-aware, matching the pattern the prompt-budget suite already uses:
// `mockOwnWallet` defaults to `undefined`, meaning both arms share one fixture.
// ONE read now: the conversation names the payer and the server resolves it.
// The argument is recorded so payer-scoping is observable rather than assumed.
vi.mock('@/hooks/billing/use-spendable', () => ({
  useSpendable: (conversationId: string | null) => {
    mockSpendableCalls.push(conversationId);
    return mockSpendable.current;
  },
}));
vi.mock('@/hooks/billing/use-user-tier-info', () => ({
  useUserTierInfo: () => mockTierInfo.current,
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: mockModelsData.current }),
}));
vi.mock('@/hooks/chat/use-web-search', () => ({
  useWebSearch: () => ({ active: false }),
}));
vi.mock('@/stores/model', () => ({
  useModelStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeModality: mockModality.current,
      selections: { [mockModality.current]: mockSelection.current },
    }),
}));
vi.mock('@/hooks/chat/use-reasoning-effort', () => ({
  useReasoningEffort: () => ({ effective: mockEffort.current }),
}));

const BASIS: PromptBasis = {
  systemChars: 400,
  instructionChars: 0,
  historyChars: 200,
  inputChars: 50,
  attachmentBytes: 0,
};

function wireModel(overrides: Partial<Model> & { id: string }): Model {
  return {
    name: overrides.id,
    provider: 'Test',
    modality: 'text',
    contextLength: 128_000,
    maxOutputTokens: 8000,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
    capabilities: [],
    description: 'A test model',
    supportedParameters: [],
    created: 1_700_000_000,
    ...overrides,
  } as Model;
}

function served(
  spendableNanoUsd: string,
  isPending = false,
  payer: 'self' | 'owner' = 'self'
): unknown {
  return {
    data: { spendableNanoUsd, heldNanoUsd: '0', tier: 'paid', payer },
    isPending,
  };
}

beforeEach(() => {
  mockSpendableCalls.length = 0;
  mockSpendable.current = served('100000000000');
  mockTierInfo.current = { tier: 'paid' };
  mockModelsData.current = { models: [wireModel({ id: 'vendor/a' })], premiumIds: new Set() };
  mockSelection.current = [{ id: 'vendor/a', name: 'vendor/a' }];
  mockModality.current = 'text';
  mockEffort.current = undefined;
});

describe('useTurnOptions — the produced pair', () => {
  it('produces both sets for a funded text turn', () => {
    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(false);
    expect(result.current.options?.affordable.sendable).toBe(true);
    expect(result.current.options?.admissible.sendable).toBe(true);
  });

  it('maps the Smart Model sentinel onto the smart slot, never a catalog id', () => {
    // The sentinel is not a catalog row, so passing it through as a pinned
    // model id would mark the turn unpriceable instead of opening the model
    // axis. Two models plus the sentinel is the hardest shape the picker
    // supports, so it is the one worth pinning.
    mockModelsData.current = {
      models: [wireModel({ id: 'vendor/a' }), wireModel({ id: 'vendor/b' })],
      premiumIds: new Set(),
    };
    mockSelection.current = [
      { id: 'vendor/a', name: 'a' },
      { id: SMART_MODEL_ID, name: 'Smart' },
    ];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    const all = result.current.options?.affordable.all ?? [];
    expect(all.some((entry) => entry.modelId === SMART_MODEL_ID)).toBe(false);
    expect(all.find((entry) => entry.modelId === 'vendor/a')?.kind).toBe('pinned');
    expect(all.find((entry) => entry.modelId === 'vendor/b')?.kind).toBe('candidate');
  });
});

describe('useTurnOptions — premium rows are marked, never removed', () => {
  /**
   * A spread of cheap models plus one far dearer. The prices are DISTINCT and
   * ascending so the 75th-percentile threshold lands strictly above the model
   * the turn pins — a flat cheap tier puts the percentile on the tier itself
   * and classifies the whole catalog premium, which would make this fixture
   * prove the opposite of what it claims.
   */
  function catalogWithPremiumTail(): Model[] {
    const cheap = [1000, 2000, 3000, 4000].map((rate) =>
      wireModel({
        id: `vendor/cheap-${String(rate)}`,
        pricing: { inputPerToken: String(rate), outputPerToken: String(rate) },
      })
    );
    return [
      ...cheap,
      wireModel({
        id: 'vendor/premium',
        pricing: { inputPerToken: '900000', outputPerToken: '1800000' },
      }),
    ];
  }

  it('keeps a premium row PRESENT and marked while the composer stays sendable', () => {
    mockTierInfo.current = { tier: 'free' };
    mockSpendable.current = {
      data: { spendableNanoUsd: '50000000', heldNanoUsd: '0', tier: 'free', payer: 'self' },
      isPending: false,
    };
    mockModelsData.current = { models: catalogWithPremiumTail(), premiumIds: new Set() };
    mockSelection.current = [{ id: 'vendor/cheap-1000', name: 'cheap' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    const all = result.current.options?.affordable.all ?? [];
    const premium = all.find((entry) => entry.modelId === 'vendor/premium');

    // Present, not filtered out of the list.
    expect(premium).toBeDefined();
    // Marked, with the reason that names an action this payer can take.
    expect(premium?.availability).toEqual({
      available: false,
      reason: 'premium_requires_credit',
    });
    // And the turn still sends, because a different model answers it.
    expect(result.current.options?.admissible.sendable).toBe(true);
  });

  it('names the account reason, not the credit reason, for a payer with no account', () => {
    // Two premium reasons exist because their ACTIONS differ: sign up versus
    // add credit. Collapsing them would offer a payment path to someone with
    // no account.
    mockTierInfo.current = { tier: 'trial' };
    mockSpendable.current = { data: undefined, isPending: false };
    mockModelsData.current = { models: catalogWithPremiumTail(), premiumIds: new Set() };
    mockSelection.current = [{ id: 'vendor/cheap-1000', name: 'cheap' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: false }));

    const all = result.current.options?.affordable.all ?? [];
    expect(all.find((entry) => entry.modelId === 'vendor/premium')?.availability).toEqual({
      available: false,
      reason: 'premium_requires_account',
    });
  });
});

describe('useTurnOptions — the loading window (the F1 defect class)', () => {
  it('reports pending and produces NO verdict while the funding read is in flight', () => {
    // The served figure is absent mid-flight. Treating that absence as 0n is
    // how every affordable row greys for a render; the adapter must withhold
    // the verdict instead of manufacturing a poor one.
    mockSpendable.current = { data: undefined, isPending: true };

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(true);
    expect(result.current.options).toBeUndefined();
  });

  it('reports pending while the catalog is in flight', () => {
    mockModelsData.current = undefined;

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(true);
    expect(result.current.options).toBeUndefined();
  });

  it('produces a verdict for an unauthenticated payer with no funding endpoint', () => {
    // Trial and guest are refused by that route class by design, so a pending
    // funding read must not gate them — their ceiling is client-side.
    mockSpendable.current = { data: undefined, isPending: false };
    mockTierInfo.current = { tier: 'trial' };

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: false }));

    expect(result.current.isPending).toBe(false);
    expect(result.current.options).toBeDefined();
  });
});

describe('useTurnOptions — the served-value contract for the instant', () => {
  it('reads no clock while rendering — the instant is captured once, at module load', () => {
    // The discriminating input: swapping `CATALOG_INSTANT_MS` for a per-render
    // `Date.now()` makes this spy fire. Asserting the exported constant equals
    // itself would pass under that change, so it is the CALL that is pinned.
    const clock = vi.spyOn(Date, 'now');

    const { rerender } = renderHook(
      (basis: PromptBasis) => useTurnOptions({ basis, isAuthenticated: true }),
      { initialProps: BASIS }
    );
    rerender({ ...BASIS, inputChars: BASIS.inputChars + 25 });
    rerender({ ...BASIS, inputChars: BASIS.inputChars + 50 });

    expect(clock).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it('feeds the producer one instant, so both sets classify premium identically', () => {
    // Two calls a second apart must not be able to disagree about recency.
    // The adapter owns this: it passes ONE snapshot, and the producer uses it
    // for both passes.
    const first = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    vi.setSystemTime(new Date(CATALOG_INSTANT_MS + 60_000));
    const second = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(first.result.current.options?.affordable).toStrictEqual(
      second.result.current.options?.affordable
    );
    vi.useRealTimers();
  });
});

describe('useTurnOptions — the payer the SERVER named', () => {
  /**
   * The client no longer decides who pays. `GET /billing/spendable` takes the
   * conversation, applies §Group Funding 2 server-side, and returns the winning
   * wallet's figures plus `payer` and `tier`. Re-resolving that here was a
   * second authority for a decision the wire already carries — and it
   * disagreed with the server inside the settle-then-release window.
   *
   * The fixture that motivated the old client-side resolution was
   * unreachable: the owner arm only returns when hold-blind headroom is
   * positive, so `{spendable: 0, held: 0, payer: 'owner'}` cannot be served.
   */
  function render() {
    return renderHook(() =>
      useTurnOptions({ basis: BASIS, isAuthenticated: true, conversationId: 'conv-1' })
    );
  }

  it('prices an owner-funded turn from the served owner figures', () => {
    mockSpendable.current = served('100000000000', false, 'owner');

    expect(render().result.current.options?.affordable.all[0]?.availability).toEqual({
      available: true,
    });
  });

  it('greys when the served figure — whoever it describes — cannot fund the floor', () => {
    // Labelled `self`: the owner arm is only returned when hold-blind headroom
    // is positive, so a zero figure with nothing held cannot describe an owner.
    // The assertion is about the FIGURE, not the label.
    mockSpendable.current = served('0', false, 'self');

    expect(render().result.current.options?.affordable.all[0]?.availability).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('stays hold-blind for greying: a held-out group budget does not grey a row', () => {
    // `affordable` reconstructs `spendable + held`, so a hold cannot grey.
    // This is the one group property that is genuinely the CLIENT's, and it is
    // structural rather than a second resolution.
    mockSpendable.current = {
      data: {
        spendableNanoUsd: '0',
        heldNanoUsd: '100000000000',
        tier: 'paid',
        payer: 'owner',
      },
      isPending: false,
    };

    expect(render().result.current.options?.affordable.all[0]?.availability).toEqual({
      available: true,
    });
  });

  it('asks the endpoint for the conversation that names the payer', () => {
    mockSpendable.current = served('100000000000', false, 'owner');
    render();
    // A conversation-blind read would serve the SENDER's wallet and tier.
    expect(mockSpendableCalls).toContain('conv-1');
  });
});

describe('the send gate refuses exactly the admissible ⊂ affordable difference', () => {
  /**
   * THE case the two-set design exists for. Both sets are produced from one
   * call; the difference between them is a HOLD, never poverty, so the picker
   * must stay normal while the send is blocked with a wait-for-it reason
   * (BILLING §Notices 9, §Affordability — the four notions).
   */
  it('holds funds out: affordable sendable, admissible not — a strict subset', () => {
    // Effective balance = spendable + held = 0 + 100e9, so the model is
    // affordable; spendable alone is 0, so nothing can START right now.
    mockSpendable.current = {
      data: {
        spendableNanoUsd: '0',
        heldNanoUsd: '100000000000',
        tier: 'paid',
        payer: 'self',
      },
      isPending: false,
    };

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    const options = result.current.options;

    // affordable: the payer CAN call this model — hold-blind.
    expect(options?.affordable.sendable).toBe(true);
    expect(options?.affordable.all[0]?.availability).toEqual({ available: true });

    // admissible: strictly smaller — the turn cannot start this instant.
    expect(options?.admissible.sendable).toBe(false);

    // And the hold is the only difference: no row is greyed for money.
    expect(options?.affordable.all.every((row) => row.availability.available)).toBe(true);
  });

  it('genuine poverty puts the selection outside BOTH sets', () => {
    // The contrast case: nothing held, no funds. `affordable` refuses too, so
    // the picker greys and the reason is money rather than waiting.
    mockSpendable.current = served('0');

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.options?.affordable.sendable).toBe(false);
    expect(result.current.options?.admissible.sendable).toBe(false);
    expect(result.current.options?.affordable.all[0]?.availability).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });
});

describe('a smart-slot-only turn with no contributing model', () => {
  /**
   * DECIDED, not left implicit: when the candidate pool is empty the producer
   * contributes NO turn-level rungs, so the effort strip has nothing to grade
   * and renders Auto alone (Auto is always selectable — it delegates the
   * choice; §Reasoning Effort 5). The per-row lists are unaffected because
   * there are no rows either — this is not the "rows render but the strip is
   * blank" asymmetry the plan asked about, which B3's both-arms amendment
   * already removed: an UNSENDABLE turn that still has a candidate keeps every
   * rung, marked.
   */
  it('yields an empty dimension list rather than an ungraded one', () => {
    mockSelection.current = [{ id: SMART_MODEL_ID, name: 'Smart' }];
    mockModelsData.current = { models: [], premiumIds: new Set() };

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    const options = result.current.options;

    expect(options?.affordable.sendable).toBe(false);
    expect(options?.affordable.turnDimensions).toEqual([]);
    // No rows either — the strip and the list agree because both are empty.
    expect(options?.affordable.all).toEqual([]);
  });

  it('keeps every rung MARKED when a candidate exists but cannot be funded', () => {
    // The contrast that shows the empty case above is about an empty POOL, not
    // about unsendability. Here the turn is equally unsendable, yet the strip
    // is fully populated and greyed — greyed-never-hidden.
    mockSelection.current = [{ id: SMART_MODEL_ID, name: 'Smart' }];
    mockModelsData.current = {
      models: [wireModel({ id: 'vendor/a', reasoning: { supportedEfforts: ['low', 'high'] } })],
      premiumIds: new Set(),
    };
    mockSpendable.current = served('0');

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    const dimension = result.current.options?.affordable.turnDimensions[0];

    expect(result.current.options?.affordable.sendable).toBe(false);
    expect(dimension?.options.length).toBeGreaterThan(0);
    expect(dimension?.options.every((option) => !option.availability.available)).toBe(true);
  });
});

describe('trial and guest — the tiers with no funding endpoint', () => {
  /**
   * §Affordability 8 fixes trial and guest at a $0.01 effective balance. The
   * endpoint is `enabled: isAuthenticated`, so `served` is permanently
   * undefined for them — handing the producer `0n` reads as poverty and refuses
   * the entire unauthenticated funnel, while the server admits those turns on
   * quota.
   */
  it('sends on the fixed per-message ceiling rather than refusing as broke', () => {
    mockSpendable.current = { data: undefined, isPending: false };
    mockTierInfo.current = { tier: 'trial' };
    mockModelsData.current = {
      models: [
        wireModel({
          id: 'vendor/cheap',
          pricing: { inputPerToken: '1000', outputPerToken: '2000' },
        }),
      ],
      premiumIds: new Set(),
    };
    mockSelection.current = [{ id: 'vendor/cheap', name: 'cheap' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: false }));

    expect(result.current.options?.affordable.all[0]?.availability).toEqual({ available: true });
    expect(result.current.options?.admissible.sendable).toBe(true);
  });

  it('applies the same fixed ceiling to a link guest', () => {
    mockSpendable.current = { data: undefined, isPending: false };
    mockTierInfo.current = { tier: 'guest' };
    mockModelsData.current = {
      models: [
        wireModel({
          id: 'vendor/cheap',
          pricing: { inputPerToken: '1000', outputPerToken: '2000' },
        }),
      ],
      premiumIds: new Set(),
    };
    mockSelection.current = [{ id: 'vendor/cheap', name: 'cheap' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: false }));

    expect(result.current.options?.admissible.sendable).toBe(true);
  });
});

describe('priceableFromWire — the fail-closed guards', () => {
  /**
   * Each guard drops a row from the pool rather than defaulting it. The
   * defaults these refuse are not cosmetic: a zero rate prices a turn as FREE,
   * and a missing release date makes every premium-recency test silently
   * false. A dropped row simply is not a candidate.
   */
  function poolIds(models: Model[]): string[] {
    mockModelsData.current = { models, premiumIds: new Set() };
    mockSelection.current = [{ id: SMART_MODEL_ID, name: 'Smart' }];
    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));
    return (result.current.options?.affordable.all ?? []).map((row) => String(row.modelId));
  }

  it('excludes the synthetic Smart Model row — it is the slot, not a model', () => {
    const ids = poolIds([
      wireModel({ id: 'vendor/real' }),
      wireModel({ id: 'smart', isSmartModel: true }),
    ]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with no input rate rather than pricing it at zero', () => {
    const ids = poolIds([
      wireModel({ id: 'vendor/real' }),
      wireModel({ id: 'vendor/no-input', pricing: { outputPerToken: '2000' } }),
    ]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with no output rate', () => {
    const ids = poolIds([
      wireModel({ id: 'vendor/real' }),
      wireModel({ id: 'vendor/no-output', pricing: { inputPerToken: '1000' } }),
    ]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with a non-positive context length', () => {
    const ids = poolIds([
      wireModel({ id: 'vendor/real' }),
      wireModel({ id: 'vendor/no-context', contextLength: 0 }),
    ]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('excludes a row with no release date, so recency cannot silently pass', () => {
    const noCreated = wireModel({ id: 'vendor/undated' });

    // field is optional; this reproduces a row that arrived without it.
    delete (noCreated as { created?: number }).created;

    const ids = poolIds([wireModel({ id: 'vendor/real' }), noCreated]);

    expect(ids).toEqual(['vendor/real']);
  });

  it('keeps a fully-specified row', () => {
    expect(poolIds([wireModel({ id: 'vendor/real' })])).toEqual(['vendor/real']);
  });
});

describe('useTurnOptions — selection edges', () => {
  it('produces no options when nothing can answer the turn', () => {
    // Neither a pinned model nor the smart slot: `Selection` requires at least
    // one answer source, so there is no turn to price rather than an empty one.
    mockSelection.current = [];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    expect(result.current.isPending).toBe(false);
    expect(result.current.options).toBeUndefined();
  });

  it('passes a PINNED effort through to the producer', () => {
    // Auto and undefined both mean "open"; an explicit level is a pin, and the
    // producer grades the turn against it rather than against `e_min`.
    mockEffort.current = 'high';
    mockModelsData.current = {
      models: [wireModel({ id: 'vendor/a', reasoning: { supportedEfforts: ['low', 'high'] } })],
      premiumIds: new Set(),
    };
    mockSelection.current = [{ id: 'vendor/a', name: 'a' }];

    const { result } = renderHook(() => useTurnOptions({ basis: BASIS, isAuthenticated: true }));

    // A pinned effort narrows the turn: the row is graded on `high`, which this
    // model's 8000-token cap cannot fund alongside a minimum answer.
    expect(result.current.options?.affordable.all[0]?.availability).toEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
  });
});
