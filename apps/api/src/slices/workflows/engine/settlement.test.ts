import { describe, expect, it } from 'vitest';
import { applyMarkup } from '@hushbox/shared';
import { runSettlement } from '../../../lib/idempotency/index.js';
import {
  SettlementCompletionError,
  SettlementFenceLost,
  anchorChargeKey,
  createChargingCommit,
  createFencedSettlementHook,
  keyRowCompletion,
} from './settlement.js';
import type { SettlementCharge, SettlementRequest } from '@hushbox/shared';
import type { Database } from '@hushbox/db';
import type { KeyRowFence, SettlementTx } from '../../../lib/idempotency/index.js';
import type {
  BillingStores,
  LlmCompletionInput,
  SpendingUpsert,
  UsageRecordInput,
} from '../../billing/index.js';
import type { ChargeContext, KeyRowCompletion, SettlementCommit } from './settlement.js';

/**
 * In-memory settlement world modeling the transactional invariants the real
 * Postgres enforces: `db.transaction` snapshots and commits-or-discards
 * atomically; the usage records enforce the unique charge key; the key-row
 * fence lives in the same world so its flip commits with the charges.
 */
interface Leg {
  readonly transactionId: string;
  readonly amountNanoUsd: bigint;
}

interface World {
  wallet: { id: string; type: 'purchased'; balanceNanoUsd: bigint; ledgerSeq: bigint };
  usage: Map<string, string>;
  legs: Leg[];
  keyRow: { status: 'claimed' | 'succeeded'; claimedBy: string; claims: number };
}

function makeWorld(): World {
  return {
    wallet: { id: 'w1', type: 'purchased', balanceNanoUsd: 1000n, ledgerSeq: 0n },
    usage: new Map(),
    legs: [],
    keyRow: { status: 'claimed', claimedBy: 'exec-A', claims: 1 },
  };
}

function cloneWorld(world: World): World {
  return {
    wallet: { ...world.wallet },
    usage: new Map(world.usage),
    legs: [...world.legs],
    keyRow: { ...world.keyRow },
  };
}

function worldOf(tx: SettlementTx): World {
  return (tx as unknown as { __world: World }).__world;
}

function makeDb(world: World): Database {
  return {
    transaction: async (body: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
      const staged = cloneWorld(world);
      const result = await body({ __world: staged });
      Object.assign(world, staged);
      return result;
    },
  } as unknown as Database;
}

interface SpendingCall {
  readonly upsert: SpendingUpsert;
  readonly amountNanoUsd: bigint;
}

/** Captures the per-generation dimension rows chargeWithinTx forwards — the
 * observable proof that chargeInputFor threaded `tokens`/`media` onto the
 * charge input. */
interface DimensionCalls {
  readonly llm: LlmCompletionInput[];
  readonly media: unknown[];
}

function makeStores(
  captured: UsageRecordInput[] = [],
  spending: SpendingCall[] = [],
  dimensions?: DimensionCalls
): BillingStores {
  return {
    lockWalletWithinTx: (tx: SettlementTx) => Promise.resolve(worldOf(tx).wallet),
    insertUsageRecordIfAbsentWithinTx: (tx: SettlementTx, input: UsageRecordInput) => {
      captured.push(input);
      const usage = worldOf(tx).usage;
      const existing = usage.get(input.idempotencyKey);
      if (existing !== undefined) return Promise.resolve({ id: existing, created: false });
      const id = `usage-${String(usage.size)}`;
      usage.set(input.idempotencyKey, id);
      return Promise.resolve({ id, created: true });
    },
    insertLlmCompletionWithinTx: (_tx: SettlementTx, input: LlmCompletionInput) => {
      dimensions?.llm.push(input);
      return Promise.resolve();
    },
    insertMediaGenerationWithinTx: (_tx: SettlementTx, input: unknown) => {
      dimensions?.media.push(input);
      return Promise.resolve();
    },
    insertLedgerLegsWithinTx: (tx: SettlementTx, legs: readonly Leg[]) => {
      worldOf(tx).legs.push(
        ...legs.map((leg) => ({
          transactionId: leg.transactionId,
          amountNanoUsd: leg.amountNanoUsd,
        }))
      );
      return Promise.resolve();
    },
    updateWalletBalanceWithinTx: (
      tx: SettlementTx,
      _walletId: string,
      balanceNanoUsd: bigint,
      ledgerSeq: bigint
    ) => {
      const wallet = worldOf(tx).wallet;
      wallet.balanceNanoUsd = balanceNanoUsd;
      wallet.ledgerSeq = ledgerSeq;
      return Promise.resolve();
    },
    addSpendingWithinTx: (_tx: SettlementTx, upsert: SpendingUpsert, amountNanoUsd: bigint) => {
      spending.push({ upsert, amountNanoUsd });
      return Promise.resolve();
    },
  } as unknown as BillingStores;
}

function makeComplete(): KeyRowCompletion {
  return (tx, fence) => {
    const row = worldOf(tx).keyRow;
    if (
      row.status === 'claimed' &&
      row.claimedBy === fence.executorId &&
      row.claims === fence.claims
    ) {
      row.status = 'succeeded';
      return Promise.resolve('flipped');
    }
    return Promise.resolve('lost');
  };
}

const FENCE_A: KeyRowFence = { id: 'key-1', executorId: 'exec-A', claims: 1 };

/** The run-scoped charge context, defaulting to a persist stand-in for content ids. */
function chargeContext(overrides: Partial<ChargeContext> = {}): ChargeContext {
  return {
    walletId: 'w1',
    payerUserId: 'u1',
    // Solo turn by default: the payer is also the sender.
    sender: { kind: 'user', userId: 'u1' },
    runId: 'run-1',
    now: new Date(0),
    // The chat slice's persist seam: a persist stand-in mints a content item id
    // per key. The real settlement persists content first, in the same transaction.
    contentItemIdFor: () => 'c1',
    ...overrides,
  };
}

/** A per-generation billing record the interpreter would collect and hand over. */
function settlementCharge(
  key: string,
  overrides: Partial<SettlementCharge> = {}
): SettlementCharge {
  return {
    key,
    modelId: 'test/model',
    providerName: 'test-provider',
    modality: 'text',
    billableCostNanoUsd: applyMarkup(100n),
    isEstimated: true,
    ...overrides,
  };
}

function requestWith(charges: readonly SettlementCharge[]): SettlementRequest {
  return { runKey: 'key-1', outputs: {}, charges };
}

function commitFor(captured: UsageRecordInput[] = [], context: ChargeContext = chargeContext()) {
  return createChargingCommit({ stores: makeStores(captured), context });
}

function settle(
  world: World,
  fence: KeyRowFence,
  charges: readonly SettlementCharge[],
  commit: SettlementCommit
): Promise<void> {
  return createFencedSettlementHook({
    db: makeDb(world),
    fence,
    complete: makeComplete(),
    commit,
  })(requestWith(charges));
}

function txnSums(legs: readonly Leg[]): bigint[] {
  const totals = new Map<string, bigint>();
  for (const leg of legs) {
    totals.set(leg.transactionId, (totals.get(leg.transactionId) ?? 0n) + leg.amountNanoUsd);
  }
  return [...totals.values()];
}

describe('createChargingCommit — the record → charge-input mapping', () => {
  it('builds each charge input from the record cost and metadata plus the run context', async () => {
    const world = makeWorld();
    const captured: UsageRecordInput[] = [];
    await settle(
      world,
      FENCE_A,
      [
        settlementCharge('answer', {
          billableCostNanoUsd: applyMarkup(4200n),
          modelId: 'openrouter/x',
          providerName: 'x-labs',
          modality: 'video',
          generationId: 'gen-9',
          isEstimated: false,
        }),
      ],
      commitFor(captured)
    );
    // The usage record chargeWithinTx writes proves the whole mapping is real:
    // the model facts and generation id come verbatim from the record; the
    // charged cost is the record's base (4200n) with the markup applied once;
    // payer and runId ride the context; contentItemId is the persist stand-in; and
    // the idempotency key is derived (runId:key). Nothing is invented.
    expect(captured).toEqual([
      {
        payerUserId: 'u1',
        senderUserId: 'u1',
        runId: 'run-1',
        contentItemId: 'c1',
        modelId: 'openrouter/x',
        providerName: 'x-labs',
        modality: 'video',
        generationId: 'gen-9',
        costNanoUsd: applyMarkup(4200n),
        isEstimated: false,
        idempotencyKey: 'run-1:answer',
      },
    ]);
    // The real base cost, markup applied once, debits the wallet.
    expect(world.wallet.balanceNanoUsd).toBe(1000n - applyMarkup(4200n));
  });

  it('omits the generationId from the charge input when the record carries none', async () => {
    const captured: UsageRecordInput[] = [];
    await settle(makeWorld(), FENCE_A, [settlementCharge('answer')], commitFor(captured));
    expect(captured[0]).not.toHaveProperty('generationId');
  });

  it('threads a member sender onto every charge of the run (payer and sender independent)', async () => {
    const captured: UsageRecordInput[] = [];
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer'), settlementCharge('sibling')],
      commitFor(
        captured,
        chargeContext({
          sender: { kind: 'user', userId: 'member-7' },
          contentItemIdFor: (key) => `content-${key}`,
        })
      )
    );
    // The payer and the sender ride the usage record
    // independently — an owner-funded member turn records both.
    expect(captured.map((input) => input.payerUserId)).toEqual(['u1', 'u1']);
    expect(captured.map((input) => input.senderUserId)).toEqual(['member-7', 'member-7']);
    expect(captured[0]).not.toHaveProperty('senderLinkId');
  });

  it('threads a link-guest sender as the link principal, never a user id', async () => {
    const captured: UsageRecordInput[] = [];
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer')],
      commitFor(captured, chargeContext({ sender: { kind: 'linkGuest', linkId: 'link-3' } }))
    );
    expect(captured[0]?.senderLinkId).toBe('link-3');
    expect(captured[0]).not.toHaveProperty('senderUserId');
  });

  it('pairs each charge to the content item persisted for its key', async () => {
    const captured: UsageRecordInput[] = [];
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer#0'), settlementCharge('answer#1')],
      commitFor(captured, chargeContext({ contentItemIdFor: (key) => `content-${key}` }))
    );
    expect(captured.map((input) => input.contentItemId)).toEqual([
      'content-answer#0',
      'content-answer#1',
    ]);
    expect(captured.map((input) => input.idempotencyKey)).toEqual([
      'run-1:answer#0',
      'run-1:answer#1',
    ]);
  });

  it('skips a charge whose key has no persisted content item, still flipping the fence', async () => {
    const world = makeWorld();
    const captured: UsageRecordInput[] = [];
    // Content was persisted for other keys but not for the charged 'answer' key,
    // so its lookup yields undefined and the charge is skipped.
    const persisted = new Map<string, string>([['other', 'c-other']]);
    await settle(
      world,
      FENCE_A,
      [settlementCharge('answer')],
      commitFor(captured, chargeContext({ contentItemIdFor: (key) => persisted.get(key) }))
    );
    expect(captured).toEqual([]);
    expect(world.usage.size).toBe(0);
    expect(world.legs).toHaveLength(0);
    expect(world.keyRow.status).toBe('succeeded');
  });
});

describe('createChargingCommit — suffixed auxiliary charge anchoring', () => {
  it("anchors a suffixed charge to its base node's content item when it has none of its own", async () => {
    const captured: UsageRecordInput[] = [];
    const persisted = new Map<string, string>([['answer', 'c-answer']]);
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer'), settlementCharge('answer#classifier')],
      commitFor(captured, chargeContext({ contentItemIdFor: (key) => persisted.get(key) }))
    );
    // Both generations bill against the one persisted answer content item —
    // the classifier's usage record keeps the saved ⟺ billed FK — while their
    // idempotency keys stay distinct per generation.
    expect(captured.map((input) => input.contentItemId)).toEqual(['c-answer', 'c-answer']);
    expect(captured.map((input) => input.idempotencyKey)).toEqual([
      'run-1:answer',
      'run-1:answer#classifier',
    ]);
  });

  it('skips a suffixed charge whose base key persisted nothing (saved ⟺ billed)', async () => {
    const world = makeWorld();
    const captured: UsageRecordInput[] = [];
    await settle(
      world,
      FENCE_A,
      [settlementCharge('answer#classifier')],
      commitFor(
        captured,
        chargeContext({ contentItemIdFor: (key) => new Map<string, string>().get(key) })
      )
    );
    expect(captured).toEqual([]);
    expect(world.legs).toHaveLength(0);
  });

  it("lands a turn-level charge on the run's content when the first sibling failed", async () => {
    // The failure shape a turn-level classifier makes reachable: the classifier
    // charges first and persists nothing of its own, sibling A fails (so it
    // produces no charge at all), and sibling B persists. Neither the
    // classifier's own key nor any parent of it names content, so only a
    // run-level anchor keeps its spend billed instead of absorbed.
    const captured: UsageRecordInput[] = [];
    const persisted = new Map<string, string>([['sibling-b', 'c-sibling-b']]);
    await settle(
      makeWorld(),
      FENCE_A,
      [
        settlementCharge('classify', { billableCostNanoUsd: applyMarkup(700n) }),
        settlementCharge('sibling-b', { billableCostNanoUsd: applyMarkup(4200n) }),
      ],
      commitFor(captured, chargeContext({ contentItemIdFor: (key) => persisted.get(key) }))
    );
    expect(
      captured.map((input) => ({
        idempotencyKey: input.idempotencyKey,
        contentItemId: input.contentItemId,
        costNanoUsd: input.costNanoUsd,
      }))
    ).toEqual([
      {
        idempotencyKey: 'run-1:classify',
        contentItemId: 'c-sibling-b',
        costNanoUsd: applyMarkup(700n),
      },
      {
        idempotencyKey: 'run-1:sibling-b',
        contentItemId: 'c-sibling-b',
        costNanoUsd: applyMarkup(4200n),
      },
    ]);
  });

  it("anchors a doubly-suffixed charge to its branch key's content item, never the bare node", async () => {
    const captured: UsageRecordInput[] = [];
    // A smartModel node inside a fanOut body: the branch persists under
    // 'body#0', and its classifier charge is keyed 'body#0#classifier'. The
    // bare 'body' key also has content to prove the anchor strips only the
    // LAST suffix segment.
    const persisted = new Map<string, string>([
      ['body', 'c-body'],
      ['body#0', 'c-branch-0'],
    ]);
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('body#0'), settlementCharge('body#0#classifier')],
      commitFor(captured, chargeContext({ contentItemIdFor: (key) => persisted.get(key) }))
    );
    expect(captured.map((input) => input.contentItemId)).toEqual(['c-branch-0', 'c-branch-0']);
    expect(captured.map((input) => input.idempotencyKey)).toEqual([
      'run-1:body#0',
      'run-1:body#0#classifier',
    ]);
  });

  it('skips a doubly-suffixed charge whose branch key persisted nothing (saved ⟺ billed)', async () => {
    const world = makeWorld();
    const captured: UsageRecordInput[] = [];
    // Even with content under the bare node key, a branch that persisted
    // nothing must not let its auxiliary charge anchor one level too high.
    const persisted = new Map<string, string>([['body', 'c-body']]);
    await settle(
      world,
      FENCE_A,
      [settlementCharge('body#0#classifier')],
      commitFor(captured, chargeContext({ contentItemIdFor: (key) => persisted.get(key) }))
    );
    expect(captured).toEqual([]);
    expect(world.legs).toHaveLength(0);
  });
});

describe('createChargingCommit — member-budget attribution', () => {
  it('threads the run attribution onto every charge so member + conversation spend accrue at settlement', async () => {
    const spending: SpendingCall[] = [];
    const context = chargeContext({
      memberBudget: { memberId: 'mem-1', conversationId: 'conv-1' },
    });
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer')],
      createChargingCommit({ stores: makeStores([], spending), context })
    );
    // The marked-up charge that hit the wallet (markup(100)) accrues cumulatively
    // to the sender's durable member row (no period; the insert-path cap is the
    // zero insert-default `0`, never a permissive conversation cap) AND the durable
    // per-conversation spend row.
    const memberSpend = spending.filter((call) => call.upsert.scope === 'member');
    expect(memberSpend).toEqual([
      {
        upsert: { scope: 'member', memberId: 'mem-1', budgetNanoUsd: 0n },
        amountNanoUsd: applyMarkup(100n),
      },
    ]);
    const conversationSpend = spending.filter((call) => call.upsert.scope === 'conversation');
    expect(conversationSpend).toEqual([
      {
        upsert: { scope: 'conversation', conversationId: 'conv-1' },
        amountNanoUsd: applyMarkup(100n),
      },
    ]);
  });

  it('accrues the SUM of a multi-generation turn under the one member row', async () => {
    const spending: SpendingCall[] = [];
    const context = chargeContext({
      memberBudget: { memberId: 'mem-1', conversationId: 'conv-1' },
      contentItemIdFor: (key) => `content-${key}`,
    });
    await settle(
      makeWorld(),
      FENCE_A,
      [
        settlementCharge('a', { billableCostNanoUsd: applyMarkup(100n) }),
        settlementCharge('b', { billableCostNanoUsd: applyMarkup(200n) }),
      ],
      createChargingCommit({ stores: makeStores([], spending), context })
    );
    // Each sibling charge accrues its OWN marked-up cost to the same member row
    // (the upsert increments), so the period total is the sum — attributed once
    // per generation, never double-counted across siblings.
    const memberSpend = spending.filter((call) => call.upsert.scope === 'member');
    expect(memberSpend.map((call) => call.amountNanoUsd)).toEqual([
      applyMarkup(100n),
      applyMarkup(200n),
    ]);
  });

  it('writes no member or conversation spend for a solo / owner turn (no attribution)', async () => {
    const spending: SpendingCall[] = [];
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer')],
      createChargingCommit({ stores: makeStores([], spending), context: chargeContext() })
    );
    expect(spending.filter((call) => call.upsert.scope === 'member')).toEqual([]);
    expect(spending.filter((call) => call.upsert.scope === 'conversation')).toEqual([]);
  });
});

describe('createChargingCommit — token/media dimension forwarding', () => {
  it('threads both the token and the media dimension from the record onto the charge input', async () => {
    const dimensions: DimensionCalls = { llm: [], media: [] };
    // A text generation carrying tokens and an image generation carrying media,
    // so chargeInputFor's `tokens`/`media` spreads each take their present side
    // and the forwarded dimensions surface on the per-generation rows.
    await settle(
      makeWorld(),
      FENCE_A,
      [
        settlementCharge('answer', {
          modality: 'text',
          tokens: { inputTokens: 7, outputTokens: 11, reasoningTokens: 4, cachedInputTokens: 2 },
        }),
        settlementCharge('picture', {
          modality: 'image',
          media: { imageCount: 2, resolution: '1024x1024' },
        }),
      ],
      createChargingCommit({ stores: makeStores([], [], dimensions), context: chargeContext() })
    );
    expect(dimensions.llm).toEqual([
      {
        usageRecordId: 'usage-0',
        inputTokens: 7,
        outputTokens: 11,
        reasoningTokens: 4,
        cachedInputTokens: 2,
      },
    ]);
    expect(dimensions.media).toEqual([
      { usageRecordId: 'usage-1', modality: 'image', imageCount: 2, resolution: '1024x1024' },
    ]);
  });

  it('forwards the level the generation reasoned at onto its completion row', async () => {
    const dimensions: DimensionCalls = { llm: [], media: [] };
    await settle(
      makeWorld(),
      FENCE_A,
      [
        settlementCharge('answer', {
          modality: 'text',
          tokens: { inputTokens: 7, outputTokens: 11, reasoningTokens: 4, cachedInputTokens: 0 },
          reasoningEffort: 'high',
        }),
      ],
      createChargingCommit({ stores: makeStores([], [], dimensions), context: chargeContext() })
    );
    expect(dimensions.llm[0]?.reasoningEffort).toBe('high');
  });

  it('leaves the level absent when the generation carried no reasoning wire', async () => {
    const dimensions: DimensionCalls = { llm: [], media: [] };
    await settle(
      makeWorld(),
      FENCE_A,
      [
        settlementCharge('answer', {
          modality: 'text',
          tokens: { inputTokens: 7, outputTokens: 11, reasoningTokens: 0, cachedInputTokens: 0 },
        }),
      ],
      createChargingCommit({ stores: makeStores([], [], dimensions), context: chargeContext() })
    );
    expect(dimensions.llm[0]?.reasoningEffort).toBeUndefined();
  });

  it('still writes a completion row for a text record that reported no usage', async () => {
    const dimensions: DimensionCalls = { llm: [], media: [] };
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer')],
      createChargingCommit({ stores: makeStores([], [], dimensions), context: chargeContext() })
    );
    expect(dimensions.llm).toEqual([
      {
        usageRecordId: 'usage-0',
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cachedInputTokens: 0,
      },
    ]);
    expect(dimensions.media).toEqual([]);
  });

  it('writes no dimension row for a modality with neither a token nor a media shape', async () => {
    const dimensions: DimensionCalls = { llm: [], media: [] };
    await settle(
      makeWorld(),
      FENCE_A,
      [settlementCharge('answer', { modality: 'embedding' })],
      createChargingCommit({ stores: makeStores([], [], dimensions), context: chargeContext() })
    );
    expect(dimensions.llm).toEqual([]);
    expect(dimensions.media).toEqual([]);
  });
});

describe('createFencedSettlementHook — the settlement plumbing', () => {
  it('settles once via chargeWithinTx: zero-sum ledger, wallet debited, key flipped', async () => {
    const world = makeWorld();
    const captured: UsageRecordInput[] = [];
    await settle(world, FENCE_A, [settlementCharge('answer')], commitFor(captured));
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
    expect(txnSums(world.legs)).toEqual([0n]);
    // The wallet debit reflects the record's real base cost, markup applied once.
    expect(world.wallet.balanceNanoUsd).toBe(1000n - applyMarkup(100n));
    expect(world.keyRow.status).toBe('succeeded');
    expect(captured[0]?.idempotencyKey).toBe('run-1:answer');
  });

  it('posts every charge input through chargeWithinTx, each zero-sum', async () => {
    const world = makeWorld();
    await settle(world, FENCE_A, [settlementCharge('a'), settlementCharge('b')], commitFor());
    expect(world.usage.size).toBe(2);
    expect(world.legs).toHaveLength(4);
    expect(txnSums(world.legs)).toEqual([0n, 0n]);
  });

  it('charges exactly once when the same settlement replays', async () => {
    const world = makeWorld();
    const commit = commitFor();
    const settleOnce = (): Promise<void> =>
      settle(world, FENCE_A, [settlementCharge('answer')], commit);
    await settleOnce();
    await expect(settleOnce()).rejects.toBeInstanceOf(SettlementFenceLost);
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
    expect(world.wallet.balanceNanoUsd).toBe(1000n - applyMarkup(100n));
  });

  it('settles once under a superseding lease-expired retry; the stale claimant loses the fence', async () => {
    const world = makeWorld();
    world.keyRow = { status: 'claimed', claimedBy: 'exec-B', claims: 2 };
    await expect(
      settle(world, FENCE_A, [settlementCharge('answer')], commitFor())
    ).rejects.toBeInstanceOf(SettlementFenceLost);
    expect(world.legs).toHaveLength(0);
    await settle(
      world,
      { id: 'key-1', executorId: 'exec-B', claims: 2 },
      [settlementCharge('answer')],
      commitFor()
    );
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
    expect(txnSums(world.legs)).toEqual([0n]);
  });

  it('rolls back a crash between charging and the fence flip; a clean retry charges once', async () => {
    const world = makeWorld();
    const crashing: SettlementCommit = async (tx, request) => {
      await commitFor()(tx, request);
      throw new Error('deploy killed the run');
    };
    await expect(settle(world, FENCE_A, [settlementCharge('answer')], crashing)).rejects.toThrow(
      'deploy killed the run'
    );
    expect(world.legs).toHaveLength(0);
    expect(world.keyRow.status).toBe('claimed');
    await settle(world, FENCE_A, [settlementCharge('answer')], commitFor());
    expect(world.usage.size).toBe(1);
    expect(world.legs).toHaveLength(2);
  });

  it('commits nothing when the run was cancelled out from under the settlement', async () => {
    const world = makeWorld();
    world.keyRow = { status: 'claimed', claimedBy: 'cancelled-elsewhere', claims: 1 };
    await expect(
      settle(world, FENCE_A, [settlementCharge('answer')], commitFor())
    ).rejects.toBeInstanceOf(SettlementFenceLost);
    expect(world.legs).toHaveLength(0);
    expect(world.usage.size).toBe(0);
  });
});

/**
 * Runs keyRowCompletion against a fake writer chain — succeedKeyRow only
 * touches update→set→where→returning. The SettlementTx handle is minted by
 * the real `runSettlement` (never cast), so the fence writes on a genuinely
 * branded transaction.
 */
function completeVia(returning: () => Promise<unknown>): Promise<'flipped' | 'lost'> {
  const db = {
    transaction: (body: (tx: unknown) => Promise<'flipped' | 'lost'>) =>
      body({ update: () => ({ set: () => ({ where: () => ({ returning }) }) }) }),
  } as unknown as Database;
  return runSettlement(db, (tx) => keyRowCompletion('response')(tx, FENCE_A));
}

describe('keyRowCompletion — the production fence over succeedKeyRow', () => {
  it('flips when the fenced update matches its row', async () => {
    await expect(completeVia(() => Promise.resolve([{ id: 'key-1' }]))).resolves.toBe('flipped');
  });

  it('reports lost when the fence matches no row (a zombie claimant)', async () => {
    await expect(completeVia(() => Promise.resolve([]))).resolves.toBe('lost');
  });

  it('throws a SettlementCompletionError when the key-row store is unavailable', async () => {
    await expect(
      completeVia(() => Promise.reject(new Error('db unavailable')))
    ).rejects.toBeInstanceOf(SettlementCompletionError);
  });
});

describe('anchorChargeKey — the one anchor rule', () => {
  const persisted = (keys: readonly string[]) => (key: string) => keys.includes(key);

  it('anchors a charge to its own content when it persisted some', () => {
    expect(anchorChargeKey('answer', persisted(['answer']), ['answer'])).toBe('answer');
  });

  it('anchors a suffixed auxiliary charge to the generation it rode on', () => {
    expect(
      anchorChargeKey('answer#classifier', persisted(['answer']), ['answer', 'answer#classifier'])
    ).toBe('answer');
  });

  it("anchors a turn-level charge to the run's first persisted content", () => {
    expect(
      anchorChargeKey('classify', persisted(['sibling-b']), ['classify', 'sibling-a', 'sibling-b'])
    ).toBe('sibling-b');
  });

  it("anchors a suffixed charge whose own generation persisted nothing to the run's content", () => {
    expect(
      anchorChargeKey('sibling-a#classifier', persisted(['sibling-b']), [
        'sibling-a#classifier',
        'sibling-b',
      ])
    ).toBe('sibling-b');
  });

  it('takes the FIRST persisted key in run order when several persisted', () => {
    expect(
      anchorChargeKey('classify', persisted(['sibling-a', 'sibling-b']), [
        'classify',
        'sibling-a',
        'sibling-b',
      ])
    ).toBe('sibling-a');
  });

  it('anchors nothing when the run persisted no content at all', () => {
    expect(anchorChargeKey('classify', persisted([]), ['classify'])).toBeUndefined();
    expect(
      anchorChargeKey('answer#classifier', persisted([]), ['answer#classifier'])
    ).toBeUndefined();
  });
});
