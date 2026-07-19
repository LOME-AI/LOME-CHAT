import { afterAll, describe, expect, it } from 'vitest';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  idempotencyKeys,
  ledgerEntries,
  messages,
  usageRecords,
  users,
  wallets,
} from '@hushbox/db';
import { createFencedSettlementHook, keyRowCompletion } from '../../workflows/index.js';
import {
  applyMarkup,
  createBillingStores,
  STORAGE_COST_PER_CHARACTER_NANO,
} from '../../billing/index.js';
import { claimKeyRow, failKeyRow } from '../../../lib/idempotency/index.js';
import { okAsync } from '../../../lib/result/index.js';
import { createChatStores } from '../adapters/stores.js';
import { CHAT_TURN_ROUTE } from './constants.js';
import { createChatSettlementCommit } from './settlement.js';
import type { EpochPublicKeyReader } from './settlement.js';
import type { SettlementRequest } from '@hushbox/shared';
import type { Database } from '@hushbox/db';

/**
 * The settlement crash-injection fuzz suite (audit F-03). The money invariant —
 * exactly-once + saved ⟺ billed — rests on the whole settlement (content
 * persistence, every charge, the double-entry legs, and the idempotency-key
 * flip) committing in ONE transaction: a crash at any statement boundary before
 * COMMIT must leave zero committed rows and a still-claimable key row.
 *
 * A single deterministic crash point proves almost nothing about the
 * interleaving space, so this suite injects a crash at EVERY statement boundary
 * inside the real settlement transaction and, for each, asserts the invariant
 * across the retry-claim and user-cancel interleavings. It drives the REAL
 * settlement path (`createFencedSettlementHook` → `runSettlement` →
 * `createChatSettlementCommit`) and the REAL idempotency-key referee — nothing
 * internal is mocked. The only injected seam is a transaction proxy that counts
 * each executed statement and throws after the chosen one, modelling a crash
 * that killed the executor mid-settlement.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the settlement crash-injection fuzz suite');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([9, 9, 9]);
const NOW = new Date('2026-07-05T12:00:00Z');
const MODEL_ID = 'chat-fuzz/model';
const PROVIDER_NAME = 'chat-fuzz-provider';
const PROMPT = 'ask:hello world';
const ANSWER = 'echo:hello world';
/** The additive (never-marked-up) storage fee for the prompt + this response. */
const PROMPT_ANSWER_STORAGE =
  BigInt(PROMPT.length + ANSWER.length) * STORAGE_COST_PER_CHARACTER_NANO;

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

// --- Deterministic seeded PRNG (mulberry32) ----------------------------------
// Inlined rather than imported: `packages/shared/src/__tests__/seeded-prng.ts`
// is not exported across package boundaries. The repo bans unseeded randomness
// in specs, so the seed is fixed for deterministic CI and logged on failure.

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Random non-negative bigint with up to `bits` random bits. */
function bigIntOfBits(rng: Rng, bits: number): bigint {
  let value = 0n;
  for (let remaining = bits; remaining > 0; remaining -= 32) {
    const chunkBits = Math.min(remaining, 32);
    const chunk = Math.floor(rng() * 2 ** chunkBits);
    value = (value << BigInt(chunkBits)) | BigInt(chunk);
  }
  return value;
}

/**
 * The fuzzer's seed. Fixed for deterministic CI; override via `HB_FUZZ_SEED` to
 * reproduce a logged failure or explore a different slice of the space. This is
 * a test-reproduction knob, NOT app runtime config — the `env.config` registry
 * governs the latter, never test seeds.
 */
const DEFAULT_SEED = 0x5e_ed_f0_0d;
const seedOverride = process.env['HB_FUZZ_SEED'];
const SEED = seedOverride === undefined ? DEFAULT_SEED : Number.parseInt(seedOverride, 10);

// --- Statement-boundary crash injection --------------------------------------
// A crash is modelled by throwing AFTER a statement executed inside the open
// transaction (before the transaction's COMMIT), so the whole settlement rolls
// back exactly as it would when a deploy or panic kills the executor mid-run.

type UnknownFunction = (...args: readonly unknown[]) => unknown;

/** Called once per executed statement, 1-indexed. Throwing crashes that statement. */
type StatementProbe = (index: number) => void;

class CrashInjected extends Error {
  constructor(readonly statementIndex: number) {
    super(`crash-injection: settlement crashed after statement ${String(statementIndex)}`);
    this.name = 'CrashInjected';
  }
}

/**
 * Wraps a Drizzle query builder (or the transaction handle) so each awaited
 * statement runs the real SQL, then invokes the probe. Chained builder methods
 * re-wrap their object result, so the terminal `.then` (the execution point) is
 * always intercepted exactly once per statement.
 */
function instrumentBuilder(
  builder: object,
  state: { index: number },
  probe: StatementProbe
): object {
  let executed = false;
  return new Proxy(builder, {
    get(target, property): unknown {
      if (property === 'then') {
        const originalThen: unknown = Reflect.get(target, 'then', target);
        if (typeof originalThen !== 'function') return undefined;
        const thenFunction = originalThen as UnknownFunction;
        return (
          onFulfilled?: UnknownFunction | null,
          onRejected?: UnknownFunction | null
        ): PromiseLike<unknown> => {
          const execute = async (): Promise<unknown> => {
            const value = await new Promise<unknown>((resolve, reject) => {
              thenFunction.call(target, resolve as UnknownFunction, reject as UnknownFunction);
            });
            // Count only on first execution of this builder; a settlement never
            // awaits the same builder twice, but the guard keeps the index honest.
            if (!executed) {
              executed = true;
              state.index += 1;
              probe(state.index);
            }
            return value;
          };
          // Implementing the PromiseLike contract: `then` must forward the
          // caller's callbacks, which `await` cannot express.
          // eslint-disable-next-line promise/prefer-await-to-then -- thenable proxy plumbing
          return execute().then(
            onFulfilled as ((v: unknown) => unknown) | undefined,
            onRejected as ((r: unknown) => unknown) | undefined
          );
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value === 'function') {
        const function_ = value as UnknownFunction;
        return (...args: unknown[]): unknown => {
          // `this` is the REAL builder (private-field access stays valid); only
          // the returned value is proxied. Drizzle builds a chain of non-thenable
          // intermediates (`insert(t)` → `.values()` → `.returning()`), so every
          // object result must stay wrapped until the terminal `.then` executes.
          const result = function_.apply(target, args);
          return typeof result === 'object' && result !== null
            ? instrumentBuilder(result, state, probe)
            : result;
        };
      }
      return value;
    },
  });
}

/**
 * A `db` facade whose `transaction` wraps the interactive transaction handle so
 * every statement inside the settlement runs the probe. `runSettlement` calls
 * `db.transaction(...)`, so this instruments the entire fenced settlement — the
 * content persistence, the charges, and the key-row flip alike.
 */
function instrumentedDb(probe: StatementProbe): Database {
  const state = { index: 0 };
  return new Proxy(db, {
    get(target, property): unknown {
      if (property === 'transaction') {
        const realTransaction: unknown = Reflect.get(target, 'transaction', target);
        /* v8 ignore next -- the transaction handle is always a function; guards the narrowing */
        if (typeof realTransaction !== 'function') return realTransaction;
        const transactionFunction = realTransaction as UnknownFunction;
        return (callback: (tx: object) => unknown, ...rest: unknown[]): unknown =>
          transactionFunction.call(
            target,
            (tx: object) => callback(instrumentBuilder(tx, state, probe)),
            ...rest
          );
      }
      return Reflect.get(target, property, target);
    },
  });
}

function crashingDb(crashAfter: number): Database {
  return instrumentedDb((index) => {
    if (index === crashAfter) throw new CrashInjected(index);
  });
}

// --- Fixture + settlement scaffolding ----------------------------------------

interface Fixture {
  readonly userId: string;
  readonly walletId: string;
  readonly conversationId: string;
}

async function insertTestUser(): Promise<string> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const rows = await db
    .insert(users)
    .values({
      email: `${suffix}@chat-fuzz.test`,
      username: `cf${suffix}`,
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

async function seedFixture(): Promise<Fixture> {
  const userId = await insertTestUser();
  const walletRows = await db
    .insert(wallets)
    .values({ userId, type: 'purchased', balanceNanoUsd: 10_000_000n })
    .returning({ id: wallets.id });
  const walletId = walletRows[0]?.id;
  if (walletId === undefined) throw new Error('wallet seed failed');

  const conversationRows = await db
    .insert(conversations)
    .values({ userId, title: BYTES })
    .returning({ id: conversations.id });
  const conversationId = conversationRows[0]?.id;
  if (conversationId === undefined) throw new Error('conversation seed failed');
  createdConversationIds.push(conversationId);

  const keyPair = generateEpochKeyPair();
  const epochRows = await db
    .insert(epochs)
    .values({
      conversationId,
      epochNumber: 1,
      epochPublicKey: keyPair.publicKey,
      confirmationHash: BYTES,
    })
    .returning({ id: epochs.id });
  const epochId = epochRows[0]?.id;
  if (epochId === undefined) throw new Error('epoch seed failed');
  // The member-keyed epoch-at-persist gate verifies the sender's key against the
  // authoritative wrap-set; the initiator (users.publicKey === BYTES) is a member.
  await db
    .insert(epochMembers)
    .values({ epochId, memberPublicKey: BYTES, wrap: BYTES, visibleFromEpoch: 1 });
  await db.insert(conversationMembers).values({ conversationId, userId, visibleFromEpoch: 1 });

  return { userId, walletId, conversationId };
}

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

interface Fence {
  readonly id: string;
  readonly executorId: string;
  readonly claims: number;
}

async function claimFence(userId: string, runKey: string, runId: string): Promise<Fence> {
  const executorId = crypto.randomUUID();
  const claimed = await claimKeyRow(db, {
    scope: { userId, route: CHAT_TURN_ROUTE, key: runKey },
    kind: 'run',
    bodyHash: 'body-hash',
    executorId,
    leaseSeconds: 90,
    runId,
  });
  const claim = claimed._unsafeUnwrap();
  if (claim.outcome !== 'executor') throw new Error('expected a fresh executor claim');
  return { id: claim.row.id, executorId, claims: claim.row.claims };
}

function requestWithCost(runKey: string, baseCost: bigint): SettlementRequest {
  return {
    runKey,
    outputs: { answer: { kind: 'text', text: ANSWER } },
    charges: [
      {
        key: 'answer',
        modelId: MODEL_ID,
        providerName: PROVIDER_NAME,
        modality: 'text',
        generationId: 'gen-1',
        baseCostNanoUsd: baseCost,
        isEstimated: false,
      },
    ],
  };
}

function commitFor(
  fixture: Fixture,
  runId: string,
  userMessage: { readonly id: string; readonly content: string }
) {
  return createChatSettlementCommit({
    identity: {
      conversationId: fixture.conversationId,
      epochNumber: 1,
      walletId: fixture.walletId,
      userId: fixture.userId,
      runId,
      userMessage,
    },
    stores: createChatStores(),
    billingStores: createBillingStores(),
    ownerFunded: okAsync(false),
    readEpochPublicKey,
    now: () => NOW,
    newId: () => crypto.randomUUID(),
  });
}

async function messagesInOrder(conversationId: string) {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.sequenceNumber));
}

async function keyRowStatus(id: string): Promise<string> {
  const rows = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.id, id));
  const row = rows[0];
  if (row === undefined) throw new Error('key row vanished');
  return row.status;
}

async function usageForRun(runId: string) {
  return db.select().from(usageRecords).where(eq(usageRecords.runId, runId));
}

// --- Invariant assertions ----------------------------------------------------

/** saved ⟺ billed after a rollback: nothing persisted, nothing billed. */
async function assertNothingPersisted(fixture: Fixture, runId: string): Promise<void> {
  expect(await messagesInOrder(fixture.conversationId)).toHaveLength(0);
  expect(await usageForRun(runId)).toHaveLength(0);
}

/** exactly-once + display == debit after a successful settlement. */
async function assertSettledExactlyOnce(
  fixture: Fixture,
  runId: string,
  baseCost: bigint
): Promise<void> {
  const rows = await messagesInOrder(fixture.conversationId);
  expect(rows).toHaveLength(2);

  const usage = await usageForRun(runId);
  expect(usage).toHaveLength(1);
  const record = usage[0];
  if (record === undefined) throw new Error('expected exactly one usage record');
  const expectedCost = applyMarkup(baseCost) + PROMPT_ANSWER_STORAGE;
  expect(record.costNanoUsd).toBe(expectedCost);

  // Display equals debit: the persisted assistant content mirrors the charge.
  const assistant = rows[1];
  if (assistant === undefined) throw new Error('expected an assistant message');
  const content = await db
    .select()
    .from(contentItems)
    .where(eq(contentItems.messageId, assistant.id));
  const assistantContent = content[0];
  if (assistantContent === undefined) throw new Error('expected assistant content');
  expect(assistantContent.costNanoUsd).toBe(expectedCost);

  // Double-entry legs sum to zero — a balanced, exactly-once charge.
  const legs = await db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.usageRecordId, record.id));
  expect(legs).toHaveLength(2);
  expect(legs.reduce((sum, leg) => sum + leg.amountNanoUsd, 0n)).toBe(0n);
}

// --- Interleavings -----------------------------------------------------------

interface CrashedRun {
  readonly fixture: Fixture;
  readonly fence: Fence;
  readonly runId: string;
  readonly userMessageId: string;
  readonly request: SettlementRequest;
  readonly baseCost: bigint;
}

/**
 * Drives a full settlement whose transaction crashes after `crashAfter`
 * statements, then asserts saved ⟺ billed: the whole transaction rolled back
 * (no message, no content, no usage) and the key row is still claimable.
 */
async function crashSettlementAt(crashAfter: number, baseCost: bigint): Promise<CrashedRun> {
  const fixture = await seedFixture();
  const runKey = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const fence = await claimFence(fixture.userId, runKey, runId);
  const userMessageId = crypto.randomUUID();
  const request = requestWithCost(runKey, baseCost);

  const hook = createFencedSettlementHook({
    db: crashingDb(crashAfter),
    fence,
    complete: keyRowCompletion({ runId }),
    commit: commitFor(fixture, runId, { id: userMessageId, content: PROMPT }),
  });
  await expect(hook(request)).rejects.toThrow();

  await assertNothingPersisted(fixture, runId);
  expect(await keyRowStatus(fence.id)).toBe('claimed');
  return { fixture, fence, runId, userMessageId, request, baseCost };
}

/** retry-claim interleaving: the same client retries and settles exactly-once. */
async function assertRetryInterleaving(crashAfter: number, baseCost: bigint): Promise<void> {
  const crashed = await crashSettlementAt(crashAfter, baseCost);
  const retry = createFencedSettlementHook({
    db,
    fence: crashed.fence,
    complete: keyRowCompletion({ runId: crashed.runId }),
    commit: commitFor(crashed.fixture, crashed.runId, {
      id: crashed.userMessageId,
      content: PROMPT,
    }),
  });
  await retry(crashed.request);
  await assertSettledExactlyOnce(crashed.fixture, crashed.runId, baseCost);
  expect(await keyRowStatus(crashed.fence.id)).toBe('succeeded');
}

/**
 * user-cancel interleaving: after the crash the user cancels. The fenced flip to
 * `failed` succeeds, and because the crash rolled back its whole transaction
 * there is no partial to bill — saved ⟺ billed holds as nothing ⟺ nothing.
 */
async function assertCancelInterleaving(crashAfter: number, baseCost: bigint): Promise<void> {
  const crashed = await crashSettlementAt(crashAfter, baseCost);
  const outcome = await failKeyRow(db, crashed.fence).match(
    (result) => result,
    () => {
      throw new Error('cancel: failKeyRow store unavailable');
    }
  );
  expect(outcome).toBe('flipped');
  expect(await keyRowStatus(crashed.fence.id)).toBe('failed');
  await assertNothingPersisted(crashed.fixture, crashed.runId);
}

/** Counts the statements a full, uncrashed settlement executes (the boundary count). */
async function countSettlementStatements(): Promise<number> {
  const fixture = await seedFixture();
  const runKey = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const fence = await claimFence(fixture.userId, runKey, runId);
  let total = 0;
  const hook = createFencedSettlementHook({
    db: instrumentedDb((index) => {
      total = index;
    }),
    fence,
    complete: keyRowCompletion({ runId }),
    commit: commitFor(fixture, runId, { id: crypto.randomUUID(), content: PROMPT }),
  });
  await hook(requestWithCost(runKey, 1000n));
  return total;
}

const INTERLEAVINGS = ['retry', 'cancel'] as const;
type Interleaving = (typeof INTERLEAVINGS)[number];

/**
 * Force both interleavings at least once (crash-points 1 and 2), then let the
 * seed choose — so the suite provably exercises retry-claim AND cancel over the
 * crash-point space, reproducibly under a fixed seed.
 */
function chooseInterleaving(crashAfter: number, rng: Rng): Interleaving {
  if (crashAfter === 1) return 'retry';
  if (crashAfter === 2) return 'cancel';
  return INTERLEAVINGS[Math.floor(rng() * INTERLEAVINGS.length)] ?? 'retry';
}

/** Runs one crash-point across its chosen interleaving; logs the seed on failure. */
async function runCrashPoint(
  crashAfter: number,
  statementCount: number,
  rng: Rng
): Promise<Interleaving> {
  const interleaving = chooseInterleaving(crashAfter, rng);
  const baseCost = 1n + bigIntOfBits(rng, 20);
  try {
    if (interleaving === 'cancel') await assertCancelInterleaving(crashAfter, baseCost);
    else await assertRetryInterleaving(crashAfter, baseCost);
    return interleaving;
  } catch (error) {
    console.error(
      `settlement crash-injection fuzz FAILED — reproduce with HB_FUZZ_SEED=${String(SEED)}: crashAfter=${String(crashAfter)}/${String(statementCount)}, interleaving=${interleaving}, baseCost=${baseCost.toString()}`
    );
    throw error;
  }
}

describe('settlement crash-injection fuzz (exactly-once + saved ⟺ billed)', () => {
  it('crashes at every statement boundary of the settlement transaction; retry-claim and cancel each preserve the money invariant', async () => {
    const rng = mulberry32(SEED);
    const statementCount = await countSettlementStatements();
    // A single-model fresh-send turn touches many statements (the persisted user
    // + assistant tree, the double-entry legs, the run-conversation stamp, and
    // the fence flip). A suspiciously low count means the harness stopped
    // instrumenting the real path — fail loudly rather than under-cover.
    expect(statementCount).toBeGreaterThanOrEqual(8);
    console.log(
      `settlement crash-injection fuzz: seed=${String(SEED)}, ${String(statementCount)} statement boundaries`
    );

    const ran = new Set<Interleaving>();
    for (let crashAfter = 1; crashAfter <= statementCount; crashAfter += 1) {
      ran.add(await runCrashPoint(crashAfter, statementCount, rng));
    }

    // Both interleavings must have run for the invariant to be proven over the space.
    expect(ran.has('retry')).toBe(true);
    expect(ran.has('cancel')).toBe(true);
  }, 180_000);
});
